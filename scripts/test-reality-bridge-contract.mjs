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

assert.deepEqual(protocol.REALITY_APP_PERMISSIONS, [
  "reality.capabilities.read",
  "reality.permission.read",
  "reality.device.action",
]);
assert.equal(protocol.REALITY_NATIVE_CHANNEL_NAME, "FloatRealityChannel");
assert.equal(protocol.REALITY_PROTOCOL_VERSION, 1);

const command = protocol.createRealityCommand({
  commandId: "reality-command-1",
  deviceId: "shell-device-1",
  action: "show_notification",
  payload: { title: "Float", body: "bridge contract" },
  requireConfirm: false,
  ttlSeconds: 60,
  createdAt: "2026-09-09T00:00:00.000Z",
});
assert.deepEqual(command, {
  protocolVersion: 1,
  commandId: "reality-command-1",
  deviceId: "shell-device-1",
  action: "show_notification",
  payload: { title: "Float", body: "bridge contract" },
  requireConfirm: false,
  ttlSeconds: 60,
  createdAt: "2026-09-09T00:00:00.000Z",
});
assert.throws(
  () => protocol.createRealityCommand({
    commandId: "reality-command-2",
    deviceId: "shell-device-1",
    action: "show_notification",
    payload: { title: "Float" },
  }),
  /body/,
);

const nativeRequest = protocol.createRealityNativeRequest({
  requestId: "native-request-1",
  operation: "execute",
  command,
});
assert.deepEqual(nativeRequest, {
  protocolVersion: 1,
  channel: "float.reality",
  requestId: "native-request-1",
  operation: "execute",
  command,
});
assert.deepEqual(protocol.parseRealityNativeRequest(nativeRequest), nativeRequest);
assert.throws(
  () => protocol.parseRealityNativeRequest({
    ...nativeRequest,
    operation: "bind",
  }),
  /operation/,
);
assert.throws(
  () => protocol.parseRealityNativeRequest({
    ...nativeRequest,
    requestId: "../../escape",
  }),
  /requestId/,
);

const capabilities = protocol.normalizeRealityCapabilities({
  protocolVersion: 1,
  transport: "local_native",
  deviceId: "shell-device-1",
  deviceName: "Pixel",
  online: false,
  actions: [],
});
assert.deepEqual(capabilities, {
  protocolVersion: 1,
  transport: "local_native",
  deviceId: "shell-device-1",
  deviceName: "Pixel",
  online: false,
  actions: [],
});

const permissions = protocol.normalizeRealityPermissionState({
  protocolVersion: 1,
  transport: "local_native",
  deviceId: "shell-device-1",
  bound: false,
  canExecute: false,
  nativePermissions: {},
});
assert.deepEqual(permissions, {
  protocolVersion: 1,
  transport: "local_native",
  deviceId: "shell-device-1",
  bound: false,
  canExecute: false,
  nativePermissions: {},
});

assert.deepEqual(protocol.realityHostPermissionForAction("reality.getCapabilities"), [
  "reality.capabilities.read",
]);
assert.deepEqual(protocol.realityHostPermissionForAction("reality.getPermissionState"), [
  "reality.permission.read",
]);
assert.deepEqual(protocol.realityHostPermissionForAction("reality.execute"), [
  "reality.device.action",
]);
assert.throws(
  () => protocol.realityHostPermissionForAction("reality.bind"),
  /unsupported Reality host action/,
);

console.log("reality bridge contract tests passed");
