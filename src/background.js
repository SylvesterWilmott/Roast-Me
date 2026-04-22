"use strict";

/* global chrome */

import ChromeUtils from "./promisify.js";
import AgentService from "./agentService.js";

let agentService = null;

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onMessage.addListener(handleMessage);

/**
 * Routes incoming messages from the side panel to the appropriate handler.
 * @param {Object} msg - The message object.
 * @param {Object} sender - The sender of the message.
 * @param {Function} sendResponse - Callback to send a response.
 * @returns {boolean|undefined} True if the response will be sent asynchronously.
 */
function handleMessage(msg, sender, sendResponse) {
  if (!msg.target || msg.target !== "background") return;

  switch (msg.type) {
    case "START_TEST":
      handleStartTest(msg, sendResponse);
      return true;
    case "STOP_TEST":
      handleStopTest(msg, sendResponse);
      return true;
  }
}

/**
 * Sends a message to the side panel.
 * @param {Object} msg - The message payload.
 */
function sendToSidePanel(msg) {
  chrome.runtime.sendMessage({ target: "sidepanel", ...msg })
}

/**
 * Starts a new test session on the active tab using the configured API key.
 * @param {Object} msg - Message containing persona, task, and productContext.
 * @param {Function} sendResponse - Callback to send the result.
 */
function handleStartTest(msg, sendResponse) {
  ChromeUtils.tabsQuery({ active: true, currentWindow: true })
    .then(function (tabs) {
      if (!tabs || tabs.length === 0) {
        throw new Error("No active tab found");
      }

      return ChromeUtils.storageGet("claudeApiKey").then(function (data) {
        if (!data.claudeApiKey) {
          throw new Error("Claude API key not configured");
        }

        agentService = new AgentService();

        agentService
          .runTest(
            {
              tabId: tabs[0].id,
              persona: msg.persona,
              task: msg.task,
              productContext: msg.productContext || "",
              apiKey: data.claudeApiKey,
              model: msg.model,
              sightedA11y: msg.sightedA11y !== false,
            },
            function (step) {
              sendToSidePanel({ type: "STEP_UPDATE", step });
            },
          )
          .then(function () {
            sendToSidePanel({ type: "TEST_COMPLETE" });
          })
          .catch(function (err) {
            sendToSidePanel({ type: "TEST_ERROR", error: err.message });
          });

        sendResponse({ success: true });
      });
    })
    .catch(function (err) {
      sendResponse({ error: err.message });
    });
}

/**
 * Stops the currently running test session.
 * @param {Object} msg - The message object.
 * @param {Function} sendResponse - Callback to send the result.
 */
function handleStopTest(msg, sendResponse) {
  if (agentService) {
    agentService
      .stopTest()
      .then(function () {
        sendResponse({ success: true });
      })
      .catch(function (err) {
        sendResponse({ error: err.message });
      });
  } else {
    sendResponse({ success: true });
  }
}
