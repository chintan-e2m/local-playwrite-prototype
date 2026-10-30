// Preloaded into every Node process of a task (NODE_OPTIONS=--require <this file>).
// The dev-command plugin's scripts call chromium.launch(); on the server there is no Chromium,
// so launch() connects to the task's browser on the developer machine instead
// (TEAMING_CDP_ENDPOINT, a loopback endpoint the Runner Hub tunnels to the laptop).
"use strict";
const Module = require("node:module");
const endpoint = process.env.TEAMING_CDP_ENDPOINT;

const CONTEXT_KEYS = ["viewport", "deviceScaleFactor", "userAgent", "locale", "timezoneId", "colorScheme",
  "isMobile", "hasTouch", "javaScriptEnabled", "extraHTTPHeaders", "ignoreHTTPSErrors", "reducedMotion", "screen"];

function patch(exports) {
  const bt = exports && typeof exports === "object" ? exports.chromium : undefined;
  if (!bt || typeof bt.connectOverCDP !== "function" || bt.__teamingRemote) return;
  Object.defineProperty(bt, "__teamingRemote", { value: true });
  bt.launch = async () => bt.connectOverCDP(endpoint);
  bt.launchPersistentContext = async (_userDataDir, options = {}) => {
    const browser = await bt.connectOverCDP(endpoint);
    const ctx = {};
    for (const k of CONTEXT_KEYS) if (options[k] !== undefined) ctx[k] = options[k];
    return browser.newContext(ctx);
  };
}

if (endpoint) {
  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    const exports = load.apply(this, arguments);
    try {
      patch(exports);
    } catch {}
    return exports;
  };
}
