import { bgDelay } from "./bg-timer";
import { isPersonalPushCloudActive, personalPushFetch } from "./personal-push-cloud";
import {
  ANDROID_BRIDGE_ACTIONS,
  buildAndroidPairingUri,
  createAndroidPairingPayload,
  normalizeAndroidCommand,
  normalizeAndroidDevice,
  normalizeAndroidResult,
  validateAndroidActionPayload,
  type AndroidBridgeAction,
  type AndroidCommand,
  type AndroidDevice,
  type AndroidPairingPayload,
  type AndroidResult,
} from "./android-reality-bridge-protocol";

export {
  ANDROID_BRIDGE_ACTIONS,
  buildAndroidPairingUri,
  createAndroidPairingPayload,
  validateAndroidActionPayload,
};
export type {
  AndroidBridgeAction,
  AndroidCommand,
  AndroidDevice,
  AndroidPairingPayload,
  AndroidResult,
};

type ApiEnvelope = { ok?: boolean; error?: string };

async function parseApiResponse<T extends ApiEnvelope>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({})) as T;
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Android Reality Bridge 请求失败（${response.status}）`);
  }
  return data;
}

function ensurePersonalCloud(): void {
  if (!isPersonalPushCloudActive()) {
    throw new Error("请先部署并连接个人云，Android Reality Bridge 使用同一套个人云。");
  }
}

export async function createAndroidPairing(anonKey: string): Promise<AndroidPairingPayload> {
  ensurePersonalCloud();
  const response = await personalPushFetch("android-pairing", {
    method: "POST",
    body: JSON.stringify({ anonKey: anonKey.trim() }),
  });
  const data = await parseApiResponse<ApiEnvelope & {
    pairing?: { version?: unknown; supabaseUrl?: unknown; anonKey?: unknown; pairingToken?: unknown; expiresAt?: unknown };
  }>(response);
  if (!data.pairing) throw new Error("个人云没有返回 Android 配对信息。");
  return createAndroidPairingPayload({
    supabaseUrl: String(data.pairing.supabaseUrl || ""),
    anonKey: String(data.pairing.anonKey || ""),
    pairingToken: String(data.pairing.pairingToken || ""),
    expiresAt: Number(data.pairing.expiresAt),
  });
}

export async function loadAndroidDevices(limit = 20): Promise<AndroidDevice[]> {
  ensurePersonalCloud();
  const response = await personalPushFetch("android-devices", {}, {
    limit: String(Math.max(1, Math.min(50, Math.round(limit)))),
  });
  const data = await parseApiResponse<ApiEnvelope & { devices?: unknown[] }>(response);
  return Array.isArray(data.devices) ? data.devices.map(normalizeAndroidDevice) : [];
}

export async function sendAndroidCommand(input: {
  commandId?: string;
  deviceId: string;
  action: AndroidBridgeAction;
  payload: Record<string, unknown>;
  requireConfirm?: boolean;
  ttlSeconds?: number;
}): Promise<AndroidCommand> {
  ensurePersonalCloud();
  const payload = validateAndroidActionPayload(input.action, input.payload);
  const response = await personalPushFetch("android-command", {
    method: "POST",
    body: JSON.stringify({
      commandId: input.commandId,
      deviceId: input.deviceId,
      action: input.action,
      payload,
      requireConfirm: input.requireConfirm === true,
      ttlSeconds: input.ttlSeconds,
    }),
  });
  const data = await parseApiResponse<ApiEnvelope & { command?: unknown }>(response);
  if (!data.command) throw new Error("个人云没有返回 Android 命令。");
  return normalizeAndroidCommand(data.command);
}

export async function loadAndroidResult(commandId: string): Promise<AndroidResult | null> {
  ensurePersonalCloud();
  const response = await personalPushFetch("android-results", {}, { commandId: commandId.trim() });
  const data = await parseApiResponse<ApiEnvelope & { result?: unknown | null }>(response);
  return data.result ? normalizeAndroidResult(data.result) : null;
}

export async function loadAndroidResults(limit = 20, deviceId?: string): Promise<AndroidResult[]> {
  ensurePersonalCloud();
  const response = await personalPushFetch("android-results", {}, {
    limit: String(Math.max(1, Math.min(50, Math.round(limit)))),
    ...(deviceId?.trim() ? { deviceId: deviceId.trim() } : {}),
  });
  const data = await parseApiResponse<ApiEnvelope & { results?: unknown[] }>(response);
  return Array.isArray(data.results) ? data.results.map(normalizeAndroidResult) : [];
}

export async function waitForAndroidResult(
  command: AndroidCommand,
  signal?: AbortSignal,
): Promise<AndroidResult | null> {
  const expiresAt = Date.parse(command.createdAt) + command.ttlSeconds * 1000;
  const deadline = Number.isFinite(expiresAt) ? expiresAt + 5_000 : Date.now() + 65_000;
  while (Date.now() <= deadline) {
    const result = await loadAndroidResult(command.id);
    if (result) return result;
    await bgDelay(Math.min(1_500, Math.max(250, deadline - Date.now())), signal);
  }
  return null;
}
