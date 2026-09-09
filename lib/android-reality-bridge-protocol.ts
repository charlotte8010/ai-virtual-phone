export const ANDROID_BRIDGE_ACTIONS = [
  "open_app",
  "open_url",
  "open_map",
  "dial_phone",
  "share_text",
  "show_notification",
] as const;

/** Shared Reality Bridge wire contract. Native execution is added in a later phase. */
export const REALITY_PROTOCOL_VERSION = 1 as const;
export const REALITY_NATIVE_CHANNEL_NAME = "FloatRealityChannel" as const;
export const REALITY_NATIVE_CHANNEL_ID = "float.reality" as const;
export const REALITY_APP_PERMISSIONS = [
  "reality.capabilities.read",
  "reality.permission.read",
  "reality.device.action",
] as const;

export const REALITY_HOST_ACTIONS = [
  "reality.getCapabilities",
  "reality.getPermissionState",
  "reality.execute",
] as const;

export type RealityAppPermission = (typeof REALITY_APP_PERMISSIONS)[number];
export type RealityHostAction = (typeof REALITY_HOST_ACTIONS)[number];
export type RealityTransportKind = "local_native" | "remote_cloud";
export type RealityNativeOperation = "prepareBinding" | "getCapabilities" | "getPermissionState" | "execute";
export type RealityPermissionStatus = "granted" | "denied" | "prompt" | "unavailable" | "unknown";

export class RealityProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RealityProtocolError";
    this.code = code;
  }
}

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

export type RealityCommand = {
  protocolVersion: typeof REALITY_PROTOCOL_VERSION;
  commandId: string;
  deviceId: string;
  action: AndroidBridgeAction;
  payload: Record<string, string>;
  requireConfirm: boolean;
  ttlSeconds: number;
  createdAt: string;
};

export type RealityCommandResult = {
  protocolVersion: typeof REALITY_PROTOCOL_VERSION;
  transport: RealityTransportKind;
  commandId: string;
  deviceId: string;
  status: AndroidResultStatus;
  result: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  completedAt: string;
};

export type RealityDeviceSummary = {
  deviceId: string;
  deviceName: string;
  actions: AndroidBridgeAction[];
  online: boolean;
};

export type RealityCapabilities = {
  protocolVersion: typeof REALITY_PROTOCOL_VERSION;
  transport: RealityTransportKind;
  deviceId: string | null;
  deviceName: string | null;
  online: boolean;
  actions: AndroidBridgeAction[];
  devices?: RealityDeviceSummary[];
};

export type RealityPermissionState = {
  protocolVersion: typeof REALITY_PROTOCOL_VERSION;
  transport: RealityTransportKind;
  deviceId: string | null;
  bound: boolean;
  canExecute: boolean;
  nativePermissions: Record<string, RealityPermissionStatus>;
};

export type RealityNativeRequest = {
  protocolVersion: typeof REALITY_PROTOCOL_VERSION;
  channel: typeof REALITY_NATIVE_CHANNEL_ID;
  requestId: string;
  operation: RealityNativeOperation;
  bindingNonce?: string;
  command?: RealityCommand;
};

export type RealityNativeResponse = {
  protocolVersion: typeof REALITY_PROTOCOL_VERSION;
  channel: typeof REALITY_NATIVE_CHANNEL_ID;
  requestId: string;
  operation: RealityNativeOperation;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
};

export type RealityBindingMaterial = {
  protocolVersion: typeof REALITY_PROTOCOL_VERSION;
  deviceId: string;
  nonce: string;
  publicKey: string | null;
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

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new RealityProtocolError("INVALID_INPUT", `${field} must be text`);
  const text = value.trim();
  if (!text || text.length > maxLength) {
    throw new RealityProtocolError("INVALID_INPUT", `${field} is invalid`);
  }
  return text;
}

function optionalNullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function generatedId(prefix: string): string {
  const randomUuid = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : Math.random().toString(36).slice(2, 14);
  return `${prefix}_${Date.now().toString(36)}_${randomUuid.replace(/-/g, "").slice(0, 32)}`;
}

/** Generated by the authenticated Float Host for a single local binding attempt. */
export function createRealityBindingNonce(): string {
  const randomUuid = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  return randomUuid.replace(/-/g, "");
}

function transportKind(value: unknown): RealityTransportKind {
  if (value === "local_native" || value === "remote_cloud") return value;
  throw new RealityProtocolError("INVALID_TRANSPORT", "unsupported Reality transport");
}

function nativePermissionStatus(value: unknown): RealityPermissionStatus | null {
  return value === "granted" || value === "denied" || value === "prompt"
    || value === "unavailable" || value === "unknown"
    ? value
    : null;
}

export function createRealityCommand(input: {
  commandId?: string;
  deviceId: string;
  action: AndroidBridgeAction;
  payload: Record<string, unknown>;
  requireConfirm?: boolean;
  ttlSeconds?: number;
  createdAt?: string;
}): RealityCommand {
  const commandId = input.commandId === undefined
    ? generatedId("reality")
    : requiredText(input.commandId, "commandId", 160);
  if (!COMMAND_ID_PATTERN.test(commandId)) {
    throw new RealityProtocolError("INVALID_COMMAND_ID", "commandId is invalid");
  }
  const deviceId = requiredText(input.deviceId, "deviceId", 128);
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new RealityProtocolError("INVALID_DEVICE_ID", "deviceId is invalid");
  }
  if (!isAction(input.action)) {
    throw new RealityProtocolError("UNSUPPORTED_ACTION", "unsupported Android Reality action");
  }
  const payload = validateAndroidActionPayload(input.action, input.payload);
  const ttlSeconds = input.ttlSeconds === undefined ? 60 : Number(input.ttlSeconds);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 900) {
    throw new RealityProtocolError("INVALID_TTL", "ttlSeconds is invalid");
  }
  const createdAt = input.createdAt === undefined ? new Date().toISOString() : requiredText(input.createdAt, "createdAt", 80);
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new RealityProtocolError("INVALID_TIMESTAMP", "createdAt is invalid");
  }
  return {
    protocolVersion: REALITY_PROTOCOL_VERSION,
    commandId,
    deviceId,
    action: input.action,
    payload,
    requireConfirm: input.requireConfirm === true,
    ttlSeconds,
    createdAt: new Date(Date.parse(createdAt)).toISOString(),
  };
}

export function createRealityNativeRequest(input: {
  requestId: string;
  operation: RealityNativeOperation;
  bindingNonce?: string;
  command?: RealityCommand;
}): RealityNativeRequest {
  const requestId = requiredText(input.requestId, "requestId", 160);
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new RealityProtocolError("INVALID_REQUEST_ID", "requestId is invalid");
  }
  if (input.operation === "prepareBinding" && !input.bindingNonce) {
    throw new RealityProtocolError("INVALID_BINDING", "prepareBinding requires nonce");
  }
  if (input.operation !== "prepareBinding" && input.bindingNonce !== undefined) {
    throw new RealityProtocolError("INVALID_BINDING", "binding nonce is only valid for prepareBinding");
  }
  if (input.bindingNonce !== undefined && !NONCE_PATTERN.test(input.bindingNonce)) {
    throw new RealityProtocolError("INVALID_BINDING", "binding nonce is invalid");
  }
  if (input.operation === "execute" && !input.command) {
    throw new RealityProtocolError("INVALID_REQUEST", "execute requires command");
  }
  if (input.operation !== "getCapabilities" && input.operation !== "getPermissionState"
    && input.operation !== "execute" && input.operation !== "prepareBinding") {
    throw new RealityProtocolError("INVALID_OPERATION", "operation is invalid");
  }
  return {
    protocolVersion: REALITY_PROTOCOL_VERSION,
    channel: REALITY_NATIVE_CHANNEL_ID,
    requestId,
    operation: input.operation,
    ...(input.bindingNonce ? { bindingNonce: input.bindingNonce } : {}),
    ...(input.command ? { command: input.command } : {}),
  };
}

export function parseRealityNativeRequest(input: unknown): RealityNativeRequest {
  const value = recordOf(input);
  if (value.protocolVersion !== REALITY_PROTOCOL_VERSION) {
    throw new RealityProtocolError("INVALID_VERSION", "protocolVersion is unsupported");
  }
  if (value.channel !== REALITY_NATIVE_CHANNEL_ID) {
    throw new RealityProtocolError("INVALID_CHANNEL", "channel is unsupported");
  }
  const operation = value.operation;
  if (operation !== "getCapabilities" && operation !== "getPermissionState"
    && operation !== "execute" && operation !== "prepareBinding") {
    throw new RealityProtocolError("INVALID_OPERATION", "operation is invalid");
  }
  const requestId = requiredText(value.requestId, "requestId", 160);
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new RealityProtocolError("INVALID_REQUEST_ID", "requestId is invalid");
  }
  const bindingNonce = typeof value.bindingNonce === "string" ? value.bindingNonce : undefined;
  if (operation === "prepareBinding" && !bindingNonce) {
    throw new RealityProtocolError("INVALID_BINDING", "prepareBinding requires nonce");
  }
  if (operation !== "prepareBinding" && bindingNonce !== undefined) {
    throw new RealityProtocolError("INVALID_BINDING", "binding nonce is only valid for prepareBinding");
  }
  if (bindingNonce !== undefined && !NONCE_PATTERN.test(bindingNonce)) {
    throw new RealityProtocolError("INVALID_BINDING", "binding nonce is invalid");
  }
  let command: RealityCommand | undefined;
  if (operation === "execute") {
    const raw = recordOf(value.command);
    command = createRealityCommand({
      commandId: typeof raw.commandId === "string" ? raw.commandId : undefined,
      deviceId: String(raw.deviceId ?? ""),
      action: raw.action as AndroidBridgeAction,
      payload: recordOf(raw.payload),
      requireConfirm: raw.requireConfirm === true,
      ttlSeconds: typeof raw.ttlSeconds === "number" ? raw.ttlSeconds : undefined,
      createdAt: String(raw.createdAt ?? ""),
    });
  }
  return createRealityNativeRequest({ requestId, operation, bindingNonce, command });
}

export function normalizeRealityCapabilities(input: unknown): RealityCapabilities {
  const value = recordOf(input);
  const devices = Array.isArray(value.devices)
    ? value.devices.map(item => {
      const device = recordOf(item);
      const rawActions = device.actions ?? device.capabilities;
      return {
        deviceId: String(device.deviceId ?? device.device_id ?? ""),
        deviceName: String(device.deviceName ?? device.device_name ?? "Android device"),
        actions: Array.isArray(rawActions)
          ? rawActions.filter(isAction)
          : [],
        online: device.online === true,
      } satisfies RealityDeviceSummary;
    }).filter(device => device.deviceId)
    : undefined;
  const rawActions = value.actions ?? value.capabilities;
  return {
    protocolVersion: REALITY_PROTOCOL_VERSION,
    transport: transportKind(value.transport),
    deviceId: optionalNullableText(value.deviceId ?? value.device_id),
    deviceName: optionalNullableText(value.deviceName ?? value.device_name),
    online: value.online === true,
    actions: Array.isArray(rawActions)
      ? rawActions.filter(isAction)
      : [],
    ...(devices ? { devices } : {}),
  };
}

export function normalizeRealityPermissionState(input: unknown): RealityPermissionState {
  const value = recordOf(input);
  const rawPermissions = recordOf(value.nativePermissions ?? value.native_permissions);
  const nativePermissions: Record<string, RealityPermissionStatus> = {};
  for (const [key, rawStatus] of Object.entries(rawPermissions)) {
    const status = nativePermissionStatus(rawStatus);
    if (key && status) nativePermissions[key.slice(0, 120)] = status;
  }
  return {
    protocolVersion: REALITY_PROTOCOL_VERSION,
    transport: transportKind(value.transport),
    deviceId: optionalNullableText(value.deviceId ?? value.device_id),
    bound: value.bound === true,
    canExecute: value.canExecute === true || value.can_execute === true,
    nativePermissions,
  };
}

export function normalizeRealityCommandResult(input: unknown, transport: RealityTransportKind): RealityCommandResult {
  const value = recordOf(input);
  const status = value.status;
  if (status !== "success" && status !== "failed" && status !== "rejected") {
    throw new RealityProtocolError("INVALID_RESULT", "result status is invalid");
  }
  return {
    protocolVersion: REALITY_PROTOCOL_VERSION,
    transport,
    commandId: String(value.commandId ?? value.command_id ?? ""),
    deviceId: String(value.deviceId ?? value.device_id ?? ""),
    status,
    result: recordOf(value.result),
    errorCode: optionalNullableText(value.errorCode ?? value.error_code),
    errorMessage: optionalNullableText(value.errorMessage ?? value.error_message),
    completedAt: String(value.completedAt ?? value.completed_at ?? ""),
  };
}

export function normalizeRealityNativeResponse(input: unknown): RealityNativeResponse {
  const value = recordOf(input);
  if (value.protocolVersion !== REALITY_PROTOCOL_VERSION || value.channel !== REALITY_NATIVE_CHANNEL_ID) {
    throw new RealityProtocolError("INVALID_RESPONSE", "native Reality response is invalid");
  }
  const operation = value.operation;
  if (operation !== "getCapabilities" && operation !== "getPermissionState"
    && operation !== "execute" && operation !== "prepareBinding") {
    throw new RealityProtocolError("INVALID_RESPONSE", "native Reality response operation is invalid");
  }
  const requestId = requiredText(value.requestId, "requestId", 160);
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new RealityProtocolError("INVALID_RESPONSE", "native Reality response requestId is invalid");
  }
  const errorValue = recordOf(value.error);
  const errorCode = optionalNullableText(errorValue.code);
  const errorMessage = optionalNullableText(errorValue.message);
  return {
    protocolVersion: REALITY_PROTOCOL_VERSION,
    channel: REALITY_NATIVE_CHANNEL_ID,
    requestId,
    operation,
    ok: value.ok === true,
    ...(Object.prototype.hasOwnProperty.call(value, "result") ? { result: value.result } : {}),
    ...(errorCode && errorMessage ? { error: { code: errorCode, message: errorMessage } } : {}),
  };
}

export function normalizeRealityBindingMaterial(input: unknown): RealityBindingMaterial {
  const value = recordOf(input);
  const nonce = requiredText(value.nonce ?? value.bindingNonce, "nonce", 256);
  if (!NONCE_PATTERN.test(nonce)) {
    throw new RealityProtocolError("INVALID_BINDING", "binding nonce is invalid");
  }
  const deviceId = requiredText(value.deviceId ?? value.device_id, "deviceId", 128);
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new RealityProtocolError("INVALID_DEVICE_ID", "deviceId is invalid");
  }
  const publicKey = optionalNullableText(value.publicKey ?? value.public_key);
  return {
    protocolVersion: REALITY_PROTOCOL_VERSION,
    deviceId,
    nonce,
    publicKey,
  };
}

export function realityHostPermissionForAction(action: string): readonly RealityAppPermission[] {
  if (action === "reality.getCapabilities") return ["reality.capabilities.read"];
  if (action === "reality.getPermissionState") return ["reality.permission.read"];
  if (action === "reality.execute") return ["reality.device.action"];
  throw new RealityProtocolError("UNSUPPORTED_HOST_ACTION", "unsupported Reality host action");
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
