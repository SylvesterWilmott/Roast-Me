"use strict";

/* global chrome */

import ChromeUtils from "./promisify.js";

const CDP_VERSION = "1.3";

let elementMap = {};

let currentDPR = 1;
let currentViewportWidth = 0;
let currentViewportHeight = 0;
let currentLLMImageWidth = 0;
let currentLLMImageHeight = 0;

let offscreenCounts = { above: 0, below: 0 };

let pendingRequests = 0;
let networkEnabled = false;

let mainFrameId = null;
let approvedOrigin = null;
let blockedNavigations = [];

/**
 * Returns the current interactive element map.
 * @returns {Object} Map of element index to element data with bounding boxes.
 */
export function getElementMap() {
  return elementMap;
}

/**
 * Returns the counts of offscreen interactive elements above and below the viewport.
 * @returns {{above: number, below: number}} Offscreen element counts for scroll hints.
 */
export function getOffscreenCounts() {
  return offscreenCounts;
}

/**
 * Returns the current device pixel ratio used for coordinate scaling.
 * @returns {number} The device pixel ratio value.
 */
export function getDevicePixelRatioValue() {
  return currentDPR;
}

/**
 * Attaches the Chrome debugger to a tab and enables required CDP domains.
 * @param {number} tabId - The ID of the tab to attach the debugger to.
 * @returns {Promise<void>}
 */
export async function attachDebugger(tabId) {
  await ChromeUtils.debuggerAttach({ tabId }, CDP_VERSION);
  await sendCommand(tabId, "Page.enable");
  await sendCommand(tabId, "Runtime.enable");
  await sendCommand(tabId, "DOM.enable");
  await sendCommand(tabId, "Accessibility.enable");
  await sendCommand(tabId, "Network.enable");
  networkEnabled = true;
  pendingRequests = 0;

  try {
    const tree = await sendCommand(tabId, "Page.getFrameTree");
    mainFrameId = tree.frameTree?.frame?.id || null;
  } catch (err) {
    mainFrameId = null;
  }

  await sendCommand(tabId, "Fetch.enable", {
    patterns: [{ resourceType: "Document", requestStage: "Request" }],
  });

  chrome.debugger.onEvent.addListener(handleDebuggerEvent);
}

/**
 * Detaches the Chrome debugger from a tab and cleans up event listeners.
 * @param {number} tabId - The ID of the tab to detach the debugger from.
 * @returns {Promise<void>}
 */
export async function detachDebugger(tabId) {
  chrome.debugger.onEvent.removeListener(handleDebuggerEvent);
  networkEnabled = false;
  pendingRequests = 0;
  mainFrameId = null;
  approvedOrigin = null;
  blockedNavigations = [];
  try {
    await ChromeUtils.debuggerDetach({ tabId });
  } catch (err) {
  }
}

/**
 * Sets the origin that the agent is allowed to operate on. Cross-origin top-frame
 * navigations are cancelled at the network layer via Fetch.failRequest.
 * @param {string|null} origin
 */
export function setApprovedOrigin(origin) {
  approvedOrigin = origin || null;
}

/**
 * Returns and clears the list of top-frame navigations that have been blocked
 * since the last call.
 * @returns {Array<{url: string, origin: string}>}
 */
export function consumeBlockedNavigations() {
  const blocked = blockedNavigations;
  blockedNavigations = [];
  return blocked;
}

/**
 * Tracks in-flight network requests for page settle detection and intercepts
 * top-frame document navigations to enforce the origin lock.
 * @param {Object} source - The debugger event source.
 * @param {string} method - The CDP event method name.
 * @param {Object} [params] - The CDP event parameters.
 */
function handleDebuggerEvent(source, method, params) {
  if (method === "Network.requestWillBeSent") {
    pendingRequests++;
  } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
    pendingRequests = Math.max(0, pendingRequests - 1);
  } else if (method === "Fetch.requestPaused") {
    handleFetchPaused(source.tabId, params);
  }
}

/**
 * Handles a paused top-frame document request. Allows same-origin navigations
 * (and all subframe requests) through; cancels cross-origin top-frame navigations.
 * @param {number} tabId
 * @param {Object} params - The Fetch.requestPaused event parameters.
 */
function handleFetchPaused(tabId, params) {
  const requestId = params.requestId;
  const url = params.request?.url || "";
  const frameId = params.frameId;

  const isMainFrame = mainFrameId && frameId === mainFrameId;

  if (!isMainFrame || !approvedOrigin) {
    sendCommand(tabId, "Fetch.continueRequest", { requestId }).catch(function () {});
    return;
  }

  let targetOrigin = null;
  try {
    targetOrigin = new URL(url).origin;
  } catch (err) {
  }

  if (!targetOrigin || targetOrigin === approvedOrigin) {
    sendCommand(tabId, "Fetch.continueRequest", { requestId }).catch(function () {});
    return;
  }

  blockedNavigations.push({ url, origin: targetOrigin });
  sendCommand(tabId, "Fetch.failRequest", {
    requestId,
    errorReason: "Aborted",
  }).catch(function () {});
}

/**
 * Sends a CDP command to a tab via the Chrome debugger.
 * @param {number} tabId - The ID of the target tab.
 * @param {string} method - The CDP method to invoke.
 * @param {Object} [params={}] - Parameters for the CDP command.
 * @returns {Promise<Object>} The CDP command result.
 */
function sendCommand(tabId, method, params = {}) {
  return ChromeUtils.debuggerSendCommand({ tabId }, method, params);
}

/**
 * Captures a PNG screenshot of the visible area of a tab.
 * @param {number} tabId - The ID of the tab to capture.
 * @returns {Promise<string>} Base64-encoded PNG screenshot data.
 */
export async function captureScreenshot(tabId) {
  const result = await sendCommand(tabId, "Page.captureScreenshot", {
    format: "png",
    quality: 80,
  });
  return result.data;
}

/**
 * Retrieves the current URL and title of a tab.
 * @param {number} tabId - The ID of the tab to query.
 * @returns {Promise<{url: string, title: string, consoleErrors: Array}>} Page metadata.
 */
export async function getPageMetadata(tabId) {
  const urlResult = await sendCommand(tabId, "Runtime.evaluate", {
    expression: "JSON.stringify({ url: document.URL, title: document.title })",
    returnByValue: true,
  });

  let metadata = { url: "", title: "", consoleErrors: [] };
  try {
    const parsed = JSON.parse(urlResult.result.value);
    metadata.url = parsed.url;
    metadata.title = parsed.title;
  } catch (err) {
  }

  return metadata;
}

/**
 * Fetches the device pixel ratio from the tab's window.
 * @param {number} tabId - The ID of the tab to query.
 * @returns {Promise<number>} The device pixel ratio, defaulting to 1 on failure.
 */
async function fetchDevicePixelRatio(tabId) {
  try {
    const result = await sendCommand(tabId, "Runtime.evaluate", {
      expression: "window.devicePixelRatio",
      returnByValue: true,
    });
    return result.result?.value || 1;
  } catch (err) {
    return 1;
  }
}

/**
 * Scales raw screenshot coordinates to CSS pixels using the current device pixel ratio.
 * @param {number} x - The x coordinate from the screenshot.
 * @param {number} y - The y coordinate from the screenshot.
 * @returns {{x: number, y: number}} Scaled coordinates in CSS pixels.
 */
export function scaleCoordinatesFromScreenshot(x, y) {
  if (currentLLMImageWidth > 0 && currentLLMImageHeight > 0
    && currentViewportWidth > 0 && currentViewportHeight > 0) {
    return {
      x: Math.round((x / currentLLMImageWidth) * currentViewportWidth),
      y: Math.round((y / currentLLMImageHeight) * currentViewportHeight),
    };
  }
  return {
    x: Math.round(x / currentDPR),
    y: Math.round(y / currentDPR),
  };
}

/**
 * Records the pixel dimensions of the image actually sent to the LLM so that
 * coordinate-based actions from the agent can be scaled back to CSS pixels.
 * @param {number} width
 * @param {number} height
 */
export function setLLMImageSize(width, height) {
  currentLLMImageWidth = width || 0;
  currentLLMImageHeight = height || 0;
}

const INTERACTIVE_TAGS = new Set([
  "a", "button", "input", "select", "textarea", "details", "summary",
  "option", "optgroup",
]);

const INTERACTIVE_ROLES = new Set([
  "button", "link", "textbox", "searchbox", "combobox", "listbox",
  "option", "checkbox", "radio", "switch", "slider", "spinbutton",
  "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem",
]);

const EVENT_HANDLER_ATTRS = new Set([
  "onclick", "onmousedown", "onmouseup", "onkeydown", "onkeyup",
  "ontouchstart", "ontouchend", "onpointerdown", "onpointerup",
]);

const STRUCTURAL_TAGS = new Set([
  "form", "nav", "header", "footer", "main", "aside", "section",
  "dialog", "article", "fieldset",
]);

/**
 * Builds an index of the full DOM tree mapping backend node IDs to tag, parent, and depth.
 * @param {Object} rootNode - The root DOM node from DOM.getDocument.
 * @returns {Map<number, {tag: string, parentBackendId: number, depth: number}>} The DOM index.
 */
function buildDOMIndex(rootNode) {
  const index = new Map();

  /**
   * Recursively walks the DOM tree to populate the index.
   * @param {Object} node - The current DOM node.
   * @param {number} parentBackendId - The backend node ID of the parent.
   * @param {number} depth - The current depth in the tree.
   */
  function walk(node, parentBackendId, depth) {
    const bnId = node.backendNodeId;
    const tag = (node.localName || node.nodeName || "").toLowerCase();

    if (bnId) {
      index.set(bnId, {
        tag,
        parentBackendId: parentBackendId || 0,
        depth,
      });
    }

    for (const child of (node.children || [])) {
      walk(child, bnId, depth + 1);
    }
    if (node.shadowRoots) {
      for (const sr of node.shadowRoots) {
        walk(sr, bnId, depth + 1);
      }
    }
    if (node.contentDocument) {
      walk(node.contentDocument, bnId, depth + 1);
    }
  }

  walk(rootNode, 0, 0);
  return index;
}

/**
 * Finds the nearest structural ancestor (form, nav, section, etc.) for tree grouping.
 * @param {Map} domIndex - The DOM index built by buildDOMIndex.
 * @param {number} backendNodeId - The backend node ID to search from.
 * @returns {{tag: string, backendNodeId: number}|null} The structural ancestor or null.
 */
function findStructuralAncestor(domIndex, backendNodeId) {
  let nodeInfo = domIndex.get(backendNodeId);
  if (!nodeInfo) return null;

  let current = nodeInfo.parentBackendId;
  while (current) {
    const parent = domIndex.get(current);
    if (!parent) break;
    if (STRUCTURAL_TAGS.has(parent.tag)) {
      return { tag: parent.tag, backendNodeId: current };
    }
    current = parent.parentBackendId;
  }
  return null;
}

const JS_CLICK_EVENTS = new Set(["click", "mousedown", "mouseup", "pointerdown", "pointerup"]);
const MAX_JS_LISTENER_CHECKS = 30;

/**
 * Detects all interactive elements on a page using multiple sources and builds an indexed element map.
 * @param {number} tabId - The ID of the tab to analyze.
 * @returns {Promise<Object>} Map of element index to element data with bounding boxes and metadata.
 */
export async function buildElementMap(tabId) {
  elementMap = {};
  offscreenCounts = { above: 0, below: 0 };

  currentDPR = await fetchDevicePixelRatio(tabId);

  const [snapshotResult, axData, heuristicResult, domDoc] = await Promise.all([
    captureDOMSnapshot(tabId),
    captureAccessibilityData(tabId),
    captureDOMHeuristics(tabId),
    sendCommand(tabId, "DOM.getDocument", { depth: -1, pierce: true }).catch(function () { return { root: null }; }),
  ]);

  const domSnapshotData = snapshotResult.elements;
  const domHeuristicData = heuristicResult.interactive;
  const heuristicPotentials = heuristicResult.potentials;

  const domIndex = domDoc.root ? buildDOMIndex(domDoc.root) : new Map();

  const candidateMap = new Map();

  for (const el of domSnapshotData) {
    candidateMap.set(el.backendNodeId, {
      backendNodeId: el.backendNodeId,
      tag: el.tag,
      name: el.name || "",
      role: el.role || "",
      description: "",
      value: el.value || "",
      props: {},
      boundingBox: el.boundingBox,
      inputType: el.inputType || "",
      options: [],
      textContent: "",
      source: "snapshot",
    });
  }

  for (const el of axData) {
    if (candidateMap.has(el.backendNodeId)) {
      const existing = candidateMap.get(el.backendNodeId);
      existing.role = el.role || existing.role;
      existing.name = el.name || existing.name;
      existing.description = el.description || existing.description;
      existing.value = el.value || existing.value;
      existing.props = el.props;
    } else {
      candidateMap.set(el.backendNodeId, {
        backendNodeId: el.backendNodeId,
        tag: "",
        name: el.name || "",
        role: el.role || "",
        description: el.description || "",
        value: el.value || "",
        props: el.props,
        boundingBox: null,
        inputType: "",
        options: [],
        textContent: "",
        source: "ax",
      });
    }
  }

  for (const el of domHeuristicData) {
    if (candidateMap.has(el.backendNodeId)) {
      const existing = candidateMap.get(el.backendNodeId);
      existing.tag = el.tag || existing.tag;
      existing.name = existing.name || el.name || "";
      existing.inputType = existing.inputType || el.inputType || "";
      if (el.options && el.options.length > 0 && existing.options.length === 0) {
        existing.options = el.options;
      }
      if (el.textContent && !existing.textContent) {
        existing.textContent = el.textContent;
      }
    } else {
      candidateMap.set(el.backendNodeId, {
        backendNodeId: el.backendNodeId,
        tag: el.tag,
        name: el.name || "",
        role: el.role || "",
        description: "",
        value: "",
        props: {},
        boundingBox: el.boundingBox,
        inputType: el.inputType || "",
        options: el.options || [],
        textContent: el.textContent || "",
        source: "heuristic",
      });
    }
  }

  let jsChecks = 0;
  for (const pot of heuristicPotentials) {
    if (jsChecks >= MAX_JS_LISTENER_CHECKS) break;
    if (!pot.boundingBox) continue;

    let potBackendNodeId;
    try {
      const nodeResult = await sendCommand(tabId, "DOM.getNodeForLocation", {
        x: Math.round(pot.boundingBox.x),
        y: Math.round(pot.boundingBox.y),
        includeUserAgentShadowDOM: false,
      });
      potBackendNodeId = nodeResult.backendNodeId;
    } catch (err) {
      continue;
    }

    if (!potBackendNodeId || candidateMap.has(potBackendNodeId)) continue;

    jsChecks++;
    try {
      const resolved = await sendCommand(tabId, "DOM.resolveNode", { backendNodeId: potBackendNodeId });
      if (!resolved.object?.objectId) continue;

      const listenersResult = await sendCommand(tabId, "DOMDebugger.getEventListeners", {
        objectId: resolved.object.objectId,
      });

      await sendCommand(tabId, "Runtime.releaseObject", {
        objectId: resolved.object.objectId,
      }).catch(function () {});

      const hasClickListener = (listenersResult.listeners || []).some(function (l) {
        return JS_CLICK_EVENTS.has(l.type);
      });

      if (hasClickListener) {
        candidateMap.set(potBackendNodeId, {
          backendNodeId: potBackendNodeId,
          tag: pot.tag || "",
          name: pot.name || "",
          role: "",
          description: "",
          value: "",
          props: {},
          boundingBox: pot.boundingBox,
          inputType: "",
          options: [],
          textContent: pot.textContent || "",
          source: "js-listener",
        });
      }
    } catch (err) {
    }
  }

  const visibleCandidates = [];

  for (const [backendNodeId, el] of candidateMap) {
    if (!el.boundingBox) {
      try {
        const boxModel = await sendCommand(tabId, "DOM.getBoxModel", {
          backendNodeId,
        });
        if (boxModel.model) {
          const c = boxModel.model.content;
          const x = (c[0] + c[2] + c[4] + c[6]) / 4;
          const y = (c[1] + c[3] + c[5] + c[7]) / 4;
          const width = Math.abs(c[2] - c[0]);
          const height = Math.abs(c[5] - c[1]);
          if (width === 0 && height === 0) continue;
          el.boundingBox = { x, y, width, height };
        } else {
          continue;
        }
      } catch (err) {
        continue;
      }
    }

    if (!el.tag) {
      try {
        const resolved = await sendCommand(tabId, "DOM.describeNode", { backendNodeId });
        el.tag = resolved.node?.nodeName?.toLowerCase() || "";
      } catch (err) {
      }
    }

    try {
      const resolvedNode = await sendCommand(tabId, "DOM.resolveNode", { backendNodeId });
      if (resolvedNode.object?.objectId) {
        const visCheck = await sendCommand(tabId, "Runtime.callFunctionOn", {
          objectId: resolvedNode.object.objectId,
          functionDeclaration: `function() {
            const style = window.getComputedStyle(this);
            if (style.display === 'none') return 'hidden';
            if (style.visibility === 'hidden') return 'hidden';
            if (parseFloat(style.opacity) === 0) {
              if (this.tagName === 'INPUT' && this.type === 'file') return 'visible';
              return 'hidden';
            }
            const rect = this.getBoundingClientRect();
            if (rect.bottom < 0) return 'offscreen-above';
            if (rect.top > window.innerHeight) return 'offscreen-below';
            if (rect.right < 0 || rect.left > window.innerWidth) return 'offscreen-side';
            return 'visible';
          }`,
          returnByValue: true,
        });
        const visibility = visCheck.result?.value;

        if (visibility === "hidden") {
          await sendCommand(tabId, "Runtime.releaseObject", {
            objectId: resolvedNode.object.objectId,
          }).catch(function () {});
          continue;
        }
        if (visibility === "offscreen-above") {
          offscreenCounts.above++;
          await sendCommand(tabId, "Runtime.releaseObject", {
            objectId: resolvedNode.object.objectId,
          }).catch(function () {});
          continue;
        }
        if (visibility === "offscreen-below") {
          offscreenCounts.below++;
          await sendCommand(tabId, "Runtime.releaseObject", {
            objectId: resolvedNode.object.objectId,
          }).catch(function () {});
          continue;
        }
        if (visibility === "offscreen-side") {
          await sendCommand(tabId, "Runtime.releaseObject", {
            objectId: resolvedNode.object.objectId,
          }).catch(function () {});
          continue;
        }

        await sendCommand(tabId, "Runtime.releaseObject", {
          objectId: resolvedNode.object.objectId,
        }).catch(function () {});
      }
    } catch (err) {
    }

    visibleCandidates.push(el);
  }

  const afterOcclusion = [];
  const candidateNodeIds = new Set(visibleCandidates.map(function (el) { return el.backendNodeId; }));

  for (const el of visibleCandidates) {
    let occluded = false;
    try {
      const hitResult = await sendCommand(tabId, "DOM.getNodeForLocation", {
        x: Math.round(el.boundingBox.x),
        y: Math.round(el.boundingBox.y),
        includeUserAgentShadowDOM: false,
      });
      const hitId = hitResult.backendNodeId;
      if (hitId && hitId !== el.backendNodeId && candidateNodeIds.has(hitId)) {
        occluded = true;
      }
    } catch (err) {
    }
    if (!occluded) {
      afterOcclusion.push(el);
    }
  }

  const afterContainment = filterContainedElements(afterOcclusion);

  let index = 1;
  for (const el of afterContainment) {
    const ancestor = findStructuralAncestor(domIndex, el.backendNodeId);

    elementMap[index] = {
      index,
      backendDOMNodeId: el.backendNodeId,
      boundingBox: el.boundingBox,
      role: el.role,
      name: el.name,
      description: el.description,
      value: el.value,
      tag: el.tag,
      props: el.props,
      inputType: el.inputType,
      options: el.options,
      textContent: el.textContent,
      structuralContext: ancestor ? ancestor.tag : null,
    };
    index++;
  }

  return elementMap;
}

const CONTAINMENT_KEEP_TAGS = new Set(["input", "select", "textarea", "button"]);
const CONTAINMENT_KEEP_ROLES = new Set([
  "textbox", "searchbox", "combobox", "listbox", "checkbox",
  "radio", "switch", "slider", "spinbutton",
]);

/**
 * Determines whether a geometrically contained element should be kept in the element map.
 * @param {Object} el - The element to evaluate.
 * @returns {boolean} True if the element should be kept despite being contained.
 */
function shouldKeepContainedElement(el) {
  if (CONTAINMENT_KEEP_TAGS.has(el.tag)) return true;
  if (el.name && el.name.length > 0) return true;
  if (CONTAINMENT_KEEP_ROLES.has(el.role)) return true;
  return false;
}

/**
 * Filters out elements whose bounding boxes are 90% or more contained within a larger interactive element.
 * @param {Array<Object>} elements - The list of candidate elements to filter.
 * @returns {Array<Object>} The filtered list with contained duplicates removed.
 */
function filterContainedElements(elements) {
  if (elements.length <= 1) return elements;

  const sorted = [...elements].sort(function (a, b) {
    const areaA = a.boundingBox.width * a.boundingBox.height;
    const areaB = b.boundingBox.width * b.boundingBox.height;
    return areaB - areaA;
  });

  const kept = [];
  const keptData = [];

  for (const el of sorted) {
    const elArea = el.boundingBox.width * el.boundingBox.height;
    let contained = false;

    for (const parent of keptData) {
      if (parent.area > elArea * 4) continue;

      if (bboxContainment(el.boundingBox, parent.box) >= 0.90) {
        if (!shouldKeepContainedElement(el)) {
          contained = true;
          break;
        }
      }
    }
    if (!contained) {
      kept.push(el);
      keptData.push({ box: el.boundingBox, area: elArea });
    }
  }

  return kept;
}

/**
 * Calculates the fraction of an inner bounding box's area that overlaps with an outer bounding box.
 * @param {{x: number, y: number, width: number, height: number}} innerBox - The inner bounding box (center-based).
 * @param {{x: number, y: number, width: number, height: number}} outerBox - The outer bounding box (center-based).
 * @returns {number} The containment ratio from 0 to 1.
 */
function bboxContainment(innerBox, outerBox) {
  const iLeft = innerBox.x - innerBox.width / 2;
  const iTop = innerBox.y - innerBox.height / 2;
  const iRight = iLeft + innerBox.width;
  const iBottom = iTop + innerBox.height;

  const oLeft = outerBox.x - outerBox.width / 2;
  const oTop = outerBox.y - outerBox.height / 2;
  const oRight = oLeft + outerBox.width;
  const oBottom = oTop + outerBox.height;

  const interLeft = Math.max(iLeft, oLeft);
  const interTop = Math.max(iTop, oTop);
  const interRight = Math.min(iRight, oRight);
  const interBottom = Math.min(iBottom, oBottom);

  if (interLeft >= interRight || interTop >= interBottom) return 0;

  const interArea = (interRight - interLeft) * (interBottom - interTop);
  const innerArea = innerBox.width * innerBox.height;

  if (innerArea === 0) return 0;
  return interArea / innerArea;
}

/**
 * Captures a DOM snapshot using Chrome's native is_clickable detection.
 * @param {number} tabId - The ID of the tab to snapshot.
 * @returns {Promise<{elements: Array<Object>}>} The snapshot elements with bounding boxes.
 */
async function captureDOMSnapshot(tabId) {
  const elements = [];

  try {
    const snapshot = await sendCommand(tabId, "DOMSnapshot.captureSnapshot", {
      computedStyles: ["display", "visibility", "opacity", "cursor", "pointer-events"],
      includeDOMRects: true,
      includePaintOrder: true,
    });

    const docs = snapshot.documents || [];
    if (docs.length === 0) return { elements };

    const doc = docs[0];
    const nodes = doc.nodes || {};
    const layout = doc.layout || {};

    const backendNodeIds = nodes.backendNodeId || [];
    const nodeNames = nodes.nodeName || [];
    const attrs = nodes.attributes || [];
    const isClickable = nodes.isClickable || [];

    const layoutNodeIndex = layout.nodeIndex || [];
    const layoutBounds = layout.bounds || [];

    const boundsMap = new Map();
    for (let i = 0; i < layoutNodeIndex.length; i++) {
      boundsMap.set(layoutNodeIndex[i], layoutBounds[i]);
    }

    const strings = snapshot.strings || [];

    for (let i = 0; i < backendNodeIds.length; i++) {
      if (!isClickable || !isClickable[i]) continue;

      const backendNodeId = backendNodeIds[i];
      const tag = (strings[nodeNames[i]] || "").toLowerCase();
      const bounds = boundsMap.get(i);

      if (!bounds) continue;

      const x = bounds[0] + bounds[2] / 2;
      const y = bounds[1] + bounds[3] / 2;
      const width = bounds[2];
      const height = bounds[3];

      if (width === 0 && height === 0) continue;

      let name = "";
      let inputType = "";
      const elAttrs = attrs[i] || [];
      for (let j = 0; j < elAttrs.length; j += 2) {
        const attrName = strings[elAttrs[j]] || "";
        const attrValue = strings[elAttrs[j + 1]] || "";
        if (attrName === "aria-label") name = attrValue;
        else if (attrName === "title" && !name) name = attrValue;
        else if (attrName === "alt" && !name) name = attrValue;
        else if (attrName === "placeholder" && !name) name = attrValue;
        if (attrName === "type") inputType = attrValue.toLowerCase();
      }

      elements.push({
        backendNodeId,
        tag,
        name,
        role: "",
        value: "",
        inputType,
        boundingBox: { x, y, width, height },
      });
    }
  } catch (err) {
  }

  return { elements };
}

/**
 * Captures the accessibility tree and extracts interactive elements with semantic roles and properties.
 * @param {number} tabId - The ID of the tab to query.
 * @returns {Promise<Array<Object>>} Interactive elements from the accessibility tree.
 */
async function captureAccessibilityData(tabId) {
  const results = [];

  try {
    const axResult = await sendCommand(tabId, "Accessibility.getFullAXTree");
    const nodes = axResult.nodes || [];

    for (const node of nodes) {
      if (node.ignored) continue;

      const role = node.role?.value || "";
      if (!role || role === "none" || role === "generic" || role === "InlineTextBox" || role === "LineBreak") {
        continue;
      }

      const isInteractiveRole = INTERACTIVE_ROLES.has(role);
      const isFocusable = node.properties?.some(
        (p) => p.name === "focusable" && p.value?.value === true
      );

      if (!isInteractiveRole && !isFocusable) continue;
      if (!node.backendDOMNodeId) continue;

      const props = {};
      for (const prop of (node.properties || [])) {
        if (prop.name === "disabled" && prop.value?.value) props.disabled = true;
        if (prop.name === "checked") props.checked = prop.value?.value;
        if (prop.name === "expanded") props.expanded = prop.value?.value;
        if (prop.name === "selected" && prop.value?.value) props.selected = true;
        if (prop.name === "required" && prop.value?.value) props.required = true;
        if (prop.name === "readonly" && prop.value?.value) props.readonly = true;
      }

      results.push({
        backendNodeId: node.backendDOMNodeId,
        role,
        name: node.name?.value || "",
        description: node.description?.value || "",
        value: node.value?.value || "",
        props,
      });
    }
  } catch (err) {
  }

  return results;
}

/**
 * Detects interactive elements via injected DOM heuristics including event handlers, cursor style, tabindex, and ARIA roles.
 * @param {number} tabId - The ID of the tab to analyze.
 * @returns {Promise<{interactive: Array<Object>, potentials: Array<Object>}>} Detected interactive elements and potential candidates for JS listener checks.
 */
async function captureDOMHeuristics(tabId) {
  try {
    const result = await sendCommand(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const results = [];
        const potentials = [];
        const seen = new Set();
        const SKIP_TAGS = new Set(['html','body','head','script','style','meta','link','br','hr','noscript']);

        const INTERACTIVE_TAGS = new Set([
          'a', 'button', 'input', 'select', 'textarea', 'details', 'summary',
          'option', 'optgroup'
        ]);
        const EVENT_ATTRS = new Set([
          'onclick', 'onmousedown', 'onmouseup', 'onkeydown', 'onkeyup',
          'ontouchstart', 'ontouchend', 'onpointerdown', 'onpointerup'
        ]);
        const INTERACTIVE_ARIA_ROLES = new Set([
          'button', 'link', 'menuitem', 'tab', 'checkbox', 'radio',
          'switch', 'slider', 'combobox', 'option', 'treeitem',
          'menuitemcheckbox', 'menuitemradio'
        ]);

        function checkElement(el) {
          if (seen.has(el)) return;
          if (el.nodeType !== 1) return;

          const tag = el.tagName.toLowerCase();
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return;

          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return;
          if (parseFloat(style.opacity) === 0 && !(tag === 'input' && el.type === 'file')) return;

          if (rect.bottom < 0 || rect.top > window.innerHeight) return;
          if (rect.right < 0 || rect.left > window.innerWidth) return;

          let isInteractive = false;
          let reason = '';

          if (INTERACTIVE_TAGS.has(tag)) {
            isInteractive = true;
            reason = 'tag';
          }

          if (!isInteractive) {
            for (const attr of EVENT_ATTRS) {
              if (el.hasAttribute(attr)) {
                isInteractive = true;
                reason = 'event-attr';
                break;
              }
            }
          }

          if (!isInteractive) {
            const role = el.getAttribute('role');
            if (role && INTERACTIVE_ARIA_ROLES.has(role)) {
              isInteractive = true;
              reason = 'aria-role';
            }
          }

          if (!isInteractive && el.hasAttribute('tabindex')) {
            const tabindex = parseInt(el.getAttribute('tabindex'), 10);
            if (tabindex >= 0) {
              isInteractive = true;
              reason = 'tabindex';
            }
          }

          if (!isInteractive && style.cursor === 'pointer') {
            if (rect.width >= 10 && rect.height >= 10) {
              isInteractive = true;
              reason = 'cursor';
            }
          }

          if (!isInteractive && el.isContentEditable && el.getAttribute('contenteditable') !== 'false') {
            isInteractive = true;
            reason = 'contenteditable';
          }

          if (!isInteractive) {
            // Not interactive by any known signal — collect as potential
            // for JS event listener detection via CDP.
            // Only collect visible, non-tiny elements with content or classes.
            if (potentials.length < 50 && !SKIP_TAGS.has(tag)
                && rect.width >= 10 && rect.height >= 10) {
              const hasText = (el.textContent || '').trim().length > 0;
              const hasClass = el.className && typeof el.className === 'string' && el.className.length > 0;
              if (hasText || hasClass) {
                potentials.push({
                  tag: tag,
                  name: el.getAttribute('aria-label') || '',
                  textContent: (el.textContent || '').trim().substring(0, 80),
                  rect: {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                    width: rect.width,
                    height: rect.height,
                  },
                });
              }
            }
            return;
          }
          seen.add(el);

          const name = el.getAttribute('aria-label')
            || el.getAttribute('title')
            || el.getAttribute('alt')
            || el.getAttribute('placeholder')
            || '';

          // Collect text content (not for inputs — use placeholder/label instead)
          let textContent = '';
          if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') {
            textContent = (el.textContent || '').trim().substring(0, 100);
          }

          // Collect input type
          let inputType = '';
          if (tag === 'input') {
            inputType = (el.type || 'text').toLowerCase();
          }

          // Collect select options
          let options = [];
          if (tag === 'select') {
            options = Array.from(el.options || [])
              .map(function(o) { return o.textContent.trim(); })
              .filter(function(t) { return t.length > 0; })
              .slice(0, 20);
          }

          results.push({
            tag: tag,
            name: name || textContent.substring(0, 80) || '',
            role: el.getAttribute('role') || '',
            reason: reason,
            inputType: inputType,
            options: options,
            textContent: textContent,
            rect: {
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              width: rect.width,
              height: rect.height,
            },
          });
        }

        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          checkElement(el);
        }

        return JSON.stringify({ interactive: results, potentials: potentials });
      })()`,
      returnByValue: true,
    });

    const parsed = JSON.parse(result.result.value);
    const interactiveRaw = parsed.interactive || [];
    const potentialsRaw = parsed.potentials || [];

    const heuristicElements = [];
    for (const el of interactiveRaw) {
      heuristicElements.push({
        backendNodeId: null,
        tag: el.tag,
        name: el.name,
        role: el.role,
        boundingBox: el.rect,
        reason: el.reason,
        inputType: el.inputType,
        options: el.options,
        textContent: el.textContent,
      });
    }

    for (const el of heuristicElements) {
      if (!el.boundingBox) continue;
      try {
        const nodeResult = await sendCommand(tabId, "DOM.getNodeForLocation", {
          x: Math.round(el.boundingBox.x),
          y: Math.round(el.boundingBox.y),
          includeUserAgentShadowDOM: false,
        });
        el.backendNodeId = nodeResult.backendNodeId;
      } catch (err) {
      }
    }

    const potentials = potentialsRaw.map(function (el) {
      return {
        tag: el.tag,
        name: el.name || "",
        textContent: el.textContent || "",
        boundingBox: el.rect,
      };
    });

    return {
      interactive: heuristicElements.filter(function (el) {
        return el.backendNodeId != null;
      }),
      potentials,
    };
  } catch (err) {
    return { interactive: [], potentials: [] };
  }
}

const TAG_COLORS = {
  button: "#FF6B6B",
  input: "#4ECDC4",
  select: "#45B7D1",
  a: "#96CEB4",
  textarea: "#FF8C42",
};
const DEFAULT_COLOR = "#9B59B6";

/**
 * Injects temporary visual annotations (colored bounding boxes and index labels) onto page elements.
 * @param {number} tabId - The ID of the tab to annotate.
 * @param {Object} map - The element map with index keys and bounding box data.
 * @returns {Promise<void>}
 */
export async function annotateElements(tabId, map) {
  const elements = Object.values(map);
  if (elements.length === 0) return;

  const annotations = elements.map(function (el) {
    const bb = el.boundingBox;
    const left = bb.x - bb.width / 2;
    const top = bb.y - bb.height / 2;
    return {
      index: el.index,
      left: Math.max(0, Math.round(left)),
      top: Math.max(0, Math.round(top)),
      width: Math.round(bb.width),
      height: Math.round(bb.height),
      color: TAG_COLORS[el.tag] || DEFAULT_COLOR,
    };
  });

  const annotationJSON = JSON.stringify(annotations);

  await sendCommand(tabId, "Runtime.evaluate", {
    expression: `(() => {
      const existing = document.getElementById('__ux_test_overlay__');
      if (existing) existing.remove();

      const container = document.createElement('div');
      container.id = '__ux_test_overlay__';
      container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:2147483647;';

      const annotations = ${annotationJSON};

      for (const a of annotations) {
        const box = document.createElement('div');
        box.style.cssText = 'position:absolute;pointer-events:none;'
          + 'border:2px dashed ' + a.color + ';'
          + 'left:' + a.left + 'px;top:' + a.top + 'px;'
          + 'width:' + a.width + 'px;height:' + a.height + 'px;';

        const label = document.createElement('span');
        label.textContent = a.index;
        const labelPos = a.height < 20 ? 'top:-14px;left:50%;transform:translateX(-50%);' : 'top:2px;left:2px;';
        label.style.cssText = 'position:absolute;' + labelPos
          + 'background:' + a.color + ';color:#fff;font:bold 10px/1 monospace;'
          + 'padding:1px 4px;border-radius:2px;pointer-events:none;white-space:nowrap;';

        box.appendChild(label);
        container.appendChild(box);
      }

      document.documentElement.appendChild(container);
    })()`,
    returnByValue: true,
  });
}

/**
 * Injects a CSS filter on the documentElement and optional SVG filter defs,
 * used to simulate color-blindness / low-vision for the annotated screenshot only.
 * @param {number} tabId - The tab ID.
 * @param {{css?: string, svg?: string}} filter - The filter config.
 * @returns {Promise<void>}
 */
export async function applyVisionFilter(tabId, filter) {
  const css = filter && filter.css ? String(filter.css) : "";
  const svg = filter && filter.svg ? String(filter.svg) : "";
  const expression = `(() => {
    const existing = document.getElementById('__ux_vision_filter__');
    if (existing) existing.remove();
    const existingSvg = document.getElementById('__ux_vision_svg__');
    if (existingSvg) existingSvg.remove();

    if (${JSON.stringify(svg)}) {
      const svgWrap = document.createElement('div');
      svgWrap.id = '__ux_vision_svg__';
      svgWrap.style.cssText = 'position:fixed;width:0;height:0;overflow:hidden;pointer-events:none;';
      svgWrap.innerHTML = ${JSON.stringify(svg)};
      document.documentElement.appendChild(svgWrap);
    }

    if (${JSON.stringify(css)}) {
      const style = document.createElement('style');
      style.id = '__ux_vision_filter__';
      style.textContent = 'html{filter:' + ${JSON.stringify(css)} + ' !important;}';
      document.documentElement.appendChild(style);
    }
  })()`;
  await sendCommand(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
  });
}

/**
 * Removes any vision-sim filter injected by applyVisionFilter.
 * @param {number} tabId - The tab ID.
 * @returns {Promise<void>}
 */
export async function removeVisionFilter(tabId) {
  await sendCommand(tabId, "Runtime.evaluate", {
    expression: `(() => {
      const style = document.getElementById('__ux_vision_filter__');
      if (style) style.remove();
      const svg = document.getElementById('__ux_vision_svg__');
      if (svg) svg.remove();
    })()`,
    returnByValue: true,
  });
}

/**
 * Removes all annotation overlays previously injected by annotateElements.
 * @param {number} tabId - The ID of the tab to clean up.
 * @returns {Promise<void>}
 */
export async function removeAnnotations(tabId) {
  await sendCommand(tabId, "Runtime.evaluate", {
    expression: `(() => {
      const el = document.getElementById('__ux_test_overlay__');
      if (el) el.remove();
    })()`,
    returnByValue: true,
  });
}

/**
 * Captures the full page state including element map, annotated screenshot, metadata, and scroll hints.
 * @param {number} tabId - The ID of the tab to capture.
 * @param {Object} [visionFilter] - Optional vision-sim filter applied only around the annotated screenshot.
 * @param {string} [visionFilter.css] - The CSS filter string applied to the <html> element.
 * @param {string} [visionFilter.svg] - Optional SVG markup injected so filter URLs can resolve.
 * @returns {Promise<{screenshot: string, cleanScreenshot: string, interactiveElements: string, metadata: Object, scrollHint: string, elementCount: number, devicePixelRatio: number}>} The complete page state.
 */
export async function capturePageState(tabId, visionFilter) {
  const elMap = await buildElementMap(tabId);
  const metadata = await getPageMetadata(tabId);
  const viewport = await readViewportSize(tabId);
  currentViewportWidth = viewport.width;
  currentViewportHeight = viewport.height;

  const cleanScreenshot = await captureScreenshot(tabId);
  if (visionFilter && (visionFilter.css || visionFilter.svg)) {
    await applyVisionFilter(tabId, visionFilter);
  }
  await annotateElements(tabId, elMap);
  const screenshot = await captureScreenshot(tabId);
  await removeAnnotations(tabId);
  if (visionFilter && (visionFilter.css || visionFilter.svg)) {
    await removeVisionFilter(tabId);
  }

  const interactiveElements = formatElementMapForLLM(elMap);

  let scrollHint = "";
  if (offscreenCounts.above > 0 || offscreenCounts.below > 0) {
    const parts = [];
    if (offscreenCounts.above > 0) {
      parts.push(`${offscreenCounts.above} interactive element${offscreenCounts.above === 1 ? "" : "s"} above the viewport (scroll up to see)`);
    }
    if (offscreenCounts.below > 0) {
      parts.push(`${offscreenCounts.below} interactive element${offscreenCounts.below === 1 ? "" : "s"} below the viewport (scroll down to see)`);
    }
    scrollHint = parts.join("; ");
  }

  const elementCount = Object.keys(elMap).length;

  return {
    screenshot,
    cleanScreenshot,
    interactiveElements,
    metadata,
    scrollHint,
    elementCount,
    devicePixelRatio: currentDPR,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
  };
}

/**
 * Reads the visual viewport size (CSS pixels) from the page.
 * @param {number} tabId - The tab ID.
 * @returns {Promise<{width: number, height: number}>}
 */
async function readViewportSize(tabId) {
  try {
    const result = await sendCommand(tabId, "Runtime.evaluate", {
      expression: "JSON.stringify({width: window.innerWidth, height: window.innerHeight})",
      returnByValue: true,
    });
    const parsed = JSON.parse(result.result.value);
    return { width: parsed.width || 0, height: parsed.height || 0 };
  } catch (err) {
    return { width: 0, height: 0 };
  }
}

const FORMAT_CHAR_LIMIT = 40000;

const INPUT_TYPE_HINTS = {
  date: "format: YYYY-MM-DD",
  time: "format: HH:MM",
  "datetime-local": "format: YYYY-MM-DDTHH:MM",
  email: "expects email address",
  url: "expects URL",
  tel: "expects phone number",
  number: "numeric input",
  color: "color picker",
  file: "file upload",
  range: "slider",
};

/**
 * Formats the element map into a human-readable string for LLM consumption with tree grouping and property annotations.
 * @param {Object} map - The element map keyed by index.
 * @returns {string} Formatted element list or a message if no elements are found.
 */
export function formatElementMapForLLM(map) {
  const lines = [];
  let totalChars = 0;
  let currentGroup = null;

  for (const idx in map) {
    const el = map[idx];

    const group = el.structuralContext || null;
    if (group !== currentGroup) {
      currentGroup = group;
      if (group) {
        const groupLine = `<${group}>`;
        totalChars += groupLine.length + 1;
        lines.push(groupLine);
      }
    }

    const indent = group ? "  " : "";
    let line = `${indent}[${idx}] ${el.role}`;
    if (el.tag) line += ` <${el.tag}>`;
    if (el.name) line += ` "${el.name}"`;
    if (el.description) line += ` (${el.description})`;

    if (el.inputType && el.inputType !== "text" && el.inputType !== "submit" && el.inputType !== "button") {
      const hint = INPUT_TYPE_HINTS[el.inputType];
      if (hint) {
        line += ` [${hint}]`;
      } else {
        line += ` [type: ${el.inputType}]`;
      }
    }

    if (el.inputType === "password") {
      if (el.value) line += ` value="••••"`;
    } else if (el.value) {
      line += ` value="${el.value}"`;
    }

    if (el.tag === "select" && el.options && el.options.length > 0) {
      const optionStr = el.options.slice(0, 15).join(", ");
      line += ` options: [${optionStr}]`;
      if (el.options.length > 15) {
        line += ` (+${el.options.length - 15} more)`;
      }
    }

    if (el.textContent && !el.name && el.tag !== "input" && el.tag !== "textarea" && el.tag !== "select") {
      const truncated = el.textContent.length > 60
        ? el.textContent.substring(0, 60) + "..."
        : el.textContent;
      line += ` "${truncated}"`;
    }

    const propParts = [];
    if (el.props.disabled) propParts.push("disabled");
    if (el.props.checked !== undefined) propParts.push(`checked:${el.props.checked}`);
    if (el.props.expanded !== undefined) propParts.push(`expanded:${el.props.expanded}`);
    if (el.props.selected) propParts.push("selected");
    if (el.props.required) propParts.push("required");
    if (el.props.readonly) propParts.push("readonly");
    if (propParts.length > 0) line += ` [${propParts.join(", ")}]`;

    totalChars += line.length + 1;
    if (totalChars > FORMAT_CHAR_LIMIT) {
      lines.push(`... (element list truncated at ${FORMAT_CHAR_LIMIT} characters — ${Object.keys(map).length - lines.length} more elements not shown)`);
      break;
    }

    lines.push(line);
  }

  if (lines.length === 0) return "No interactive elements found on this page.";

  return lines.join("\n");
}

/**
 * Resolves the center coordinates of an element by its index in the element map.
 * @param {number} index - The element index.
 * @returns {{x: number, y: number}} The center coordinates rounded to integers.
 */
export function resolveElementCoordinates(index) {
  const el = elementMap[index];
  if (!el) throw new Error(`Element [${index}] not found in the current element map`);
  if (!el.boundingBox) throw new Error(`Element [${index}] has no bounding box`);

  return {
    x: Math.round(el.boundingBox.x),
    y: Math.round(el.boundingBox.y),
  };
}

/**
 * Scrolls an element into view and returns its fresh center coordinates.
 * @param {number} tabId - The ID of the tab containing the element.
 * @param {number} backendNodeId - The backend DOM node ID of the element.
 * @returns {Promise<{x: number, y: number}>} Fresh center coordinates after scrolling.
 */
async function scrollAndGetCoordinates(tabId, backendNodeId) {
  try {
    await sendCommand(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId });
    await sleep(50);
  } catch (err) {
  }

  const boxModel = await sendCommand(tabId, "DOM.getBoxModel", { backendNodeId });
  const c = boxModel.model.content;
  return {
    x: Math.round((c[0] + c[2] + c[4] + c[6]) / 4),
    y: Math.round((c[1] + c[3] + c[5] + c[7]) / 4),
  };
}

const DIRECT_VALUE_TYPES = new Set([
  "date", "time", "datetime-local", "month", "week", "color", "range",
]);

/**
 * Gets information about the currently focused element for smart typing decisions.
 * @param {number} tabId - The ID of the tab to query.
 * @returns {Promise<{tag: string, type: string, contentEditable: boolean, objectId: string}|null>} Focused element info or null.
 */
async function getFocusedElementInfo(tabId) {
  try {
    const infoResult = await sendCommand(tabId, "Runtime.evaluate", {
      expression: `(() => {
        const el = document.activeElement;
        if (!el || el === document.body || el === document.documentElement) return null;
        return JSON.stringify({
          tag: el.tagName.toLowerCase(),
          type: (el.type || '').toLowerCase(),
          contentEditable: el.isContentEditable,
        });
      })()`,
      returnByValue: true,
    });

    const info = infoResult.result?.value ? JSON.parse(infoResult.result.value) : null;
    if (!info) return null;

    const objResult = await sendCommand(tabId, "Runtime.evaluate", {
      expression: "document.activeElement",
      returnByValue: false,
    });

    info.objectId = objResult.result?.objectId || null;
    return info;
  } catch (err) {
    return null;
  }
}

const CHAR_KEY_MAP = {
  " ": { code: "Space", windowsVirtualKeyCode: 32, shift: false },
  "`": { code: "Backquote", windowsVirtualKeyCode: 192, shift: false },
  "-": { code: "Minus", windowsVirtualKeyCode: 189, shift: false },
  "=": { code: "Equal", windowsVirtualKeyCode: 187, shift: false },
  "[": { code: "BracketLeft", windowsVirtualKeyCode: 219, shift: false },
  "]": { code: "BracketRight", windowsVirtualKeyCode: 221, shift: false },
  "\\": { code: "Backslash", windowsVirtualKeyCode: 220, shift: false },
  ";": { code: "Semicolon", windowsVirtualKeyCode: 186, shift: false },
  "'": { code: "Quote", windowsVirtualKeyCode: 222, shift: false },
  ",": { code: "Comma", windowsVirtualKeyCode: 188, shift: false },
  ".": { code: "Period", windowsVirtualKeyCode: 190, shift: false },
  "/": { code: "Slash", windowsVirtualKeyCode: 191, shift: false },
  "!": { code: "Digit1", windowsVirtualKeyCode: 49, shift: true },
  "@": { code: "Digit2", windowsVirtualKeyCode: 50, shift: true },
  "#": { code: "Digit3", windowsVirtualKeyCode: 51, shift: true },
  "$": { code: "Digit4", windowsVirtualKeyCode: 52, shift: true },
  "%": { code: "Digit5", windowsVirtualKeyCode: 53, shift: true },
  "^": { code: "Digit6", windowsVirtualKeyCode: 54, shift: true },
  "&": { code: "Digit7", windowsVirtualKeyCode: 55, shift: true },
  "*": { code: "Digit8", windowsVirtualKeyCode: 56, shift: true },
  "(": { code: "Digit9", windowsVirtualKeyCode: 57, shift: true },
  ")": { code: "Digit0", windowsVirtualKeyCode: 48, shift: true },
  "~": { code: "Backquote", windowsVirtualKeyCode: 192, shift: true },
  "_": { code: "Minus", windowsVirtualKeyCode: 189, shift: true },
  "+": { code: "Equal", windowsVirtualKeyCode: 187, shift: true },
  "{": { code: "BracketLeft", windowsVirtualKeyCode: 219, shift: true },
  "}": { code: "BracketRight", windowsVirtualKeyCode: 221, shift: true },
  "|": { code: "Backslash", windowsVirtualKeyCode: 220, shift: true },
  ":": { code: "Semicolon", windowsVirtualKeyCode: 186, shift: true },
  "\"": { code: "Quote", windowsVirtualKeyCode: 222, shift: true },
  "<": { code: "Comma", windowsVirtualKeyCode: 188, shift: true },
  ">": { code: "Period", windowsVirtualKeyCode: 190, shift: true },
  "?": { code: "Slash", windowsVirtualKeyCode: 191, shift: true },
};
for (let i = 0; i < 26; i++) {
  const lower = String.fromCharCode(97 + i);
  const upper = String.fromCharCode(65 + i);
  const code = `Key${upper}`;
  const windowsVirtualKeyCode = 65 + i;
  CHAR_KEY_MAP[lower] = { code, windowsVirtualKeyCode, shift: false };
  CHAR_KEY_MAP[upper] = { code, windowsVirtualKeyCode, shift: true };
}
for (let i = 0; i <= 9; i++) {
  CHAR_KEY_MAP[String(i)] = { code: `Digit${i}`, windowsVirtualKeyCode: 48 + i, shift: false };
}

/**
 * Types text character-by-character via CDP key events, firing the full keyDown/char/keyUp pipeline.
 * Printable ASCII characters resolve to accurate `code` / `windowsVirtualKeyCode` / shift metadata via
 * CHAR_KEY_MAP; anything outside the map (CJK, emoji, accented letters, dead-key sequences) falls
 * through with empty key metadata and is delivered via the `char` event's `text` field.
 * @param {number} tabId - The ID of the tab to type into.
 * @param {string} text - The text to type.
 * @returns {Promise<void>}
 */
async function typeCharByChar(tabId, text) {
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const mapping = CHAR_KEY_MAP[char];
    const code = mapping?.code ?? "";
    const vkCode = mapping?.windowsVirtualKeyCode ?? 0;
    const modifiers = mapping?.shift ? 8 : 0;

    await sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key: char,
      code,
      windowsVirtualKeyCode: vkCode,
      modifiers,
    });

    await sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "char",
      text: char,
      unmodifiedText: char,
      modifiers,
    });

    await sendCommand(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key: char,
      code,
      windowsVirtualKeyCode: vkCode,
      modifiers,
    });

    if (i < text.length - 1) {
      await sleep(2);
    }
  }
}

/**
 * Sets an input's value directly using the native property descriptor to bypass framework interception.
 * @param {number} tabId - The ID of the tab containing the input.
 * @param {string} objectId - The Runtime object ID of the input element.
 * @param {string} value - The value to set.
 * @returns {Promise<void>}
 */
async function setValueDirectly(tabId, objectId, value) {
  await sendCommand(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function(val) {
      var descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
      if (descriptor && descriptor.set) {
        descriptor.set.call(this, val);
      } else {
        this.value = val;
      }
    }`,
    arguments: [{ value }],
    returnByValue: true,
  });
}

/**
 * Dispatches input and change events on an element so frameworks (React, Vue, Angular) detect the update.
 * @param {number} tabId - The ID of the tab containing the element.
 * @param {string} objectId - The Runtime object ID of the element.
 * @returns {Promise<void>}
 */
async function triggerFrameworkEvents(tabId, objectId) {
  await sendCommand(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
    }`,
    returnByValue: true,
  });
}

/**
 * Reads back the actual value of an element and compares it with the expected value.
 * @param {number} tabId - The ID of the tab containing the element.
 * @param {string} objectId - The Runtime object ID of the element.
 * @param {string} expectedValue - The value that should have been typed.
 * @returns {Promise<boolean>} True if the value matches or ends with the expected value.
 */
async function verifyTypedValue(tabId, objectId, expectedValue) {
  try {
    const result = await sendCommand(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function() { return this.value !== undefined ? this.value : (this.textContent || ''); }",
      returnByValue: true,
    });
    const actual = result.result?.value || "";
    return actual === expectedValue || actual.endsWith(expectedValue);
  } catch (err) {
    return true;
  }
}

/**
 * Clicks an element by index, scrolling it into view first, with a JS fallback if CDP input fails.
 * @param {number} tabId - The ID of the tab containing the element.
 * @param {number} index - The element index in the element map.
 * @returns {Promise<void>}
 */
export async function clickElement(tabId, index) {
  await sendCommand(tabId, "Page.bringToFront");
  const el = elementMap[index];
  if (!el) throw new Error(`Element [${index}] not found in the current element map`);

  try {
    const { x, y } = await scrollAndGetCoordinates(tabId, el.backendDOMNodeId);
    await dispatchClick(tabId, x, y);
  } catch (err) {
    try {
      const resolved = await sendCommand(tabId, "DOM.resolveNode", {
        backendNodeId: el.backendDOMNodeId,
      });
      if (resolved.object?.objectId) {
        await sendCommand(tabId, "Runtime.callFunctionOn", {
          objectId: resolved.object.objectId,
          functionDeclaration: "function() { this.click(); }",
          returnByValue: true,
        });
        await sendCommand(tabId, "Runtime.releaseObject", {
          objectId: resolved.object.objectId,
        }).catch(function () {});
      } else {
        throw err;
      }
    } catch (fallbackErr) {
      throw new Error(`Click failed on [${index}]: ${err.message}. JS fallback: ${fallbackErr.message}`);
    }
  }
}

/**
 * Hovers over an element by index after scrolling it into view.
 * @param {number} tabId - The ID of the tab containing the element.
 * @param {number} index - The element index in the element map.
 * @returns {Promise<void>}
 */
export async function hoverElement(tabId, index) {
  const el = elementMap[index];
  if (!el) throw new Error(`Element [${index}] not found in the current element map`);

  const { x, y } = await scrollAndGetCoordinates(tabId, el.backendDOMNodeId);
  await dispatchHover(tabId, x, y);
}

/**
 * Dispatches a full mouse click sequence (move, press, release) at the given coordinates.
 * @param {number} tabId - The ID of the tab to click in.
 * @param {number} x - The x coordinate in CSS pixels.
 * @param {number} y - The y coordinate in CSS pixels.
 * @returns {Promise<void>}
 */
export async function dispatchClick(tabId, x, y) {
  await sendCommand(tabId, "Page.bringToFront");
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

/**
 * Dispatches N sequential clicks at the same coordinates with increasing clickCount,
 * matching how browsers detect double- and triple-clicks for word/line selection.
 * @param {number} tabId - The ID of the tab to click in.
 * @param {number} x - The x coordinate in CSS pixels.
 * @param {number} y - The y coordinate in CSS pixels.
 * @param {number} count - Total number of clicks to dispatch (2 for double, 3 for triple).
 * @returns {Promise<void>}
 */
export async function dispatchMultiClick(tabId, x, y, count) {
  await sendCommand(tabId, "Page.bringToFront");
  await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  for (let i = 1; i <= count; i++) {
    await sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: i,
    });
    await sendCommand(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: i,
    });
  }
}

/**
 * Dispatches a double click at the given coordinates (selects a word when over text).
 * @param {number} tabId - The tab ID.
 * @param {number} x - CSS pixel x.
 * @param {number} y - CSS pixel y.
 */
export async function dispatchDoubleClick(tabId, x, y) {
  await dispatchMultiClick(tabId, x, y, 2);
}

/**
 * Dispatches a triple click at the given coordinates (selects a paragraph/line when over text).
 * @param {number} tabId - The tab ID.
 * @param {number} x - CSS pixel x.
 * @param {number} y - CSS pixel y.
 */
export async function dispatchTripleClick(tabId, x, y) {
  await dispatchMultiClick(tabId, x, y, 3);
}

/**
 * Double-clicks an element by index, scrolling it into view first.
 * @param {number} tabId - The tab ID.
 * @param {number} index - The element index.
 */
export async function doubleClickElement(tabId, index) {
  const el = elementMap[index];
  if (!el) throw new Error(`Element [${index}] not found in the current element map`);
  const { x, y } = await scrollAndGetCoordinates(tabId, el.backendDOMNodeId);
  await dispatchDoubleClick(tabId, x, y);
}

/**
 * Triple-clicks an element by index, scrolling it into view first.
 * @param {number} tabId - The tab ID.
 * @param {number} index - The element index.
 */
export async function tripleClickElement(tabId, index) {
  const el = elementMap[index];
  if (!el) throw new Error(`Element [${index}] not found in the current element map`);
  const { x, y } = await scrollAndGetCoordinates(tabId, el.backendDOMNodeId);
  await dispatchTripleClick(tabId, x, y);
}

/**
 * Dispatches a mouse move event to hover at the given coordinates.
 * @param {number} tabId - The ID of the tab to hover in.
 * @param {number} x - The x coordinate in CSS pixels.
 * @param {number} y - The y coordinate in CSS pixels.
 * @returns {Promise<void>}
 */
export async function dispatchHover(tabId, x, y) {
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
  });
}

/**
 * Types text into the focused element, using direct value assignment for special input types and character-by-character typing otherwise.
 * @param {number} tabId - The ID of the tab to type into.
 * @param {string} text - The text to type.
 * @returns {Promise<void>}
 */
export async function dispatchType(tabId, text) {
  await sendCommand(tabId, "Page.bringToFront");
  const focusInfo = await getFocusedElementInfo(tabId);

  if (focusInfo && DIRECT_VALUE_TYPES.has(focusInfo.type)) {
    if (focusInfo.objectId) {
      await setValueDirectly(tabId, focusInfo.objectId, text);
    }
  } else {
    await typeCharByChar(tabId, text);
  }

  if (focusInfo?.objectId) {
    await triggerFrameworkEvents(tabId, focusInfo.objectId);

    const ok = await verifyTypedValue(tabId, focusInfo.objectId, text);
    if (!ok) {
      await setValueDirectly(tabId, focusInfo.objectId, text);
      await triggerFrameworkEvents(tabId, focusInfo.objectId);
    }

    await sendCommand(tabId, "Runtime.releaseObject", {
      objectId: focusInfo.objectId,
    }).catch(function () {});
  }
}

/**
 * Selects all existing text in the focused input and types new text to replace it.
 * @param {number} tabId - The ID of the tab to type into.
 * @param {string} text - The replacement text.
 * @returns {Promise<void>}
 */
export async function selectAllAndType(tabId, text) {
  await sendCommand(tabId, "Page.bringToFront");
  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: 2,
  });
  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
  });

  await dispatchType(tabId, text);
}

/**
 * Clears the focused input by selecting all text and pressing Backspace.
 * @param {number} tabId - The ID of the tab containing the input to clear.
 * @returns {Promise<void>}
 */
export async function clearInput(tabId) {
  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
    modifiers: 2,
  });
  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "a",
    code: "KeyA",
    windowsVirtualKeyCode: 65,
  });
  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
  });
  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
  });
}

const KEY_MAP = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Space: { key: " ", code: "Space", windowsVirtualKeyCode: 32 },
  Home: { key: "Home", code: "Home", windowsVirtualKeyCode: 36 },
  End: { key: "End", code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34 },
};

const MODIFIER_MAP = {
  shift: 8,
  ctrl: 2,
  control: 2,
  alt: 1,
  meta: 4,
  cmd: 4,
  command: 4,
};

/**
 * Resolves a key token (either a named key like "Tab" or a single character like "a")
 * into the fields CDP's Input.dispatchKeyEvent expects.
 * @param {string} token - The key token.
 * @returns {{key: string, code: string, windowsVirtualKeyCode: number}}
 */
function resolveKeyToken(token) {
  if (KEY_MAP[token]) return KEY_MAP[token];
  if (token.length === 1) {
    const upper = token.toUpperCase();
    return {
      key: token,
      code: /[A-Z]/.test(upper) ? `Key${upper}` : token,
      windowsVirtualKeyCode: upper.charCodeAt(0),
    };
  }
  return { key: token, code: `Key${token.toUpperCase()}`, windowsVirtualKeyCode: 0 };
}

/**
 * Uploads a file to a <input type="file"> element (or its nearest descendant input)
 * by fetching the fixture URL from the extension, wrapping it in a File + DataTransfer,
 * and firing a synthetic "change" event. Avoids opening the OS file picker entirely.
 * @param {number} tabId - The tab ID.
 * @param {number} index - The element index in the element map (the input itself or a wrapper).
 * @param {string} fileUrl - The chrome-extension:// URL of the fixture file.
 * @param {string} fileName - The filename to expose to the page.
 * @param {string} [fileType] - Optional MIME type; falls back to the blob's detected type.
 * @returns {Promise<void>}
 */
export async function uploadFile(tabId, index, fileUrl, fileName, fileType) {
  const el = elementMap[index];
  if (!el) throw new Error(`Element [${index}] not found in the current element map`);

  const resolved = await sendCommand(tabId, "DOM.resolveNode", {
    backendNodeId: el.backendDOMNodeId,
  });
  const objectId = resolved.object && resolved.object.objectId;
  if (!objectId) throw new Error(`Could not resolve element [${index}] for upload`);

  try {
    const result = await sendCommand(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `async function(fileUrl, fileName, fileType) {
        const resp = await fetch(fileUrl);
        if (!resp.ok) throw new Error("Fixture fetch failed: " + resp.status);
        const blob = await resp.blob();
        const file = new File([blob], fileName, { type: fileType || blob.type });
        const dt = new DataTransfer();
        dt.items.add(file);

        let target = this;
        if (!(target && target.tagName === "INPUT" && target.type === "file")) {
          const nested = target && target.querySelector ? target.querySelector('input[type="file"]') : null;
          if (!nested) throw new Error("No <input type=file> found at this element");
          target = nested;
        }
        target.files = dt.files;
        target.dispatchEvent(new Event("change", { bubbles: true }));
        return { name: file.name, size: file.size, type: file.type };
      }`,
      arguments: [
        { value: fileUrl },
        { value: fileName },
        { value: fileType || "" },
      ],
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const msg = result.exceptionDetails.exception && result.exceptionDetails.exception.description
        ? result.exceptionDetails.exception.description
        : result.exceptionDetails.text;
      throw new Error(`Upload failed: ${msg}`);
    }
  } finally {
    await sendCommand(tabId, "Runtime.releaseObject", { objectId }).catch(function () {});
  }
}

/**
 * Dispatches a keyDown/keyUp pair for a named key or a Modifier+Key chord.
 * Accepts plain key names (Enter, Tab, Escape, Backspace, ArrowUp/Down/Left/Right),
 * single characters, or chords like "Shift+Tab", "Cmd+a", "Ctrl+Shift+Tab".
 * Modifiers: Shift, Ctrl/Control, Alt, Meta/Cmd/Command.
 * @param {number} tabId - The ID of the tab to send the key event to.
 * @param {string} value - The key or chord expression.
 * @returns {Promise<void>}
 */
export async function dispatchKeyPress(tabId, value) {
  await sendCommand(tabId, "Page.bringToFront");

  const tokens = String(value || "").split("+").map(function (t) { return t.trim(); }).filter(Boolean);
  if (tokens.length === 0) return;

  const keyToken = tokens[tokens.length - 1];
  const modTokens = tokens.slice(0, -1);
  const modifiers = modTokens.reduce(function (acc, t) {
    return acc | (MODIFIER_MAP[t.toLowerCase()] || 0);
  }, 0);

  const keyInfo = resolveKeyToken(keyToken);

  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers,
    ...keyInfo,
  });
  await sendCommand(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers,
    ...keyInfo,
  });
}

/**
 * Reads scroll positions of the window and document scrollingElement,
 * used to detect whether a scroll actually moved anything.
 * @param {number} tabId - The tab ID.
 * @returns {Promise<Object|null>} An object with scroll coords, or null on failure.
 */
async function readScrollPositions(tabId) {
  try {
    const result = await sendCommand(tabId, "Runtime.evaluate", {
      expression: `JSON.stringify({
        wx: window.scrollX,
        wy: window.scrollY,
        sx: document.scrollingElement ? document.scrollingElement.scrollLeft : 0,
        sy: document.scrollingElement ? document.scrollingElement.scrollTop : 0,
      })`,
      returnByValue: true,
    });
    return JSON.parse(result.result.value);
  } catch (err) {
    return null;
  }
}

/**
 * Scrolls the nearest scrollable ancestor of the element at (x, y) via JS,
 * falling back to window.scrollBy if no scrollable ancestor is found.
 * @param {number} tabId - The tab ID.
 * @param {number} x - Hit-test x.
 * @param {number} y - Hit-test y.
 * @param {number} deltaX - Horizontal pixels to scroll (wheel convention).
 * @param {number} deltaY - Vertical pixels to scroll (wheel convention).
 */
async function scrollBySearchJS(tabId, x, y, deltaX, deltaY) {
  await sendCommand(tabId, "Runtime.evaluate", {
    expression: `(() => {
      const dx = ${deltaX}, dy = ${deltaY};
      let node = document.elementFromPoint(${x}, ${y});
      while (node && node !== document.documentElement) {
        const s = getComputedStyle(node);
        const scrollableY = (s.overflowY === 'auto' || s.overflowY === 'scroll') && node.scrollHeight > node.clientHeight;
        const scrollableX = (s.overflowX === 'auto' || s.overflowX === 'scroll') && node.scrollWidth > node.clientWidth;
        if (scrollableY || scrollableX) {
          node.scrollBy(dx, dy);
          return;
        }
        node = node.parentElement;
      }
      window.scrollBy(dx, dy);
    })()`,
    returnByValue: true,
  });
}

/**
 * Scrolls the page at the given coordinates. Tries a synthesized scroll gesture
 * first (which reaches nested overflow containers), then falls back to JS-based
 * ancestor scrolling if the gesture didn't move anything.
 * @param {number} tabId - The ID of the tab to scroll in.
 * @param {number} x - The x coordinate (CSS pixels) for the scroll origin.
 * @param {number} y - The y coordinate (CSS pixels) for the scroll origin.
 * @param {number} deltaX - Horizontal scroll delta (wheel convention: positive = right).
 * @param {number} deltaY - Vertical scroll delta (wheel convention: positive = down).
 * @returns {Promise<void>}
 */
export async function dispatchScroll(tabId, x, y, deltaX, deltaY) {
  const dx = deltaX || 0;
  const dy = deltaY || 0;

  const before = await readScrollPositions(tabId);

  try {
    await sendCommand(tabId, "Input.synthesizeScrollGesture", {
      x: x || 0,
      y: y || 0,
      xDistance: -dx,
      yDistance: -dy,
      speed: 50000,
    });
  } catch (err) {
    // synthesizeScrollGesture isn't always supported; fall through to JS path
  }

  await sleep(60);

  const after = await readScrollPositions(tabId);
  const moved = before && after && (
    before.wx !== after.wx || before.wy !== after.wy ||
    before.sx !== after.sx || before.sy !== after.sy
  );
  if (moved) return;

  try {
    await scrollBySearchJS(tabId, x || 0, y || 0, dx, dy);
  } catch (err) {
    try {
      await sendCommand(tabId, "Runtime.evaluate", {
        expression: `window.scrollBy(${dx}, ${dy})`,
      });
    } catch (err2) {
    }
  }
}

/**
 * Dispatches a drag-and-drop sequence from one point to another using mouse events.
 * @param {number} tabId - The ID of the tab to perform the drag in.
 * @param {number} fromX - The starting x coordinate.
 * @param {number} fromY - The starting y coordinate.
 * @param {number} toX - The ending x coordinate.
 * @param {number} toY - The ending y coordinate.
 * @returns {Promise<void>}
 */
export async function dispatchDragAndDrop(tabId, fromX, fromY, toX, toY) {
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: fromX,
    y: fromY,
  });
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: fromX,
    y: fromY,
    button: "left",
    clickCount: 1,
  });
  await sleep(100);
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: toX,
    y: toY,
  });
  await sendCommand(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: toX,
    y: toY,
    button: "left",
    clickCount: 1,
  });
}

/**
 * Focuses an element by index after scrolling it into view.
 * @param {number} tabId - The ID of the tab containing the element.
 * @param {number} index - The element index in the element map.
 * @returns {Promise<void>}
 */
export async function focusElement(tabId, index) {
  const el = elementMap[index];
  if (!el) throw new Error(`Element [${index}] not found`);

  try {
    await sendCommand(tabId, "DOM.scrollIntoViewIfNeeded", {
      backendNodeId: el.backendDOMNodeId,
    });
    await sleep(50);
  } catch (err) {
  }

  await sendCommand(tabId, "DOM.focus", {
    backendNodeId: el.backendDOMNodeId,
  });
}

/**
 * Selects a dropdown option by value or visible text on a focused select element.
 * @param {number} tabId - The ID of the tab containing the dropdown.
 * @param {number} index - The element index of the select element.
 * @param {string} optionValue - The option value or text content to select.
 * @returns {Promise<void>}
 */
export async function selectDropdownOption(tabId, index, optionValue) {
  await focusElement(tabId, index);

  const escapedValue = optionValue.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  await sendCommand(tabId, "Runtime.evaluate", {
    expression: `(() => {
      const selects = document.querySelectorAll('select');
      for (const sel of selects) {
        for (const opt of sel.options) {
          if (opt.value === '${escapedValue}' || opt.textContent.trim() === '${escapedValue}') {
            sel.value = opt.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
      }
      return false;
    })()`,
    returnByValue: true,
  });
}

/**
 * Navigates the tab back in browser history and waits for the page to settle.
 * @param {number} tabId - The ID of the tab to navigate.
 * @returns {Promise<void>}
 */
export async function goBack(tabId) {
  await sendCommand(tabId, "Runtime.evaluate", {
    expression: "history.back()",
  });
  await waitForPageSettle(tabId);
}

/**
 * Waits for page readyState, network idle, and DOM stability before proceeding.
 * @param {number} tabId - The ID of the tab to wait on.
 * @returns {Promise<void>}
 */
export async function waitForPageSettle(tabId, signal) {
  const startTime = Date.now();
  const maxWait = 10000;

  while (Date.now() - startTime < maxWait) {
    if (signal?.aborted) return;
    try {
      const result = await sendCommand(tabId, "Runtime.evaluate", {
        expression: "document.readyState",
        returnByValue: true,
      });
      if (result.result.value === "complete") break;
    } catch (err) {
    }
    await sleep(200);
  }

  if (networkEnabled) {
    let idleStart = Date.now();
    while (Date.now() - startTime < maxWait) {
      if (signal?.aborted) return;
      if (pendingRequests === 0) {
        if (Date.now() - idleStart >= 500) break;
      } else {
        idleStart = Date.now();
      }
      await sleep(100);
    }
  }

  if (signal?.aborted) return;

  try {
    await sendCommand(tabId, "Runtime.evaluate", {
      expression: `new Promise((resolve) => {
        let timer = setTimeout(resolve, 300);
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            observer.disconnect();
            resolve();
          }, 300);
        });
        observer.observe(document.body || document.documentElement, {
          childList: true, subtree: true, attributes: true
        });
        // Safety timeout
        setTimeout(() => { observer.disconnect(); resolve(); }, 3000);
      })`,
      awaitPromise: true,
      returnByValue: true,
    });
  } catch (err) {
  }

  await sleep(100);
}

/**
 * Returns a promise that resolves after the specified number of milliseconds.
 * @param {number} ms - The number of milliseconds to sleep.
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
