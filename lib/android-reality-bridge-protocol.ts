export const ANDROID_BRIDGE_ACTIONS = [
  "open_app",
  "open_url",
  "open_map",
  "dial_phone",
  "share_text",
  "show_notification",
] as const;

export type AndroidBridgeAction = (typeof ANDROID_BRIDGE_ACTIONS)[number];
export type AndroidResultStatus = "success" | "failed" | "rejected";

export type AndroidPairingPayload = {
  version: 1;
  supabaseUrl: string;
  anonKey: string;
  pairingToken: string;
  expiresAt: number;
};

export type AndroidDevice = {
  deviceId: string;
  deviceName: string;
  capabilities: AndroidBridgeAction[];
  online: boolean;
  batteryPercent: number | null;
  network: string;
  androidVersion: string;
  lastSeen: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type AndroidCommand = {
  id: string;
  deviceId: string;
  action: AndroidBridgeAction;
  payload: Record<string, string>;
  requireConfirm: boolean;
  ttlSeconds: number;
  createdAt: string;
};

export type AndroidResult = {
  commandId: string;
  deviceId: string;
  status: AndroidResultStatus;
  result: Record<string, string>;
  errorCode: string | null;
  errorMessage: string | null;
  completedAt: string;
};

const ACTION_FIELDS: Record<AndroidBridgeAction, readonly string[]> = {
  open_app: ["package"],
  open_url: ["url"],
  open_map: ["destination"],
  dial_phone: ["phone"],
  share_text: ["text"],
  show_notification: ["title", "body"],
};

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} must be text`);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) throw new Error(`${field} is invalid`);
  return trimmed;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isAction(value: unknown): value is AndroidBridgeAction {
  return typeof value === "string" && (ANDROID_BRIDGE_ACTIONS as readonly string[]).includes(value);
}

export function createAndroidPairingPayload(input: {
  supabaseUrl: string;
  anonKey: string;
  pairingToken: string;
  expiresAt: number;
}): AndroidPairingPayload {
  let supabaseUrl: URL;
  try {
    supabaseUrl = new URL(input.supabaseUrl.trim());
  } catch {
    throw new Error("Supabase URL is invalid");
  }
  if (supabaseUrl.protocol !== "https:") throw new Error("Supabase URL must use HTTPS");
  const pairingToken = stringValue(input.pairingToken, "pairingToken", 4096);
  if (pairingToken.length < 8) throw new Error("pairingToken is invalid");
  const anonKey = stringValue(input.anonKey, "anonKey", 4096);
  if (Number.isNaN(Number(input.expiresAt))) throw new Error("expiresAt is invalid");
  return {
    version: 1,
    supabaseUrl: supabaseUrl.toString().replace(/\/$/, ""),
    anonKey,
    pairingToken,
    expiresAt: Number(input.expiresAt),
  };
}

export function buildAndroidPairingUri(payload: AndroidPairingPayload): string {
  const normalized = createAndroidPairingPayload(payload);
  return `floatbridge://pair?payload=${encodeURIComponent(JSON.stringify(normalized))}`;
}

/** Validate and canonicalize the six explicit MVP action payloads before they leave Float. */
export function validateAndroidActionPayload(
  action: AndroidBridgeAction,
  input: Record<string, unknown>,
): Record<string, string> {
  if (!isAction(action)) throw new Error("unsupported Android action");
  const source = recordOf(input);
  const output: Record<string, string> = {};
  for (const field of ACTION_FIELDS[action]) {
    output[field] = stringValue(source[field], field, field === "text" ? 4000 : 400);
  }
  if (action === "open_url" && !/^https:\/\//i.test(output.url)) {
    throw new Error("open_url only accepts HTTPS URLs");
  }
  if (action === "open_app" && !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(output.package)) {
    throw new Error("package name is invalid");
  }
  if (action === "dial_phone" && !/^[0-9+*#() .-]{3,32}$/.test(output.phone)) {
    throw new Error("phone number is invalid");
  }
  return output;
}

export function normalizeAndroidDevice(row: unknown): AndroidDevice {
  const value = recordOf(row);
  const capabilities = Array.isArray(value.capabilities)
    ? value.capabilities.filter(isAction)
    : [];
  return {
    deviceId: String(value.device_id ?? value.deviceId ?? ""),
    deviceName: String(value.device_name ?? value.deviceName ?? "Android device"),
    capabilities,
    online: value.online === true,
    batteryPercent: typeof value.battery_percent === "number" ? value.battery_percent : null,
    network: String(value.network ?? ""),
    androidVersion: String(value.android_version ?? ""),
    lastSeen: optionalString(value.last_seen ?? value.lastSeen),
    createdAt: optionalString(value.created_at ?? value.createdAt),
    updatedAt: optionalString(value.updated_at ?? value.updatedAt),
  };
}

export function normalizeAndroidCommand(row: unknown): AndroidCommand {
  const value = recordOf(row);
  const action = value.action;
  if (!isAction(action)) throw new Error("unsupported Android command action");
  const rawPayload = recordOf(value.payload);
  const payload: Record<string, string> = {};
  for (const [key, item] of Object.entries(rawPayload)) {
    if (typeof item === "string") payload[key] = item;
  }
  return {
    id: String(value.id ?? ""),
    deviceId: String(value.device_id ?? value.deviceId ?? ""),
    action,
    payload,
    requireConfirm: value.require_confirm === true || value.requireConfirm === true,
    ttlSeconds: Math.max(1, Number(value.ttl_seconds ?? value.ttlSeconds) || 60),
    createdAt: String(value.created_at ?? value.createdAt ?? ""),
  };
}

export function normalizeAndroidResult(row: unknown): AndroidResult {
  const value = recordOf(row);
  const status = value.status;
  if (status !== "success" && status !== "failed" && status !== "rejected") {
    throw new Error("unsupported Android result status");
  }
  const rawResult = recordOf(value.result);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(rawResult)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      result[key] = String(item);
    }
  }
  return {
    commandId: String(value.command_id ?? value.commandId ?? ""),
    deviceId: String(value.device_id ?? value.deviceId ?? ""),
    status,
    result,
    errorCode: optionalString(value.error_code ?? value.errorCode),
    errorMessage: optionalString(value.error_message ?? value.errorMessage),
    completedAt: String(value.completed_at ?? value.completedAt ?? ""),
  };
}
