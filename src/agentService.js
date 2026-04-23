"use strict";

import ClaudeClient from "./claude.js";
import {
  attachDebugger,
  detachDebugger,
  capturePageState,
  clickElement,
  doubleClickElement,
  tripleClickElement,
  hoverElement,
  focusElement,
  uploadFile,
  dispatchClick,
  dispatchDoubleClick,
  dispatchTripleClick,
  dispatchType,
  dispatchKeyPress,
  dispatchScroll,
  dispatchDragAndDrop,
  selectAllAndType,
  clearInput,
  selectDropdownOption,
  goBack,
  waitForPageSettle,
  resolveElementCoordinates,
  scaleCoordinatesFromScreenshot,
  getPageMetadata,
  setApprovedOrigin,
  consumeBlockedNavigations,
  setLLMImageSize,
  TAG_COLORS,
  DEFAULT_COLOR,
} from "./cdp.js";
import {
  buildSystemPrompt,
  buildStepPrompt,
} from "./prompts.js";
import { resizeBase64Image, renderAnnotatedScreenshot } from "./image.js";

const LLM_SCREENSHOT_MAX_WIDTH = 1024;
const LLM_SCREENSHOT_QUALITY = 0.85;

const MAX_STEPS = 100;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_ACTIONS_PER_STEP = 4;
const TERMINAL_ACTIONS = new Set(["done", "fail"]);
const PAGE_CHANGING_ACTIONS = new Set(["go_back", "click"]);
const LOOP_WINDOW_SIZE = 20;
const STAGNANT_THRESHOLD = 5;

const POINT_GESTURE_TYPES = new Set([
  "click", "double_click", "triple_click", "hover", "focus", "type", "clear", "clear_and_type",
  "keypress", "select_option",
]);

const KEYBOARD_BLOCKED_ACTIONS = new Set([
  "click", "double_click", "triple_click", "hover", "drag",
]);

const UPLOAD_FIXTURES = {
  "avatar.jpg": { type: "image/jpeg" },
  "photo.jpg": { type: "image/jpeg" },
  "document.pdf": { type: "application/pdf" },
  "data.csv": { type: "text/csv" },
  "text.txt": { type: "text/plain" },
};

/**
 * Parses the origin (scheme + host + port) from a URL string.
 * @param {string} url
 * @returns {string|null}
 */
function getOrigin(url) {
  try {
    return new URL(url).origin;
  } catch (err) {
    return null;
  }
}

// Machado-style color-blindness matrices (20-value row-major 4x5, feColorMatrix format)
const COLOR_BLINDNESS_MATRICES = {
  protanopia:    [0.567, 0.433, 0,     0, 0,   0.558, 0.442, 0,     0, 0,   0,     0.242, 0.758, 0, 0,   0, 0, 0, 1, 0],
  deuteranopia:  [0.625, 0.375, 0,     0, 0,   0.7,   0.3,   0,     0, 0,   0,     0.3,   0.7,   0, 0,   0, 0, 0, 1, 0],
  tritanopia:    [0.95,  0.05,  0,     0, 0,   0,     0.433, 0.567, 0, 0,   0,     0.475, 0.525, 0, 0,   0, 0, 0, 1, 0],
  achromatopsia: [0.299, 0.587, 0.114, 0, 0,   0.299, 0.587, 0.114, 0, 0,   0.299, 0.587, 0.114, 0, 0,   0, 0, 0, 1, 0],
};

/**
 * Returns the color-blindness transform matrix for a persona, or null if
 * none should be applied. The matrix is passed to renderAnnotatedScreenshot
 * which applies it on an offscreen canvas.
 * @param {Object} persona - The persona.
 * @returns {number[]|null}
 */
function pickColorMatrix(persona) {
  if (!persona || persona.sighted === false) return null;
  const cbType = persona.colorBlindness && persona.colorBlindness !== "none" ? persona.colorBlindness : null;
  if (!cbType || !COLOR_BLINDNESS_MATRICES[cbType]) return null;
  return COLOR_BLINDNESS_MATRICES[cbType];
}

/**
 * Builds a gesture descriptor for the UI overlay in screenshot-pixel space.
 * @param {Object} action - The executed action.
 * @param {number} dpr - The device pixel ratio at capture time.
 * @returns {Object|null} Gesture descriptor, or null if no visual is applicable.
 */
function buildGesture(action, dpr) {
  if (!action) return null;

  const toShotCoords = function (cssX, cssY) {
    return { x: Math.round(cssX * dpr), y: Math.round(cssY * dpr) };
  };

  const resolvePoint = function () {
    if (action.index !== undefined) {
      try {
        const css = resolveElementCoordinates(action.index);
        return toShotCoords(css.x, css.y);
      } catch (err) {
        return null;
      }
    }
    if (typeof action.x === "number" && typeof action.y === "number") {
      const css = scaleCoordinatesFromScreenshot(action.x, action.y);
      return toShotCoords(css.x, css.y);
    }
    return null;
  };

  if (POINT_GESTURE_TYPES.has(action.type)) {
    const p = resolvePoint();
    if (!p) return null;
    return { type: action.type, x: p.x, y: p.y };
  }

  if (action.type === "scroll") {
    const p = resolvePoint() || { x: 0, y: 0 };
    return {
      type: "scroll",
      x: p.x,
      y: p.y,
      deltaX: Math.round((action.deltaX || 0) * dpr),
      deltaY: Math.round((action.deltaY || -300) * dpr),
    };
  }

  if (action.type === "drag") {
    let from = null;
    if (action.index !== undefined) {
      try {
        const css = resolveElementCoordinates(action.index);
        from = toShotCoords(css.x, css.y);
      } catch (err) {
        from = null;
      }
    }
    if (!from) return null;
    if (typeof action.x !== "number" || typeof action.y !== "number") return null;
    const toCss = scaleCoordinatesFromScreenshot(action.x, action.y);
    const toShot = toShotCoords(toCss.x, toCss.y);
    return {
      type: "drag",
      fromX: from.x,
      fromY: from.y,
      toX: toShot.x,
      toY: toShot.y,
    };
  }

  return null;
}

/**
 * Detects repetitive agent behavior by tracking a rolling window of action hashes
 * and page fingerprints. Returns escalating nudge messages at 5, 8, and 12 repetitions.
 */
class ActionLoopDetector {
  constructor() {
    this.actionHashes = [];
    this.pageFingerprints = [];
    this.stagnantCount = 0;
  }

  /**
   * Produces a string hash for an action based on its type and key parameters.
   * @param {Object} action - The action to hash.
   * @returns {string} A hash string identifying the action.
   */
  hashAction(action) {
    switch (action.type) {
      case "click":
      case "double_click":
      case "triple_click":
        return `${action.type}:${action.index !== undefined ? action.index : `${action.x},${action.y}`}`;
      case "type":
      case "clear_and_type":
        return `${action.type}:${action.index !== undefined ? action.index : ""}:${action.value || ""}`;
      case "scroll": {
        const dir = (action.deltaY || 0) > 0 ? "down" : "up";
        return `scroll:${dir}:${action.index !== undefined ? action.index : ""}`;
      }
      case "keypress":
        return `keypress:${action.value || ""}`;
      default:
        return `${action.type}:${action.index !== undefined ? action.index : ""}:${action.value || ""}`;
    }
  }

  /**
   * Records an action and page fingerprint, updating the rolling window and stagnation counter.
   * @param {Object} action - The action that was executed.
   * @param {string} pageFingerprint - A string identifying the current page state (URL + element count).
   */
  addAction(action, pageFingerprint) {
    const hash = this.hashAction(action);
    this.actionHashes.push(hash);
    if (this.actionHashes.length > LOOP_WINDOW_SIZE) {
      this.actionHashes.shift();
    }

    if (this.pageFingerprints.length > 0) {
      const last = this.pageFingerprints[this.pageFingerprints.length - 1];
      if (last === pageFingerprint) {
        this.stagnantCount++;
      } else {
        this.stagnantCount = 0;
      }
    }
    this.pageFingerprints.push(pageFingerprint);
  }

  /**
   * Returns an escalating nudge message if repetitive behavior or page stagnation is detected.
   * @returns {string|null} A nudge message, or null if no loop is detected.
   */
  getNudge() {
    const counts = {};
    for (const h of this.actionHashes) {
      counts[h] = (counts[h] || 0) + 1;
    }
    const maxRepeats = Math.max(0, ...Object.values(counts));

    if (maxRepeats >= 6) {
      return "STOP. You have repeated the same action many times without progress. Use 'fail' NOW with reasoning that (a) describes what you've tried, (b) what's blocking you, and (c) a specific question asking the researcher how to proceed.";
    }
    if (maxRepeats >= 4) {
      return "You've repeated this action several times. If it's not moving things forward, use 'fail' with a specific question for the researcher about what to try next — a human would ask for guidance here, not keep retrying.";
    }
    if (maxRepeats >= 3) {
      return "You've tried this a few times already. If it's not working, either take a genuinely different approach or use 'fail' to ask the researcher for guidance rather than continuing to retry.";
    }

    if (this.stagnantCount >= STAGNANT_THRESHOLD) {
      return "The page hasn't changed in several steps. Try scrolling or clicking something different — or, if you're stuck, use 'fail' to ask the researcher how to proceed.";
    }

    return null;
  }
}

/**
 * Orchestrates a UX testing session by driving a browser tab through a task
 * using an LLM agent that observes screenshots and decides actions.
 */
export default class AgentService {
  constructor() {
    this.isRunning = false;
    this.tabId = null;
    this.claude = null;
    this.persona = null;
    this.task = null;
    this.productContext = "";
    this.sessionHistory = [];
    this.systemPrompt = "";
    this.loopDetector = null;
    this.colorMatrix = null;
    this.abortController = null;
    this.rejectedActions = [];
    this._confirmResolver = null;
  }

  /**
   * Resolves the currently-pending confirm Promise with the researcher's answer.
   * Called by the background message handler when the side panel reports a click.
   * @param {boolean} approved
   */
  resolveConfirm(approved) {
    if (this._confirmResolver) {
      const r = this._confirmResolver;
      this._confirmResolver = null;
      r(!!approved);
    }
  }

  /**
   * Starts a test session: attaches the debugger, runs the agent loop, and detaches on completion.
   * @param {Object} config - Test configuration.
   * @param {number} config.tabId - The Chrome tab ID to test.
   * @param {Object} config.persona - The persona to simulate.
   * @param {string} config.task - The task to complete.
   * @param {string} config.productContext - Optional product context.
   * @param {string} config.apiKey - The Claude API key.
   * @param {Function} [onStepCallback] - Called after each step with the step record.
   */
  async runTest(config, onStepCallback) {
    const { tabId, persona, task, productContext, apiKey, model, sightedA11y } = config;

    this.tabId = tabId;
    this.persona = persona;
    this.task = task;
    this.productContext = productContext || "";
    this.sessionHistory = [];
    this.rejectedActions = [];
    this._confirmResolver = null;
    this.isRunning = true;
    this.colorMatrix = pickColorMatrix(persona);
    this.sightedA11y = sightedA11y !== false;
    this.claude = new ClaudeClient(apiKey, model);
    this.systemPrompt = buildSystemPrompt(persona, productContext);
    this.loopDetector = new ActionLoopDetector();
    this.abortController = new AbortController();
    this.approvedOrigin = null;

    try {
      await attachDebugger(tabId);
      try {
        const startMeta = await getPageMetadata(tabId);
        this.approvedOrigin = getOrigin(startMeta.url);
      } catch (err) {
        this.approvedOrigin = null;
      }
      setApprovedOrigin(this.approvedOrigin);
      await this._runLoop(onStepCallback);
    } finally {
      setApprovedOrigin(null);
      await detachDebugger(tabId);
      this.isRunning = false;
    }
  }

  /**
   * Stops the currently running test and detaches the debugger.
   */
  async stopTest() {
    this.isRunning = false;
    if (this._confirmResolver) {
      const r = this._confirmResolver;
      this._confirmResolver = null;
      r(false);
    }
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.tabId) {
      await detachDebugger(this.tabId);
    }
  }

  /**
   * Runs the main agent loop: captures page state, queries the LLM, executes actions,
   * and records results until the task is complete or the step limit is reached.
   * @param {Function} [onStepCallback] - Called after each step with the step record.
   */
  async _runLoop(onStepCallback) {
    let consecutiveFailures = 0;

    for (let stepNumber = 1; stepNumber <= MAX_STEPS; stepNumber++) {
      if (!this.isRunning) break;

      let pageState;
      try {
        const sighted = this.persona && this.persona.sighted !== false;
        const minimalElements = sighted && !this.sightedA11y;
        pageState = await capturePageState(this.tabId, { minimalElements });
      } catch (err) {
        if (/chrome-extension:\/\/|different extension/i.test(err.message || "")) {
          console.warn("[Agent] Capture blocked by injected extension frame; skipping step:", err.message);
          continue;
        }
        throw new Error(`Failed to capture page state: ${err.message}`);
      }

      const blocked = consumeBlockedNavigations();
      if (blocked.length > 0) {
        const targetHosts = Array.from(new Set(blocked.map(function (b) {
          try { return new URL(b.url).hostname; } catch (err) { return b.origin; }
        }))).join(", ");

        let startHost = "the starting site";
        if (this.approvedOrigin) {
          try { startHost = new URL(this.approvedOrigin).hostname; }
          catch (err) { startHost = this.approvedOrigin; }
        }

        const blockedStep = {
          stepNumber,
          action: { type: "blocked" },
          reasoning: `That would've taken me off ${startHost} to ${targetHosts} — this test stays on the site I started on. Backing up to try a different path.`,
          observation: "",
          sentiment: "neutral",
          cleanScreenshot: pageState.cleanScreenshot,
          gesture: null,
          url: pageState.metadata.url,
          success: false,
          error: `Navigation to ${targetHosts} blocked — tests are scoped to ${startHost}.`,
          phase: "complete",
        };
        this.sessionHistory.push(blockedStep);
        if (onStepCallback) onStepCallback(blockedStep);
        continue;
      }

      if (!this.isRunning) break;

      const pageFingerprint = `${pageState.metadata.url}|${pageState.elementCount}`;
      const nudge = this.loopDetector.getNudge();

      let stepPrompt = buildStepPrompt(this.task, this.sessionHistory, pageState, this.persona, this.rejectedActions);
      if (nudge) {
        stepPrompt += `\n\nSYSTEM NOTE: ${nudge}`;
      }

      const sighted = this.persona && this.persona.sighted !== false;
      let llmImage = null;
      let renderedBase64 = pageState.cleanScreenshot;
      if (sighted) {
        try {
          const rendered = await renderAnnotatedScreenshot(
            pageState.cleanScreenshot,
            pageState.elementsForAnnotation,
            pageState.devicePixelRatio || 1,
            TAG_COLORS,
            DEFAULT_COLOR,
            this.colorMatrix,
          );
          renderedBase64 = rendered.data;
        } catch (err) {
          console.warn("[Agent] Offscreen render failed, sending clean screenshot:", err.message);
        }
        try {
          llmImage = await resizeBase64Image(renderedBase64, "image/png", LLM_SCREENSHOT_MAX_WIDTH, LLM_SCREENSHOT_QUALITY);
        } catch (err) {
          console.warn("[Agent] Screenshot resize failed, sending original:", err.message);
          const fallbackDpr = pageState.devicePixelRatio || 1;
          llmImage = {
            data: renderedBase64,
            mediaType: "image/png",
            width: Math.round((pageState.viewportWidth || 0) * fallbackDpr),
            height: Math.round((pageState.viewportHeight || 0) * fallbackDpr),
          };
        }
        setLLMImageSize(llmImage.width, llmImage.height);
      } else {
        setLLMImageSize(0, 0);
      }
      const userParts = sighted
        ? [
            { type: "text", text: stepPrompt },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: llmImage.mediaType,
                data: llmImage.data,
              },
            },
          ]
        : [
            { type: "text", text: stepPrompt },
          ];

      let response;
      try {
        response = await this._callLLMWithRetry(userParts);
      } catch (err) {
        if (err.name === "AbortError" || !this.isRunning) {
          break;
        }
        console.error("[Agent] Step", stepNumber, "- LLM call failed:", err.message);
        const stepRecord = {
          stepNumber,
          action: { type: "error" },
          reasoning: `LLM error: ${err.message}`,
          observation: "",
          cleanScreenshot: pageState.cleanScreenshot,
          gesture: null,
          url: pageState.metadata.url,
          success: false,
          error: err.message,
          phase: "complete",
        };

        this.sessionHistory.push(stepRecord);
        if (onStepCallback) onStepCallback(stepRecord);

        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          throw new Error(`Stopping after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
        }
        continue;
      }

      const actions = this._normalizeActions(response);

      if (actions.length === 0) {
        const stepRecord = {
          stepNumber,
          action: { type: "fail" },
          reasoning: response.reasoning || "No actions returned by LLM",
          observation: response.observation || "",
        sentiment: response.sentiment || "neutral",
          cleanScreenshot: pageState.cleanScreenshot,
          gesture: null,
          url: pageState.metadata.url,
          success: false,
          error: "LLM returned no actions",
          phase: "complete",
        };
        this.sessionHistory.push(stepRecord);
        if (onStepCallback) onStepCallback(stepRecord);
        break;
      }

      if (onStepCallback) {
        onStepCallback({
          stepNumber,
          action: actions[0],
          reasoning: response.reasoning || "",
          observation: response.observation || "",
          sentiment: response.sentiment || "neutral",
          cleanScreenshot: pageState.cleanScreenshot,
          gesture: buildGesture(actions[0], pageState.devicePixelRatio),
          url: pageState.metadata.url,
          phase: "announce",
        });
      }

      let lastAction = actions[0];
      let allSuccess = true;
      let lastError = null;
      let shouldBreak = false;
      let confirmHandled = false;

      const urlBefore = pageState.metadata.url;

      for (let i = 0; i < Math.min(actions.length, MAX_ACTIONS_PER_STEP); i++) {
        if (!this.isRunning) {
          shouldBreak = true;
          break;
        }

        const action = actions[i];
        lastAction = action;

        if (TERMINAL_ACTIONS.has(action.type)) {
          shouldBreak = true;
          break;
        }

        if (action.type === "confirm") {
          if (onStepCallback) {
            onStepCallback({
              stepNumber,
              message: action.value || "Proceed with this action?",
              url: pageState.metadata.url,
              phase: "confirm_request",
            });
          }
          const approved = await new Promise((resolve) => {
            this._confirmResolver = resolve;
          });
          if (!this.isRunning) {
            shouldBreak = true;
            break;
          }
          const description = (response.reasoning && response.reasoning.trim()) || action.value || "unspecified action";
          if (approved) {
            const approvalRecord = {
              stepNumber,
              action: { type: "confirm_approved" },
              reasoning: "Researcher approved. Next step will perform the action.",
              observation: "",
              sentiment: "neutral",
              cleanScreenshot: pageState.cleanScreenshot,
              gesture: null,
              url: pageState.metadata.url,
              success: true,
              error: null,
              phase: "complete",
            };
            this.sessionHistory.push(approvalRecord);
            if (onStepCallback) onStepCallback(approvalRecord);
          } else {
            this.rejectedActions.push({
              step: stepNumber,
              description,
              url: pageState.metadata.url,
            });
            const rejectionRecord = {
              stepNumber,
              action: { type: "confirm_rejected" },
              reasoning: `Researcher REJECTED this action: "${description}". Do not retry, rephrase, or attempt a similar bypass.`,
              observation: "",
              sentiment: "neutral",
              cleanScreenshot: pageState.cleanScreenshot,
              gesture: null,
              url: pageState.metadata.url,
              success: false,
              error: "Researcher rejected — action was not performed",
              phase: "complete",
            };
            this.sessionHistory.push(rejectionRecord);
            if (onStepCallback) onStepCallback(rejectionRecord);
          }
          confirmHandled = true;
          break;
        }

        if (action.type === "scroll"
          && action.index === undefined
          && (typeof action.x !== "number" || typeof action.y !== "number")) {
          const dpr = pageState.devicePixelRatio || 1;
          action.x = Math.round((pageState.viewportWidth || 0) * dpr / 2);
          action.y = Math.round((pageState.viewportHeight || 0) * dpr / 2);
        }

        try {
          await this._executeAction(action);
          if (!this.isRunning) {
            shouldBreak = true;
            break;
          }
          if (action.type !== "wait") {
            await waitForPageSettle(this.tabId, this.abortController?.signal);
          }
        } catch (err) {
          console.error("[Agent] Action failed:", action.type, err.message);
          allSuccess = false;
          lastError = err.message;
          break;
        }

        if (i < actions.length - 1 && PAGE_CHANGING_ACTIONS.has(action.type)) {
          try {
            const currentMeta = await getPageMetadata(this.tabId);
            if (currentMeta.url !== urlBefore) {
              break;
            }
          } catch (err) {
            break;
          }
        }
      }

      this.loopDetector.addAction(actions[0], pageFingerprint);

      if (confirmHandled) {
        if (shouldBreak) break;
        continue;
      }

      if (allSuccess) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
      }

      const stepRecord = {
        stepNumber,
        action: lastAction,
        actionCount: Math.min(actions.length, MAX_ACTIONS_PER_STEP),
        reasoning: response.reasoning || "",
        observation: response.observation || "",
        sentiment: response.sentiment || "neutral",
        cleanScreenshot: pageState.cleanScreenshot,
        gesture: buildGesture(lastAction, pageState.devicePixelRatio),
        url: pageState.metadata.url,
        success: allSuccess,
        error: lastError,
        phase: "complete",
      };

      this.sessionHistory.push(stepRecord);
      if (onStepCallback) onStepCallback(stepRecord);

      if (shouldBreak || response.completed) {
        break;
      }

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new Error(`Stopping after ${MAX_CONSECUTIVE_FAILURES} consecutive failures`);
      }
    }
  }

  /**
   * Calls the LLM and retries once with a clarification if the response contains no actions.
   * @param {Array<Object>} userParts - The content blocks for the user turn.
   * @returns {Promise<Object>} The parsed LLM response.
   * @throws {Error} If the response cannot be parsed as JSON.
   */
  async _callLLMWithRetry(userParts) {
    const signal = this.abortController ? this.abortController.signal : undefined;
    const rawResponse = await this.claude.sendMessage(this.systemPrompt, userParts, signal);
    let response;
    try {
      response = JSON.parse(rawResponse);
    } catch (err) {
      throw new Error(`Failed to parse LLM response: ${err.message}`);
    }

    const actions = this._normalizeActions(response);
    if (actions.length > 0) {
      return response;
    }

    const retryParts = [
      ...userParts,
      { type: "text", text: "\n\nYou forgot to return an action in your response. You MUST include at least one action in the 'actions' array. Please try again with the same page state." },
    ];

    const retryRaw = await this.claude.sendMessage(this.systemPrompt, retryParts, signal);
    let retryResponse;
    try {
      retryResponse = JSON.parse(retryRaw);
    } catch (err) {
      throw new Error(`Failed to parse LLM retry response: ${err.message}`);
    }

    return retryResponse;
  }

  /**
   * Normalizes an LLM response to always return an actions array.
   * Supports both "action" (single object) and "actions" (array) formats.
   * @param {Object} response - The parsed LLM response.
   * @returns {Array<Object>} Array of action objects, possibly empty.
   */
  _normalizeActions(response) {
    let actions = [];
    if (response.actions && Array.isArray(response.actions) && response.actions.length > 0) {
      actions = response.actions;
    } else if (response.action && response.action.type) {
      actions = [response.action];
    }
    const firstConfirm = actions.find(function (a) { return a && a.type === "confirm"; });
    if (firstConfirm) {
      return [firstConfirm];
    }
    return actions;
  }

  /**
   * Dispatches a single action to the browser via CDP.
   * @param {Object} action - The action to execute.
   * @param {string} action.type - The action type (click, type, scroll, etc.).
   * @throws {Error} If the action type is unknown.
   */
  async _executeAction(action) {
    if (this.persona && this.persona.keyboardOnly && KEYBOARD_BLOCKED_ACTIONS.has(action.type)) {
      throw new Error(`${action.type} is not available — this persona navigates with the keyboard only. Use focus + keypress (Tab, Enter, Space, arrows).`);
    }
    switch (action.type) {
      case "click":
        if (action.index !== undefined) {
          await clickElement(this.tabId, action.index);
        } else {
          const scaled = scaleCoordinatesFromScreenshot(action.x, action.y);
          await dispatchClick(this.tabId, scaled.x, scaled.y);
        }
        break;

      case "double_click":
        if (action.index !== undefined) {
          await doubleClickElement(this.tabId, action.index);
        } else {
          const scaled = scaleCoordinatesFromScreenshot(action.x, action.y);
          await dispatchDoubleClick(this.tabId, scaled.x, scaled.y);
        }
        break;

      case "triple_click":
        if (action.index !== undefined) {
          await tripleClickElement(this.tabId, action.index);
        } else {
          const scaled = scaleCoordinatesFromScreenshot(action.x, action.y);
          await dispatchTripleClick(this.tabId, scaled.x, scaled.y);
        }
        break;

      case "type":
        await dispatchType(this.tabId, action.value);
        break;

      case "clear_and_type":
        await selectAllAndType(this.tabId, action.value);
        break;

      case "clear":
        await clearInput(this.tabId);
        break;

      case "keypress":
        await dispatchKeyPress(this.tabId, action.value);
        break;

      case "scroll": {
        let cssX, cssY;
        if (action.index !== undefined) {
          const center = resolveElementCoordinates(action.index);
          cssX = center.x;
          cssY = center.y;
        } else {
          const scaled = scaleCoordinatesFromScreenshot(action.x, action.y);
          cssX = scaled.x;
          cssY = scaled.y;
        }
        await dispatchScroll(
          this.tabId,
          cssX,
          cssY,
          action.deltaX || 0,
          action.deltaY || -300
        );
        break;
      }

      case "hover":
        if (action.index !== undefined) {
          await hoverElement(this.tabId, action.index);
        } else {
          const { dispatchHover } = await import("./cdp.js");
          const scaledHover = scaleCoordinatesFromScreenshot(action.x, action.y);
          await dispatchHover(this.tabId, scaledHover.x, scaledHover.y);
        }
        break;

      case "drag": {
        const from = resolveElementCoordinates(action.index);
        const scaledDrag = scaleCoordinatesFromScreenshot(action.x, action.y);
        await dispatchDragAndDrop(this.tabId, from.x, from.y, scaledDrag.x, scaledDrag.y);
        break;
      }

      case "focus":
        await focusElement(this.tabId, action.index);
        break;

      case "upload_file": {
        const fixtureName = String(action.value || "").trim();
        const fixture = UPLOAD_FIXTURES[fixtureName];
        if (!fixture) {
          throw new Error(`Unknown fixture "${fixtureName}". Available: ${Object.keys(UPLOAD_FIXTURES).join(", ")}`);
        }
        if (action.index === undefined) {
          throw new Error(`upload_file requires an element index pointing to the <input type="file"> (or a wrapper containing one)`);
        }
        const fileUrl = chrome.runtime.getURL(`fixtures/${fixtureName}`);
        await uploadFile(this.tabId, action.index, fileUrl, fixtureName, fixture.type);
        break;
      }

      case "select_option":
        await selectDropdownOption(this.tabId, action.index, action.value);
        break;

      case "go_back":
        await goBack(this.tabId);
        break;

      case "wait":
        await waitForPageSettle(this.tabId, this.abortController?.signal);
        break;

      case "done":
      case "fail":
        break;

      default:
        throw new Error(`Unknown action type: ${action.type}`);
    }
  }
}
