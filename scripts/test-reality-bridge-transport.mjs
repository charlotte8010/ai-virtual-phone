import assert from "node:assert/strict";
import path from "node:path";
import { createJiti } from "jiti";

const root = process.cwd();
const jiti = createJiti(path.join(root, "scripts/test-reality-bridge-transport.mjs"));
const protocol = await jiti.import(path.join(root, "lib/android-reality-bridge-protocol.ts"));
const transport = await jiti.import(path.join(root, "lib/reality-bridge/transport.ts"));
const channelModule = await jiti.import(path.join(root, "lib/reality-bridge/native-channel.ts"));

const command = protocol.createRealityCommand({
  commandId: "reality-command-transport",
  deviceId: "shell-device-1",
  action: "show_notification",
  payload: { title: "Float", body: "transport" },
  createdAt: "2026-09-09T00:00:00.000Z",
});

const localRequests = [];
const localChannel = {
  async request(operation, requestedCommand, bindingNonce) {
    localRequests.push({ operation, command: requestedCommand, bindingNonce });
    if (operation === "prepareBinding") {
      return { deviceId: "shell-device-1", nonce: bindingNonce, publicKey: null };
    }
    if (operation === "getCapabilities") {
      return { protocolVersion: 1, transport: "local_native", deviceId: "shell-device-1", deviceName: "Pixel", online: false, actions: [] };
    }
    if (operation === "getPermissionState") {
      return { protocolVersion: 1, transport: "local_native", deviceId: "shell-device-1", bound: false, canExecute: false, nativePermissions: {} };
    }
    return { commandId: requestedCommand.commandId, deviceId: requestedCommand.deviceId, status: "rejected", result: {}, errorCode: "NOT_READY", errorMessage: "not ready", completedAt: "2026-09-09T00:00:00.000Z" };
  },
};
const local = new transport.LocalNativeTransport(localChannel);
assert.equal((await local.prepareBinding()).deviceId, "shell-device-1");
assert.match(localRequests[0].bindingNonce, /^[A-Za-z0-9_-]{32,256}$/);
assert.equal((await local.getCapabilities()).transport, "local_native");
assert.equal((await local.getPermissionState()).bound, false);
assert.equal((await local.execute(command)).status, "rejected");
assert.deepEqual(localRequests.map(item => item.operation), ["prepareBinding", "getCapabilities", "getPermissionState", "execute"]);
assert.equal(localRequests[3].command.commandId, command.commandId);

const remoteCommand = { id: command.commandId, deviceId: "remote-1", action: "show_notification", payload: command.payload, requireConfirm: false, ttlSeconds: 60, createdAt: command.createdAt };
const remoteCalls = [];
const remote = new transport.RemoteCloudTransport({
  async loadDevices() {
    return [{ deviceId: "remote-1", deviceName: "Remote Pixel", capabilities: ["show_notification"], online: true, batteryPercent: null, network: "", androidVersion: "", lastSeen: null, createdAt: null, updatedAt: null }];
  },
  async sendCommand(input) {
    remoteCalls.push(input);
    return remoteCommand;
  },
  async waitForResult(received) {
    assert.equal(received.id, remoteCommand.id);
    return { commandId: received.id, deviceId: received.deviceId, status: "success", result: { delivered: true }, errorCode: null, errorMessage: null, completedAt: "2026-09-09T00:00:01.000Z" };
  },
}, "remote-1");
assert.equal((await remote.getCapabilities()).devices.length, 1);
assert.equal((await remote.getPermissionState()).canExecute, true);
const remoteResult = await remote.execute({ ...command, deviceId: "remote-1" });
assert.equal(remoteResult.transport, "remote_cloud");
assert.equal(remoteResult.commandId, command.commandId);
assert.deepEqual(remoteCalls[0].payload, command.payload);
await assert.rejects(() => remote.execute(command), /selected remote device/);

class FakeEndpoint {
  listeners = new Set();
  addEventListener(_type, listener) { this.listeners.add(listener); }
  removeEventListener(_type, listener) { this.listeners.delete(listener); }
  postMessage(raw) {
    const request = JSON.parse(raw);
    queueMicrotask(() => {
      const response = {
        protocolVersion: 1,
        channel: "float.reality",
        requestId: request.requestId,
        operation: request.operation,
        ok: true,
        result: { protocolVersion: 1, transport: "local_native", deviceId: "shell-device-1", deviceName: "Pixel", online: false, actions: [] },
      };
      for (const listener of this.listeners) listener({ data: JSON.stringify(response) });
    });
  }
}
const endpoint = new FakeEndpoint();
const browserChannel = new channelModule.BrowserNativeRealityChannel(endpoint);
const browserCapabilities = await browserChannel.request("getCapabilities");
assert.equal(browserCapabilities.deviceId, "shell-device-1");
browserChannel.dispose();

console.log("reality bridge transport tests passed");
