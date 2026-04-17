"use strict";

/* global chrome */

import ChromeUtils from "./promisify.js";
import ClaudeClient from "./claude.js";
import { buildChatSystemPrompt } from "./prompts.js";
import { marked } from "marked";

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

let isRunning = false;
let isChatting = false;
let chatAbortController = null;
let stepCount = 0;
let hasSession = false;
let sessionHistory = [];
let chatHistory = [];
let currentPersona = null;
let currentTask = "";

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
const testOverlay = document.getElementById("test-overlay");
const modelSelect = document.getElementById("model-select");
const personaSightedToggle = document.getElementById("persona-sighted-toggle");
const personaColorBlindnessSelect = document.getElementById("persona-colorblindness-select");
const personaKeyboardOnlyToggle = document.getElementById("persona-keyboard-only-toggle");
const personaColorBlindnessItem = document.getElementById("persona-colorblindness-item");

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

modelSelect.addEventListener("change", function () {
  resizeSelect(modelSelect);
  savePref("model", modelSelect.value);
});

personaSightedToggle.addEventListener("change", syncSightedDependents);
personaColorBlindnessSelect.addEventListener("change", function () { resizeSelect(personaColorBlindnessSelect); });

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
  syncSightedDependents();
  personaDialog.hidden = false;
  resizeSelect(personaColorBlindnessSelect);
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

inputEl.addEventListener("input", updateSendButton);

/**
 * Resets the chat back to the idle setup state.
 */
newTestBtn.addEventListener("click", function () {
  if (isRunning) return;
  resetChat();
});

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
  messagesEl.innerHTML = "";
  messagesEl.classList.remove("visible");
  mainTop.classList.remove("hidden");
  mainTop.insertBefore(inputWrap, mainFooter);
  stopBar.hidden = true;
  testOverlay.hidden = true;
  inputArea.hidden = true;
  newTestBtn.hidden = true;
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
  testOverlay.hidden = false;
  inputArea.appendChild(inputWrap);
  inputArea.hidden = false;
  inputEl.setAttribute("contenteditable", "false");
  inputEl.textContent = "";
  sendBtn.classList.add("stop");
  sendBtn.disabled = false;
  modelSelect.disabled = true;
  newTestBtn.hidden = true;
}

/**
 * Exits testing mode: re-enables the chat input and send button.
 */
function showChatInput() {
  testOverlay.hidden = true;
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
  isRunning = true;
  hasSession = false;
  stepCount = 0;
  sessionHistory = [];
  chatHistory = [];
  currentPersona = getSelectedPersona();
  currentTask = task;

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
  hideTypingIndicator();

  addMessage(msg("TEST_COMPLETED", [String(stepCount)]), "status");

  showChatInput();
  inputEl.setAttribute("data-placeholder", msg("CHAT_PLACEHOLDER"));
  newTestBtn.hidden = false;
  updateSendButton();
  inputEl.focus();
}

/**
 * Handles test errors and transitions UI appropriately.
 * @param {string} error - The error message.
 */
function onTestError(error) {
  isRunning = false;
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

  if (step.cleanScreenshot) {
    if (!aiEl) aiEl = addMessage("", "ai");
    appendStepScreenshot(aiEl, step.cleanScreenshot, step.gesture);
  }

  if (!step.success) {
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
