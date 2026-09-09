import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as ts from "typescript";

const sourceUrl = new URL("../lib/android-reality-bridge-protocol.ts", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  },
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`;
const protocol = await import(moduleUrl);

const payload = protocol.createAndroidPairingPayload({
  supabaseUrl: "https://bridge-project.supabase.co/",
  anonKey: "sb_publishable_test-key",
  pairingToken: "a".repeat(64),
  expiresAt: 1_757_400_060_000,
});
assert.deepEqual(payload, {
  version: 1,
  supabaseUrl: "https://bridge-project.supabase.co",
  anonKey: "sb_publishable_test-key",
  pairingToken: "a".repeat(64),
  expiresAt: 1_757_400_060_000,
});

const pairingUri = protocol.buildAndroidPairingUri(payload);
assert.match(pairingUri, /^floatbridge:\/\/pair\?payload=/);
const encodedPayload = decodeURIComponent(new URL(pairingUri).searchParams.get("payload") || "");
assert.deepEqual(JSON.parse(encodedPayload), payload);

assert.deepEqual(protocol.validateAndroidActionPayload("show_notification", {
  title: "Float",
  body: "Android bridge is alive",
}), { title: "Float", body: "Android bridge is alive" });
assert.throws(() => protocol.validateAndroidActionPayload("open_url", { url: "http://unsafe.example" }));
assert.throws(() => protocol.validateAndroidActionPayload("show_notification", { title: "only title" }));

const device = protocol.normalizeAndroidDevice({
  device_id: "android-1",
  device_name: "Pixel",
  capabilities: ["show_notification"],
  online: true,
  last_seen: "2026-09-09T00:00:00.000Z",
});
assert.equal(device.deviceId, "android-1");
assert.equal(device.online, true);
assert.deepEqual(device.capabilities, ["show_notification"]);

const command = protocol.normalizeAndroidCommand({
  id: "cmd-1",
  device_id: "android-1",
  action: "show_notification",
  payload: { title: "Float", body: "done" },
  require_confirm: false,
  ttl_seconds: 60,
  created_at: "2026-09-09T00:00:00.000Z",
});
assert.deepEqual(command.payload, { title: "Float", body: "done" });
assert.equal(command.action, "show_notification");

const result = protocol.normalizeAndroidResult({
  command_id: "cmd-1",
  device_id: "android-1",
  status: "success",
  result: { delivered: "true" },
  completed_at: "2026-09-09T00:00:01.000Z",
});
assert.equal(result.commandId, "cmd-1");
assert.equal(result.status, "success");
assert.deepEqual(result.result, { delivered: "true" });

console.log("android reality bridge protocol tests passed");
