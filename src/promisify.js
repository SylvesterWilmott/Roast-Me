"use strict";

/* global chrome */

const ChromeUtils = {};

/**
 * Wraps a Chrome callback-style API method in a Promise.
 * @param {Function} method - The Chrome API method to promisify.
 * @returns {Function} A function that returns a Promise resolving with the callback result.
 */
function promisifyChromeMethod(method) {
  return (...args) =>
    new Promise((resolve, reject) => {
      method(...args, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message || JSON.stringify(chrome.runtime.lastError)));
        } else {
          resolve(result);
        }
      });
    });
}

if (chrome.runtime) {
  ChromeUtils.sendMessage = promisifyChromeMethod(chrome.runtime.sendMessage.bind(chrome.runtime));
}

if (chrome.tabs) {
  ChromeUtils.captureVisibleTab = promisifyChromeMethod(chrome.tabs.captureVisibleTab.bind(chrome.tabs));
  ChromeUtils.tabsQuery = promisifyChromeMethod(chrome.tabs.query.bind(chrome.tabs));
}

if (chrome.debugger) {
  ChromeUtils.debuggerAttach = promisifyChromeMethod(chrome.debugger.attach.bind(chrome.debugger));
  ChromeUtils.debuggerDetach = promisifyChromeMethod(chrome.debugger.detach.bind(chrome.debugger));
  ChromeUtils.debuggerSendCommand = promisifyChromeMethod(chrome.debugger.sendCommand.bind(chrome.debugger));
}

if (chrome.storage && chrome.storage.local) {
  ChromeUtils.storageGet = promisifyChromeMethod(chrome.storage.local.get.bind(chrome.storage.local));
  ChromeUtils.storageSet = promisifyChromeMethod(chrome.storage.local.set.bind(chrome.storage.local));
}

export default ChromeUtils;
