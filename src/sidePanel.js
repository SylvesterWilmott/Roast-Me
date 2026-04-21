"use strict";

/* global chrome */

import ChromeUtils from "./promisify.js";
import ClaudeClient from "./claude.js";
import { buildChatSystemPrompt } from "./prompts.js";
import { marked } from "marked";
import JSZip from "jszip";

marked.setOptions({
  breaks: false,
  gfm: true,
});

/**
 * Returns a localized string from messages.json.
 * @param {string} key - The message key.
 * @param {Array<string>} [subs] - Substitution values for placeholders.
 * @returns {string} The localized message.
 */
function msg(key, subs) {
  return chrome.i18n.getMessage(key, subs) || key;
}

/**
 * Applies i18n data attributes to all elements in the document.
 */
function initI18n() {
  document.querySelectorAll("[data-i18n]").forEach(function (el) {
    el.textContent = msg(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(function (el) {
    el.placeholder = msg(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-title]").forEach(function (el) {
    el.title = msg(el.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-i18n-alt]").forEach(function (el) {
    el.alt = msg(el.dataset.i18nAlt);
  });
  document.querySelectorAll("[data-i18n-data-placeholder]").forEach(function (el) {
    el.setAttribute("data-placeholder", msg(el.dataset.i18nDataPlaceholder));
  });
  var instructionsEl = document.getElementById("api-key-instructions");
  if (instructionsEl) {
    instructionsEl.innerHTML = msg("API_KEY_INSTRUCTIONS");
  }
}

const DEFAULT_TRAITS = {
  sighted: true,
  colorBlindness: "none",
  keyboardOnly: false,
  ageBand: "adult",
  techLiteracy: "medium",
};

const PERSONA_PRESETS = {
  "first-time": {
    name: msg("PERSONA_FIRST_TIME"),
    description: msg("PERSONA_FIRST_TIME_DESC"),
    ...DEFAULT_TRAITS,
  },
  "power-user": {
    name: msg("PERSONA_POWER_USER"),
    description: msg("PERSONA_POWER_USER_DESC"),
    ...DEFAULT_TRAITS,
    techLiteracy: "high",
  },
  "accessibility": {
    name: msg("PERSONA_ACCESSIBILITY"),
    description: msg("PERSONA_ACCESSIBILITY_DESC"),
    ...DEFAULT_TRAITS,
    sighted: false,
    keyboardOnly: true,
  },
  "non-technical": {
    name: msg("PERSONA_NON_TECHNICAL"),
    description: msg("PERSONA_NON_TECHNICAL_DESC"),
    ...DEFAULT_TRAITS,
    techLiteracy: "low",
  },
  "roaster": {
    name: msg("PERSONA_ROASTER"),
    description: msg("PERSONA_ROASTER_DESC"),
    ...DEFAULT_TRAITS,
  },
};

/**
 * Spreads default trait values onto a persona object so legacy records
 * (or presets that omit fields) always have a complete shape.
 * @param {Object} p - The persona record (may be partial).
 * @returns {Object} The persona with all trait fields filled in.
 */
function normalizeTraits(p) {
  return {
    ...DEFAULT_TRAITS,
    ...(p || {}),
  };
}

const TASK_HISTORY_MAX = 50;

let isRunning = false;
let isChatting = false;
let chatAbortController = null;
let stepCount = 0;
let hasSession = false;
let sessionHistory = [];
let chatHistory = [];
let currentPersona = null;
let currentTask = "";
let taskHistory = [];
let historyIndex = null;
let historyDraft = "";
let currentModel = "";
let sessionStartedAt = null;
let sessionOutcome = null;

const inputEl = document.getElementById("input");
const sendBtn = document.getElementById("send");
const newTestBtn = document.getElementById("new-test-btn");
const mainTop = document.getElementById("main-top");
const messagesEl = document.getElementById("messages");
const inputArea = document.getElementById("input-area");
const inputWrap = inputEl.closest(".input-wrap");
const mainFooter = mainTop.querySelector(".main-footer");
const apiKeyInput = document.getElementById("api-key-input");
const saveKeyBtn = document.getElementById("save-key-btn");
const settingsBtn = document.getElementById("settings-btn");
const settingsEl = document.getElementById("settings");
const disconnectBtn = document.getElementById("disconnect-btn");
const apiKeySection = document.getElementById("api-key-section");
const headerTitle = document.getElementById("header-title");
const personaSelect = document.getElementById("persona-select");
const personaBtn = document.getElementById("persona-btn");
const personaListEl = document.getElementById("persona-list");
const addPersonaBtn = document.getElementById("add-persona-btn");
const personaDialog = document.getElementById("persona-dialog");
const dialogTitle = document.getElementById("dialog-title");
const personaNameInput = document.getElementById("persona-name-input");
const personaDescInput = document.getElementById("persona-desc-input");
const personaSaveBtn = document.getElementById("persona-save-btn");
const personaCancelBtn = document.getElementById("persona-cancel-btn");
const personaDeleteBtn = document.getElementById("persona-delete-btn");
const stopBar = document.getElementById("stop-bar");
const stopTestBtn = document.getElementById("stop-test-btn");
const modelSelect = document.getElementById("model-select");
const exportBtn = document.getElementById("export-btn");
const personaSightedToggle = document.getElementById("persona-sighted-toggle");
const personaColorBlindnessSelect = document.getElementById("persona-colorblindness-select");
const personaKeyboardOnlyToggle = document.getElementById("persona-keyboard-only-toggle");
const personaColorBlindnessItem = document.getElementById("persona-colorblindness-item");
const personaAgeBandSelect = document.getElementById("persona-age-band-select");
const personaTechLiteracySelect = document.getElementById("persona-tech-literacy-select");

const selectSizer = document.createElement("span");
selectSizer.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;";
document.body.appendChild(selectSizer);

/**
 * Resizes a select element to fit its currently selected option text.
 * Matches the select's actual font and padding so the caret sits tight to the text.
 * @param {HTMLSelectElement} sel - The select element to resize.
 */
function resizeSelect(sel) {
  var cs = getComputedStyle(sel);
  selectSizer.style.font = cs.font;
  selectSizer.textContent = sel.options[sel.selectedIndex].text;
  var paddingLeft = parseFloat(cs.paddingLeft) || 0;
  var paddingRight = parseFloat(cs.paddingRight) || 0;
  sel.style.width = Math.ceil(selectSizer.offsetWidth + paddingLeft + paddingRight + 2) + "px";
}

/**
 * Saves a preference to storage.
 * @param {string} key - The preference key.
 * @param {string} value - The preference value.
 */
function savePref(key, value) {
  ChromeUtils.storageGet("preferences").then(function (data) {
    var prefs = data.preferences || {};
    prefs[key] = value;
    ChromeUtils.storageSet({ preferences: prefs });
  });
}

/**
 * Loads all preferences from storage.
 * @returns {Promise<Object>} The preferences object.
 */
async function loadPrefs() {
  var data = await ChromeUtils.storageGet("preferences");
  return data.preferences || {};
}

/**
 * Loads the stored task history into memory.
 */
async function loadTaskHistory() {
  var data = await ChromeUtils.storageGet("taskHistory");
  taskHistory = Array.isArray(data.taskHistory) ? data.taskHistory.slice() : [];
}

/**
 * Appends a task to history (deduping the most recent entry) and persists.
 * Also resets the history cursor so the next Up starts from the newest entry.
 * @param {string} task
 */
function pushTaskHistory(task) {
  if (!task) return;
  if (taskHistory.length > 0 && taskHistory[taskHistory.length - 1] === task) {
    // Dedupe consecutive duplicate
  } else {
    taskHistory.push(task);
    if (taskHistory.length > TASK_HISTORY_MAX) {
      taskHistory = taskHistory.slice(-TASK_HISTORY_MAX);
    }
    ChromeUtils.storageSet({ taskHistory: taskHistory });
  }
  historyIndex = null;
  historyDraft = "";
}

/**
 * Moves the caret to the end of the chat input.
 */
function moveInputCaretToEnd() {
  var range = document.createRange();
  range.selectNodeContents(inputEl);
  range.collapse(false);
  var sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

/**
 * Cycles to an older history entry. Stashes the current input as the draft on
 * the first step out of the end position.
 * @returns {boolean} True if the event should be consumed.
 */
function cycleHistoryUp() {
  if (taskHistory.length === 0) return false;
  if (historyIndex === null) {
    historyDraft = inputEl.textContent || "";
    historyIndex = taskHistory.length - 1;
  } else if (historyIndex > 0) {
    historyIndex--;
  } else {
    return true;
  }
  inputEl.textContent = taskHistory[historyIndex];
  moveInputCaretToEnd();
  updateSendButton();
  return true;
}

/**
 * Cycles to a newer history entry. Past the newest entry restores the stashed draft.
 * @returns {boolean} True if the event should be consumed.
 */
function cycleHistoryDown() {
  if (historyIndex === null) return false;
  if (historyIndex < taskHistory.length - 1) {
    historyIndex++;
    inputEl.textContent = taskHistory[historyIndex];
  } else {
    historyIndex = null;
    inputEl.textContent = historyDraft;
  }
  moveInputCaretToEnd();
  updateSendButton();
  return true;
}

modelSelect.addEventListener("change", function () {
  resizeSelect(modelSelect);
  savePref("model", modelSelect.value);
});

personaSightedToggle.addEventListener("change", syncSightedDependents);
personaColorBlindnessSelect.addEventListener("change", function () { resizeSelect(personaColorBlindnessSelect); });
personaAgeBandSelect.addEventListener("change", function () { resizeSelect(personaAgeBandSelect); });
personaTechLiteracySelect.addEventListener("change", function () { resizeSelect(personaTechLiteracySelect); });

/**
 * Toggles the is-disabled style on the color-blindness and low-vision rows
 * based on the current state of the sighted toggle.
 */
function syncSightedDependents() {
  var disabled = !personaSightedToggle.checked;
  personaColorBlindnessItem.classList.toggle("is-disabled", disabled);
}

let activeView = null;
let customPersonas = [];
let editingPersonaId = null;

/**
 * Syncs the visible button text with the selected option.
 */
function syncPersonaLabel() {
  personaBtn.textContent = personaSelect.options[personaSelect.selectedIndex].text;
}

personaSelect.addEventListener("change", function () {
  syncPersonaLabel();
  savePref("persona", personaSelect.value);
});
personaBtn.addEventListener("click", function () {
  personaSelect.focus();
  personaSelect.click();
});

/**
 * Loads custom personas from chrome.storage.local.
 * @returns {Promise<Array>} Array of {id, name, description} objects.
 */
async function loadCustomPersonas() {
  var data = await ChromeUtils.storageGet("customPersonas");
  var raw = data.customPersonas || [];
  customPersonas = raw.map(function (p) { return normalizeTraits(p); });
  return customPersonas;
}

/**
 * Saves custom personas to chrome.storage.local.
 * @param {Array} personas - Array of {id, name, description} objects.
 */
async function saveCustomPersonas(personas) {
  customPersonas = personas;
  await ChromeUtils.storageSet({ customPersonas: personas });
}

/**
 * Rebuilds the persona select options from presets and custom personas.
 */
function rebuildPersonaSelect() {
  var currentValue = personaSelect.value;
  personaSelect.innerHTML = "";

  for (var key of Object.keys(PERSONA_PRESETS)) {
    var opt = document.createElement("option");
    opt.value = key;
    opt.textContent = PERSONA_PRESETS[key].name;
    personaSelect.appendChild(opt);
  }

  for (var p of customPersonas) {
    var opt = document.createElement("option");
    opt.value = "custom-" + p.id;
    opt.textContent = p.name;
    personaSelect.appendChild(opt);
  }

  if (personaSelect.querySelector('option[value="' + currentValue + '"]')) {
    personaSelect.value = currentValue;
  } else {
    personaSelect.value = "first-time";
  }

  syncPersonaLabel();
}

/**
 * Renders the custom persona list rows in the settings panel.
 */
function renderPersonaList() {
  personaListEl.innerHTML = "";

  for (var p of customPersonas) {
    var item = document.createElement("div");
    item.className = "settings-item";
    item.style.cursor = "pointer";
    item.addEventListener("click", function () { openPersonaDialog(p); });

    var detail = document.createElement("div");
    detail.className = "settings-row-detail";

    var name = document.createElement("span");
    name.className = "settings-row-title";
    name.textContent = p.name;

    var desc = document.createElement("span");
    desc.className = "settings-row-footer persona-list-desc";
    desc.textContent = p.description;

    detail.appendChild(name);
    detail.appendChild(desc);
    item.appendChild(detail);
    personaListEl.appendChild(item);
  }
}

/**
 * Opens the persona dialog for creating or editing a persona.
 * @param {Object} [persona] - Existing persona to edit, or undefined for new.
 */
function openPersonaDialog(persona) {
  var traits = normalizeTraits(persona);
  if (persona) {
    editingPersonaId = persona.id;
    dialogTitle.textContent = msg("EDIT_PERSONA");
    personaNameInput.value = persona.name;
    personaDescInput.value = persona.description;
    personaDeleteBtn.hidden = false;
  } else {
    editingPersonaId = null;
    dialogTitle.textContent = msg("NEW_PERSONA");
    personaNameInput.value = "";
    personaDescInput.value = "";
    personaDeleteBtn.hidden = true;
  }
  personaSightedToggle.checked = !!traits.sighted;
  personaColorBlindnessSelect.value = traits.colorBlindness;
  personaKeyboardOnlyToggle.checked = !!traits.keyboardOnly;
  personaAgeBandSelect.value = traits.ageBand;
  personaTechLiteracySelect.value = traits.techLiteracy;
  syncSightedDependents();
  updatePersonaSaveButton();
  personaDialog.hidden = false;
  resizeSelect(personaColorBlindnessSelect);
  resizeSelect(personaAgeBandSelect);
  resizeSelect(personaTechLiteracySelect);
  personaNameInput.focus();
}

/**
 * Closes the persona dialog.
 */
function closePersonaDialog() {
  personaDialog.hidden = true;
  editingPersonaId = null;
}

/**
 * Validates and saves a persona from the dialog inputs.
 */
async function handlePersonaSave() {
  var name = personaNameInput.value.trim();
  var description = personaDescInput.value.trim();
  if (!name || !description) return;

  var traits = {
    sighted: personaSightedToggle.checked,
    colorBlindness: personaColorBlindnessSelect.value,
    keyboardOnly: personaKeyboardOnlyToggle.checked,
    ageBand: personaAgeBandSelect.value,
    techLiteracy: personaTechLiteracySelect.value,
  };

  if (editingPersonaId) {
    var idx = customPersonas.findIndex(function (p) { return p.id === editingPersonaId; });
    if (idx !== -1) {
      customPersonas[idx] = {
        ...customPersonas[idx],
        name: name,
        description: description,
        ...traits,
      };
    }
  } else {
    customPersonas.push({
      id: String(Date.now()),
      name: name,
      description: description,
      ...traits,
    });
  }

  await saveCustomPersonas(customPersonas);
  rebuildPersonaSelect();
  renderPersonaList();
  closePersonaDialog();
}

/**
 * Deletes a custom persona by ID.
 * @param {string} id - The persona ID to delete.
 */
async function handlePersonaDelete(id) {
  if (!confirm(msg("DELETE_PERSONA_CONFIRM"))) return;
  customPersonas = customPersonas.filter(function (p) { return p.id !== id; });
  await saveCustomPersonas(customPersonas);
  rebuildPersonaSelect();
  renderPersonaList();
  closePersonaDialog();
}

/**
 * Returns the currently selected persona object (with traits) from presets or custom list.
 * @returns {Object} Persona with name, description, and accessibility traits.
 */
function getSelectedPersona() {
  var val = personaSelect.value;
  if (val.startsWith("custom-")) {
    var id = val.slice(7);
    var custom = customPersonas.find(function (p) { return p.id === id; });
    if (custom) return normalizeTraits(custom);
  }
  return normalizeTraits(PERSONA_PRESETS[val] || PERSONA_PRESETS["first-time"]);
}

/**
 * Enables the persona save button only when both required fields (name, description)
 * have non-whitespace content.
 */
function updatePersonaSaveButton() {
  var hasName = personaNameInput.value.trim().length > 0;
  var hasDesc = personaDescInput.value.trim().length > 0;
  personaSaveBtn.disabled = !(hasName && hasDesc);
}

personaNameInput.addEventListener("input", updatePersonaSaveButton);
personaDescInput.addEventListener("input", updatePersonaSaveButton);

addPersonaBtn.addEventListener("click", function () { openPersonaDialog(); });
personaSaveBtn.addEventListener("click", handlePersonaSave);
personaCancelBtn.addEventListener("click", closePersonaDialog);
personaDeleteBtn.addEventListener("click", function () {
  if (editingPersonaId) handlePersonaDelete(editingPersonaId);
});
personaDialog.addEventListener("click", function (e) {
  if (e.target === personaDialog) closePersonaDialog();
});

/**
 * Checks for a stored API key and shows the appropriate initial view.
 */
async function init() {
  initI18n();

  await loadCustomPersonas();
  await loadTaskHistory();
  rebuildPersonaSelect();
  renderPersonaList();

  var prefs = await loadPrefs();
  if (prefs.model && modelSelect.querySelector('option[value="' + prefs.model + '"]')) {
    modelSelect.value = prefs.model;
  }
  resizeSelect(modelSelect);
  if (prefs.persona && personaSelect.querySelector('option[value="' + prefs.persona + '"]')) {
    personaSelect.value = prefs.persona;
  }
  syncPersonaLabel();

  var data = await ChromeUtils.storageGet("claudeApiKey");
  if (data.claudeApiKey) {
    apiKeySection.hidden = false;
    showView("main-view");
  } else {
    apiKeySection.hidden = true;
    showView("key-view");
  }
}

/**
 * Shows a single view by ID, hides all others, and closes settings if open.
 * @param {string} viewId - The DOM ID of the view to show.
 */
function showView(viewId) {
  activeView = viewId;
  settingsEl.style.display = "none";
  settingsBtn.classList.remove("is-close");
  headerTitle.textContent = msg("APP_TITLE");
  var views = document.querySelectorAll("#app > div");
  for (var i = 0; i < views.length; i++) {
    views[i].hidden = views[i].id !== viewId;
  }
  if (viewId === "main-view") {
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        inputEl.focus();
      });
    });
  }
}

/**
 * Toggles the settings panel visibility.
 */
settingsBtn.addEventListener("click", function () {
  if (settingsEl.style.display === "flex") {
    settingsEl.style.display = "none";
    settingsBtn.classList.remove("is-close");
    headerTitle.textContent = msg("APP_TITLE");
    if (activeView) showView(activeView);
  } else {
    settingsEl.style.display = "flex";
    settingsBtn.classList.add("is-close");
    headerTitle.textContent = msg("SETTINGS_TITLE");
    var views = document.querySelectorAll("#app > div");
    for (var i = 0; i < views.length; i++) {
      views[i].hidden = true;
    }
  }
});

/**
 * Disconnects the API key, clears state, and returns to the key view.
 */
disconnectBtn.addEventListener("click", async function () {
  if (!confirm(msg("DISCONNECT_CONFIRM"))) return;
  await ChromeUtils.storageSet({ claudeApiKey: "" });
  apiKeyInput.value = "";
  apiKeySection.hidden = true;
  resetChat();
  showView("key-view");
});

/**
 * Saves the API key to storage and transitions to the main view.
 */
saveKeyBtn.addEventListener("click", async function () {
  var value = apiKeyInput.value.trim();
  if (!value) return;

  saveKeyBtn.disabled = true;

  try {
    await ChromeUtils.storageSet({ claudeApiKey: value });
    apiKeyInput.value = "";
    saveKeyBtn.disabled = false;
    apiKeySection.hidden = false;
    showView("main-view");
  } catch (err) {
    alert(msg("SAVE_API_KEY_ERROR", [err.message]));
    saveKeyBtn.disabled = false;
  }
});

/**
 * Routes send button clicks to stop, chat, or start test depending on state.
 */
sendBtn.addEventListener("click", function () {
  if (isRunning) {
    ChromeUtils.sendMessage({ target: "background", type: "STOP_TEST" }).catch(function () {});
    return;
  }
  if (isChatting && chatAbortController) {
    chatAbortController.abort();
    return;
  }
  handleSend();
});
inputEl.addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
    return;
  }

  if (isRunning || hasSession) return;

  if (e.key === "ArrowUp") {
    if (cycleHistoryUp()) e.preventDefault();
    return;
  }
  if (e.key === "ArrowDown") {
    if (cycleHistoryDown()) e.preventDefault();
    return;
  }
});

/**
 * Handles the send action based on current state.
 */
function handleSend() {
  var text = (inputEl.textContent || "").trim();
  if (!text) return;

  inputEl.textContent = "";

  if (hasSession) {
    sendChatMessage(text);
  } else {
    startTest(text);
  }
}

stopTestBtn.addEventListener("click", function () {
  // Legacy: stop bar is no longer shown, stop is handled by the send button.
  ChromeUtils.sendMessage({ target: "background", type: "STOP_TEST" }).catch(function () {});
});

/**
 * Updates the send button disabled state based on input content.
 */
function updateSendButton() {
  var hasText = (inputEl.textContent || "").trim().length > 0;
  sendBtn.disabled = !hasText;
}

/**
 * Updates the export button visibility and disabled state. Hidden until a session
 * has produced at least one step; disabled while a test is actively running so the
 * user can see the button but can't export mid-run.
 */
function updateExportButton() {
  exportBtn.hidden = !hasSession;
  exportBtn.disabled = isRunning;
}

inputEl.addEventListener("input", updateSendButton);

/**
 * Resets the chat back to the idle setup state.
 */
newTestBtn.addEventListener("click", function () {
  if (isRunning) return;
  resetChat();
});

exportBtn.addEventListener("click", exportSession);

/**
 * Escapes a string for safe insertion into HTML text content / attributes.
 * @param {string} s
 * @returns {string}
 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Groups session history into runs keyed by the originating task. A follow-up
 * task marker closes the current run and starts a new one.
 * @returns {Array<{task: string, steps: Array<Object>}>}
 */
function buildRuns() {
  var runs = [];
  var current = { task: currentTask, steps: [] };
  for (var entry of sessionHistory) {
    if (entry.followUpTask) {
      runs.push(current);
      current = { task: entry.followUpTask, steps: [] };
      continue;
    }
    current.steps.push({
      stepNumber: entry.stepNumber,
      url: entry.url || null,
      action: entry.action,
      reasoning: entry.reasoning || "",
      success: entry.success !== false,
      error: entry.error || null,
    });
  }
  runs.push(current);
  return runs;
}

/**
 * Builds the structured session data object for session.json.
 * @returns {Object}
 */
function buildSessionData() {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    startedAt: sessionStartedAt,
    task: currentTask,
    persona: currentPersona,
    model: currentModel,
    outcome: sessionOutcome || { status: "incomplete" },
    stepCount: stepCount,
    runs: buildRuns(),
    chat: chatHistory.slice(),
  };
}

/**
 * Renders the HTML header block shown above the chat content in the exported report.
 * @returns {string}
 */
function buildReportHeader() {
  var p = currentPersona || {};
  var traits = [];
  if (p.sighted === false) traits.push("Not sighted");
  if (p.colorBlindness && p.colorBlindness !== "none") traits.push("Color blindness: " + p.colorBlindness);
  if (p.keyboardOnly) traits.push("Keyboard only");
  var traitHtml = traits.map(function (t) { return `<span class="trait">${escapeHtml(t)}</span>`; }).join("");

  var outcome = sessionOutcome || { status: "incomplete" };
  var outcomeLabel = outcome.status === "completed"
    ? "Completed"
    : outcome.status === "error"
      ? "Stopped — " + (outcome.message || "unknown")
      : "Incomplete";

  var startedLabel = sessionStartedAt ? new Date(sessionStartedAt).toLocaleString() : "—";

  return `<header class="report-meta">
  <h1>Roast Me — Session Report</h1>
  <dl>
    <dt>Task</dt><dd>${escapeHtml(currentTask || "—")}</dd>
    <dt>Persona</dt><dd><strong>${escapeHtml(p.name || "—")}</strong><div class="persona-desc">${escapeHtml(p.description || "")}</div>${traitHtml ? `<div class="traits">${traitHtml}</div>` : ""}</dd>
    <dt>Model</dt><dd>${escapeHtml(currentModel || "—")}</dd>
    <dt>Started</dt><dd>${escapeHtml(startedLabel)}</dd>
    <dt>Steps</dt><dd>${stepCount}</dd>
    <dt>Outcome</dt><dd>${escapeHtml(outcomeLabel)}</dd>
  </dl>
</header>`;
}

/**
 * Builds the full standalone HTML report as a string.
 * @param {string} css - The bundled stylesheet to inline.
 * @returns {string}
 */
function buildReportHtml(css) {
  var title = escapeHtml(currentTask || "Roast Me session");
  var header = buildReportHeader();
  var body = messagesEl.outerHTML;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,100..1000;1,9..40,100..1000&family=Noto+Color+Emoji&display=swap" rel="stylesheet">
<style>${css}</style>
<style>
body { background: var(--background); color: var(--on-surface); font-family: 'DM Sans', 'Noto Color Emoji', sans-serif; margin: 0; padding: 24px; }
.messages { display: flex; padding: 0; overflow: visible; max-width: 720px; margin: 0 auto; }
.report-meta { max-width: 720px; margin: 0 auto 24px; padding-bottom: 20px; border-bottom: 1px solid var(--outline-variant); }
.report-meta h1 { font-size: 18px; font-weight: 600; margin: 0 0 16px; color: var(--on-surface); }
.report-meta dl { display: grid; grid-template-columns: 96px 1fr; gap: 10px 16px; margin: 0; font-size: 14px; align-items: baseline; }
.report-meta dt { color: var(--on-surface-variant); font-weight: 400; }
.report-meta dd { margin: 0; color: var(--on-surface); }
.report-meta .persona-desc { color: var(--on-surface-variant); font-size: 13px; line-height: 1.5; margin-top: 2px; }
.report-meta .traits { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
.report-meta .trait { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: var(--surface-container); color: var(--on-surface-variant); }
</style>
</head>
<body>${header}${body}</body>
</html>`;
}

/**
 * Downloads the current session as a zip containing report.html + session.json.
 */
async function exportSession() {
  var cssUrl = chrome.runtime.getURL("sidePanel/styles.css");
  var css = await (await fetch(cssUrl)).text();

  var html = buildReportHtml(css);
  var json = JSON.stringify(buildSessionData(), null, 2);

  var zip = new JSZip();
  zip.file("report.html", html);
  zip.file("session.json", json);
  var blob = await zip.generateAsync({ type: "blob" });

  var url = URL.createObjectURL(blob);
  var stamp = new Date().toISOString().replace(/[:.]/g, "-");
  var a = document.createElement("a");
  a.href = url;
  a.download = `roast-me-session-${stamp}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * Resets all state and UI to the initial idle configuration.
 */
function resetChat() {
  isRunning = false;
  isChatting = false;
  hasSession = false;
  stepCount = 0;
  sessionHistory = [];
  chatHistory = [];
  currentPersona = null;
  currentTask = "";
  currentModel = "";
  sessionStartedAt = null;
  sessionOutcome = null;
  historyIndex = null;
  historyDraft = "";
  messagesEl.innerHTML = "";
  messagesEl.classList.remove("visible");
  mainTop.classList.remove("hidden");
  mainTop.insertBefore(inputWrap, mainFooter);
  stopBar.hidden = true;
  inputArea.hidden = true;
  newTestBtn.hidden = true;
  updateExportButton();
  sendBtn.classList.remove("stop");
  modelSelect.disabled = false;
  inputEl.setAttribute("contenteditable", "plaintext-only");
  inputEl.setAttribute("data-placeholder", msg("TASK_PLACEHOLDER"));
  syncPersonaLabel();
  updateSendButton();
  inputEl.focus();
}

/**
 * Transitions the layout from the centered idle state to the scrolling chat view.
 */
function switchToChatLayout() {
  mainTop.classList.add("hidden");
  messagesEl.classList.add("visible");
}

/**
 * Enters testing mode: shows the input area with input disabled and the stop button.
 */
function showStopBar() {
  inputArea.appendChild(inputWrap);
  inputArea.hidden = false;
  inputEl.setAttribute("contenteditable", "false");
  inputEl.textContent = "";
  sendBtn.classList.add("stop");
  sendBtn.disabled = false;
  modelSelect.disabled = true;
  newTestBtn.hidden = true;
  updateExportButton();
}

/**
 * Exits testing mode: re-enables the chat input and send button.
 */
function showChatInput() {
  inputArea.appendChild(inputWrap);
  inputArea.hidden = false;
  inputEl.setAttribute("contenteditable", "plaintext-only");
  sendBtn.classList.remove("stop");
  modelSelect.disabled = false;
}

/**
 * Appends a message bubble to the chat feed and scrolls to the bottom.
 * @param {string} text - The message text.
 * @param {string} type - The message type (user, ai, status).
 * @returns {HTMLElement} The created message element.
 */
function addMessage(text, type) {
  var el = document.createElement("div");
  el.className = "msg msg-" + type;
  if (type === "ai") {
    el.innerHTML = marked.parse(text);
  } else {
    el.textContent = text;
  }
  messagesEl.appendChild(el);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return el;
}

let typingEl = null;

/**
 * Shows the animated typing indicator in the message feed.
 */
function showTypingIndicator() {
  hideTypingIndicator();
  typingEl = document.createElement("div");
  typingEl.className = "typing-indicator";
  typingEl.textContent = msg("THINKING");
  messagesEl.appendChild(typingEl);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/**
 * Removes the typing indicator from the message feed.
 */
function hideTypingIndicator() {
  if (typingEl) {
    typingEl.remove();
    typingEl = null;
  }
}

/**
 * Starts a test run with the given freeform input as the task.
 * @param {string} task - The freeform task description.
 */
async function startTest(task) {
  pushTaskHistory(task);

  isRunning = true;
  hasSession = false;
  stepCount = 0;
  sessionHistory = [];
  chatHistory = [];
  currentPersona = getSelectedPersona();
  currentTask = task;
  currentModel = modelSelect.value;
  sessionStartedAt = new Date().toISOString();
  sessionOutcome = null;

  switchToChatLayout();
  showStopBar();
  addMessage(task, "user");
  showTypingIndicator();

  try {
    var response = await ChromeUtils.sendMessage({
      target: "background",
      type: "START_TEST",
      persona: currentPersona,
      task: task,
      productContext: "",
      model: modelSelect.value,
    });
    if (response.error) {
      onTestError(response.error);
    }
  } catch (err) {
    onTestError(err.message);
  }
}

/**
 * Handles test completion: enables chat mode for interviewing the persona.
 */
function onTestComplete() {
  isRunning = false;
  hasSession = true;
  sessionOutcome = { status: "completed" };
  hideTypingIndicator();

  addMessage(msg("TEST_COMPLETED", [String(stepCount)]), "status");

  showChatInput();
  inputEl.setAttribute("data-placeholder", msg("CHAT_PLACEHOLDER"));
  newTestBtn.hidden = false;
  updateExportButton();
  updateSendButton();
  inputEl.focus();
}

/**
 * Handles test errors and transitions UI appropriately.
 * @param {string} error - The error message.
 */
function onTestError(error) {
  isRunning = false;
  sessionOutcome = { status: "error", message: error };
  hideTypingIndicator();

  if (stepCount > 0) {
    hasSession = true;
    addMessage(msg("TEST_STOPPED", [error]), "status");
    showChatInput();
    inputEl.setAttribute("data-placeholder", msg("CHAT_PLACEHOLDER"));
    newTestBtn.hidden = false;
  } else {
    addMessage(msg("TEST_ERROR", [error]), "status msg-error");
    showChatInput();
  }
  updateExportButton();
  updateSendButton();
}

/**
 * Renders a step update from the background as a chat message.
 * @param {Object} step - The step data.
 */
function onStepUpdate(step) {
  hideTypingIndicator();
  stepCount++;
  sessionHistory.push(step);

  var aiEl = null;
  if (step.reasoning) {
    aiEl = addMessage(step.reasoning, "ai");
  }

  var shotData = step.screenshot || step.cleanScreenshot;
  if (shotData) {
    if (!aiEl) aiEl = addMessage("", "ai");
    appendStepScreenshot(aiEl, shotData, step.gesture);
  }

  if (!step.success && step.action.type !== "blocked") {
    addMessage(msg("ACTION_FAILED", [step.action.type]), "status msg-error");
  }

  showTypingIndicator();
}

const POINT_GESTURE_SET = new Set([
  "click", "hover", "focus", "type", "clear", "clear_and_type",
  "keypress", "select_option",
]);
const GESTURE_COLOR = "#ef4444";
const GESTURE_COLOR_RGB = "239, 68, 68";

/**
 * Appends a screenshot with the gesture composited onto it as a single PNG.
 * @param {HTMLElement} msgEl - The message element to append into.
 * @param {string} b64 - Base64-encoded PNG screenshot data.
 * @param {Object|null} gesture - Gesture descriptor in screenshot-pixel space.
 */
function appendStepScreenshot(msgEl, b64, gesture) {
  var wrap = document.createElement("div");
  wrap.className = "step-screenshot";

  var img = document.createElement("img");
  img.alt = "";
  img.decoding = "async";
  img.draggable = false;
  img.addEventListener("load", function () {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });
  wrap.appendChild(img);
  msgEl.appendChild(wrap);

  var rawUrl = "data:image/png;base64," + b64;

  if (!gesture) {
    img.src = rawUrl;
    return;
  }

  compositeStepImage(rawUrl, gesture).then(function (dataUrl) {
    img.src = dataUrl;
  }, function () {
    img.src = rawUrl;
  });
}

/**
 * Draws the screenshot and gesture together into a single PNG data URL.
 * @param {string} src - The source image URL (typically a data: URL).
 * @param {Object} gesture - Gesture descriptor in screenshot-pixel space.
 * @returns {Promise<string>} A PNG data URL of the composite.
 */
function compositeStepImage(src, gesture) {
  return new Promise(function (resolve, reject) {
    var img = new Image();
    img.onload = function () {
      try {
        var canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        drawGesture(ctx, gesture);
        resolve(canvas.toDataURL("image/png"));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = function () { reject(new Error("image load failed")); };
    img.src = src;
  });
}

/**
 * Draws a gesture onto a 2D canvas context in screenshot-pixel space.
 * @param {CanvasRenderingContext2D} ctx - The canvas context.
 * @param {Object} g - Gesture descriptor.
 */
function drawGesture(ctx, g) {
  if (POINT_GESTURE_SET.has(g.type)) {
    ctx.save();
    ctx.strokeStyle = GESTURE_COLOR;
    ctx.lineWidth = 10;
    ctx.beginPath();
    ctx.arc(g.x, g.y, 40, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = GESTURE_COLOR;
    ctx.beginPath();
    ctx.arc(g.x, g.y, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  if (g.type === "scroll") {
    var dx = g.deltaX || 0;
    var dy = g.deltaY || 0;
    var mag = Math.hypot(dx, dy);
    var len = Math.max(160, Math.min(520, mag || 260));
    var thick = 44;
    var angle = mag > 0 ? Math.atan2(dy, dx) : Math.PI / 2;

    ctx.save();
    ctx.translate(g.x, g.y);
    ctx.rotate(angle);
    var grad = ctx.createLinearGradient(-len / 2, 0, len / 2, 0);
    grad.addColorStop(0, "rgba(" + GESTURE_COLOR_RGB + ", 0)");
    grad.addColorStop(1, "rgba(" + GESTURE_COLOR_RGB + ", 0.75)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.roundRect(-len / 2, -thick / 2, len, thick, thick / 2);
    ctx.fill();
    ctx.restore();
    return;
  }

  if (g.type === "drag") {
    ctx.save();
    ctx.strokeStyle = GESTURE_COLOR;
    ctx.lineWidth = 8;
    ctx.lineCap = "round";
    ctx.setLineDash([14, 10]);
    ctx.beginPath();
    ctx.moveTo(g.fromX, g.fromY);
    ctx.lineTo(g.toX, g.toY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = GESTURE_COLOR;
    ctx.beginPath();
    ctx.arc(g.fromX, g.fromY, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(g.toX, g.toY, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

/**
 * Creates a ClaudeClient using the stored API key.
 * @returns {Promise<ClaudeClient>} A configured client instance.
 */
async function getClaudeClient() {
  var data = await ChromeUtils.storageGet("claudeApiKey");
  if (!data.claudeApiKey) throw new Error(msg("API_KEY_NOT_CONFIGURED"));
  return new ClaudeClient(data.claudeApiKey, modelSelect.value);
}

/**
 * Streams a chat message directly from the side panel to the Claude API.
 * @param {string} text - The user's question.
 */
async function sendChatMessage(text) {
  isChatting = true;
  chatAbortController = new AbortController();
  sendBtn.classList.add("stop");
  sendBtn.disabled = false;
  inputEl.setAttribute("contenteditable", "false");

  chatHistory.push({ role: "user", content: text });

  addMessage(text, "user");
  showTypingIndicator();

  var aiEl = null;
  var accumulated = "";

  try {
    var claude = await getClaudeClient();
    var systemPrompt = buildChatSystemPrompt(currentPersona, currentTask, sessionHistory);

    await claude.streamChat(systemPrompt, chatHistory, function (delta) {
      if (!aiEl) {
        hideTypingIndicator();
        aiEl = addMessage("", "ai");
      }
      accumulated += delta;
      aiEl.innerHTML = marked.parse(accumulated);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }, chatAbortController.signal);

    chatHistory.push({ role: "assistant", content: accumulated });

    if (/\[RUN_TEST\]/.test(accumulated)) {
      var cleanText = accumulated.replace(/\[RUN_TEST\][\s\S]*$/, "").trim();

      if (cleanText && aiEl) {
        aiEl.innerHTML = marked.parse(cleanText);
      } else if (!cleanText && aiEl) {
        aiEl.remove();
      }

      chatHistory[chatHistory.length - 1].content = cleanText;
      messagesEl.scrollTop = messagesEl.scrollHeight;

      isChatting = false;
      chatAbortController = null;
      sendBtn.classList.remove("stop");
      launchFollowUpTest(text);
      return;
    }
  } catch (err) {
    if (err.name === "AbortError") {
      hideTypingIndicator();
      if (accumulated) {
        chatHistory.push({ role: "assistant", content: accumulated });
      } else if (aiEl) {
        aiEl.remove();
      }
    } else {
      hideTypingIndicator();
      if (aiEl) aiEl.remove();
      addMessage(msg("TEST_ERROR", [err.message]), "status msg-error");
    }
  }

  isChatting = false;
  chatAbortController = null;
  sendBtn.classList.remove("stop");
  inputEl.setAttribute("contenteditable", "plaintext-only");
  updateSendButton();
  inputEl.focus();
}

/**
 * Launches a follow-up test within the existing conversation.
 * Unlike startTest, this preserves session and chat history.
 * @param {string} task - The task for the follow-up test.
 */
async function launchFollowUpTest(task) {
  isRunning = true;
  stepCount = 0;

  sessionHistory.push({ followUpTask: task });

  showStopBar();
  showTypingIndicator();

  try {
    var response = await ChromeUtils.sendMessage({
      target: "background",
      type: "START_TEST",
      persona: currentPersona,
      task: task,
      productContext: "",
      model: modelSelect.value,
    });
    if (response.error) {
      onTestError(response.error);
    }
  } catch (err) {
    onTestError(err.message);
  }
}

chrome.runtime.onMessage.addListener(function (message) {
  if (!message.target || message.target !== "sidepanel") return;

  switch (message.type) {
    case "STEP_UPDATE":
      onStepUpdate(message.step);
      break;
    case "TEST_COMPLETE":
      onTestComplete();
      break;
    case "TEST_ERROR":
      onTestError(message.error);
      break;
  }
});

updateSendButton();
syncPersonaLabel();
document.fonts.ready.then(function () { resizeSelect(modelSelect); });
init();
