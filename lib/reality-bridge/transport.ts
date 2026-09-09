import {
  normalizeRealityCapabilities,
  normalizeRealityBindingMaterial,
  normalizeRealityCommandResult,
  normalizeRealityPermissionState,
  createRealityBindingNonce,
  type AndroidBridgeAction,
  type AndroidCommand,
  type AndroidDevice,
  type AndroidResult,
  type RealityCapabilities,
  type RealityBindingMaterial,
  type RealityCommand,
  type RealityCommandResult,
  type RealityDeviceCredentials,
  type RealityPermissionState,
} from "../android-reality-bridge-protocol";
import type { NativeRealityChannel } from "./native-channel";

export interface RealityTransport {
  readonly kind: "local_native" | "remote_cloud";
  getCapabilities(): Promise<RealityCapabilities>;
  getPermissionState(): Promise<RealityPermissionState>;
  execute(command: RealityCommand): Promise<RealityCommandResult>;
}

export type RemoteCloudTransportAdapter = {
  loadDevices(limit?: number): Promise<AndroidDevice[]>;
  sendCommand(input: {
    commandId?: string;
    deviceId: string;
    action: AndroidBridgeAction;
    payload: Record<string, unknown>;
    requireConfirm?: boolean;
    ttlSeconds?: number;
  }): Promise<AndroidCommand>;
  waitForResult(command: AndroidCommand, signal?: AbortSignal): Promise<AndroidResult | null>;
};

function toDeviceSummary(device: AndroidDevice) {
  return {
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    actions: device.capabilities,
    online: device.online,
  };
}

/**
 * Local transport. It only speaks the controlled WebMessage channel;
 * Android action execution stays behind the native runtime and never enters
 * the browser-side custom-app sandbox.
 */
export class LocalNativeTransport implements RealityTransport {
  readonly kind = "local_native" as const;

  constructor(private readonly channel: NativeRealityChannel) {}

  async prepareBinding(nonce = createRealityBindingNonce()): Promise<RealityBindingMaterial> {
    return normalizeRealityBindingMaterial(await this.channel.request("prepareBinding", undefined, nonce));
  }

  async completeBinding(credentials: RealityDeviceCredentials): Promise<unknown> {
    return this.channel.request("completeBinding", undefined, undefined, credentials);
  }

  async getCapabilities(): Promise<RealityCapabilities> {
    return normalizeRealityCapabilities(await this.channel.request("getCapabilities"));
  }

  async getPermissionState(): Promise<RealityPermissionState> {
    return normalizeRealityPermissionState(await this.channel.request("getPermissionState"));
  }

  async execute(command: RealityCommand): Promise<RealityCommandResult> {
    return normalizeRealityCommandResult(
      await this.channel.request("execute", command),
      this.kind,
    );
  }

  dispose(): void {
    const disposable = this.channel as NativeRealityChannel & { dispose?: () => void };
    disposable.dispose?.();
  }
}

/**
 * Remote transport adapter around the existing personal-cloud Android API.
 * It does not move Android code into the web app; it keeps the cloud path
 * behind the same contract while FloatShell is migrated in a later phase.
 */
export class RemoteCloudTransport implements RealityTransport {
  readonly kind = "remote_cloud" as const;

  constructor(
    private readonly adapter: RemoteCloudTransportAdapter,
    private readonly selectedDeviceId?: string,
  ) {}

  async getCapabilities(): Promise<RealityCapabilities> {
    const devices = await this.adapter.loadDevices();
    const selected = this.selectedDeviceId
      ? devices.find(device => device.deviceId === this.selectedDeviceId)
      : undefined;
    return normalizeRealityCapabilities({
      protocolVersion: 1,
      transport: this.kind,
      deviceId: selected?.deviceId ?? null,
      deviceName: selected?.deviceName ?? null,
      online: selected?.online === true,
      actions: selected?.capabilities ?? [],
      devices: devices.map(toDeviceSummary),
    });
  }

  async getPermissionState(): Promise<RealityPermissionState> {
    const capabilities = await this.getCapabilities();
    return normalizeRealityPermissionState({
      protocolVersion: 1,
      transport: this.kind,
      deviceId: capabilities.deviceId,
      bound: Boolean(capabilities.deviceId),
      canExecute: capabilities.online && capabilities.actions.length > 0,
      nativePermissions: {},
    });
  }

  async execute(command: RealityCommand): Promise<RealityCommandResult> {
    if (this.selectedDeviceId && command.deviceId !== this.selectedDeviceId) {
      throw new Error("Reality command device does not match the selected remote device");
    }
    const remoteCommand = await this.adapter.sendCommand({
      commandId: command.commandId,
      deviceId: command.deviceId,
      action: command.action,
      payload: command.payload,
      requireConfirm: command.requireConfirm,
      ttlSeconds: command.ttlSeconds,
    });
    if (remoteCommand.id !== command.commandId) {
      throw new Error("Remote Reality transport returned a different command id");
    }
    const result = await this.adapter.waitForResult(remoteCommand);
    if (!result) throw new Error("Remote Reality command timed out");
    return normalizeRealityCommandResult(result, this.kind);
  }
}
