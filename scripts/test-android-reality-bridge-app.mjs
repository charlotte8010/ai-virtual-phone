#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "custom-apps", "android-reality-bridge");
const zipPath = path.join(appDir, "Android Reality Bridge.zip");
const expectedFiles = ["icon.png", "index.html", "manifest.json"];

const manifest = JSON.parse(await fs.readFile(path.join(appDir, "manifest.json"), "utf8"));
const html = await fs.readFile(path.join(appDir, "index.html"), "utf8");
const icon = await fs.readFile(path.join(appDir, "icon.png"));
const zip = await JSZip.loadAsync(await fs.readFile(zipPath));
const zipFiles = Object.keys(zip.files).filter(file => !zip.files[file].dir).sort();

assert.deepEqual(zipFiles, expectedFiles, "ZIP must contain only the standard app files");
assert.deepEqual(manifest.permissions, [
  "reality.capabilities.read",
  "reality.permission.read",
  "reality.device.action",
], "manifest must declare exactly the three Reality permissions");
assert.equal(manifest.entry, "index.html");
assert.equal(manifest.icon, "icon.png");
assert.equal(icon.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "icon.png must be a PNG");

for (const method of ["getCapabilities", "getPermissionState", "execute"]) {
  assert.match(html, new RegExp(`window\\.AiPhone\\.reality\\.${method}\\b`), `missing reality.${method} call`);
}
for (const action of ["open_app", "open_url", "open_map", "dial_phone", "share_text", "show_notification"]) {
  assert.match(html, new RegExp(`['"]${action}['"]`), `missing ${action} test entry`);
}
for (const forbidden of ["device.query", "AccessibilityService", "NotificationListenerService", "MediaProjection", "screen_control", "Event Timeline", "AndroidShell"]) {
  assert.equal(html.includes(forbidden), false, `forbidden capability leaked into app: ${forbidden}`);
}

const packagedManifest = JSON.parse(await zip.file("manifest.json").async("text"));
const packagedHtml = await zip.file("index.html").async("text");
assert.deepEqual(packagedManifest, manifest, "packaged manifest must match source manifest");
assert.equal(packagedHtml, html, "packaged entry must match source entry");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
assert.equal(scripts.length, 1, "app should have one self-contained script");
assert.doesNotThrow(() => new Function(scripts[0]), "app script must parse");

console.log("Android Reality Bridge custom app package tests passed");
