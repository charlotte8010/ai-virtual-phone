#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = await fs.readFile(path.join(root, "custom-apps", "android-reality-bridge", "index.html"), "utf8");

assert.match(html, /function executionBlockReason\(\)/, "the app must centralize execution gating");
assert.match(html, /permission\.canExecute !== true/, "permission.canExecute must be required explicitly");
assert.match(html, /Array\.isArray\(device\.actions\)/, "per-device action lists must be recognized explicitly");
assert.match(html, /!device\.actions\.includes\(state\.action\)/, "unsupported selected actions must be blocked");
assert.match(html, /当前设备不可执行 Reality 动作/, "the permission gate needs a clear user-facing reason");
assert.match(html, /当前设备不支持 \" \+ state\.action/, "the action gate needs to name the unsupported action");
assert.match(html, /renderExecutionGate\(\)/, "renderState and busy transitions must refresh the gate");
assert.match(html, /var blockedReason = executionBlockReason\(\)/, "execute must re-check the UI gate before dispatch");

console.log("Android Reality Bridge execution gating tests passed");
