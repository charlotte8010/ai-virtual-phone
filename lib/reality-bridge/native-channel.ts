import {
  createRealityNativeRequest,
  normalizeRealityNativeResponse,
  type RealityCommand,
  type RealityDeviceCredentials,
  type RealityNativeOperation,
} from "../android-reality-bridge-protocol";

export type RealityChannelMessageEvent = {
  data: unknown;
};

export type RealityChannelEndpoint = {
  postMessage(message: string): void;
  addEventListener(type: "message", listener: (event: RealityChannelMessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: RealityChannelMessageEvent) => void): void;
};

export type NativeRealityChannel = {
  request(
    operation: RealityNativeOperation,
    command?: RealityCommand,
    bindingNonce?: string,
    credentials?: RealityDeviceCredentials,
  ): Promise<unknown>;
};

type RealityWindow = Window & {
  FloatRealityChannel?: RealityChannelEndpoint;
};

const REQUEST_TIMEOUT_MS = 15_000;

function createRequestId(): string {
  const randomUuid = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : Math.random().toString(36).slice(2, 14);
  return `host_${Date.now().toString(36)}_${randomUuid.replace(/-/g, "").slice(0, 32)}`;
}

function decodeResponse(data: unknown): unknown {
  if (typeof data !== "string") return data;
  try {
    return JSON.parse(data) as unknown;
  } catch {
    return null;
  }
}

/** Returns the origin-scoped WebMessageListener object injected into the top page. */
export function getBrowserRealityChannel(scope?: Window): RealityChannelEndpoint | null {
  if (!scope && typeof window === "undefined") return null;
  const channel = ((scope ?? window) as RealityWindow).FloatRealityChannel;
  if (!channel || typeof channel.postMessage !== "function"
    || typeof channel.addEventListener !== "function"
    || typeof channel.removeEventListener !== "function") {
    return null;
  }
  return channel;
}

/**
 * Browser-side adapter for AndroidX WebMessageListener.
 * The injected object is intentionally only used by the top-level Float page;
 * custom-app iframes reach it through the runner's permission-checked host API.
 */
export class BrowserNativeRealityChannel implements NativeRealityChannel {
  private readonly pending = new Map<string, {
    operation: RealityNativeOperation;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  private readonly onMessage = (event: RealityChannelMessageEvent) => {
    const raw = decodeResponse(event.data);
    if (!raw || typeof raw !== "object") return;
    let response: ReturnType<typeof normalizeRealityNativeResponse>;
    try {
      response = normalizeRealityNativeResponse(raw);
    } catch {
      return;
    }
    const pending = this.pending.get(response.requestId);
    if (!pending) return;
    if (pending.operation !== response.operation) return;
    this.pending.delete(response.requestId);
    clearTimeout(pending.timer);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error?.message || "Native Reality request failed"));
  };

  constructor(private readonly endpoint: RealityChannelEndpoint) {
    endpoint.addEventListener("message", this.onMessage);
  }

  request(
    operation: RealityNativeOperation,
    command?: RealityCommand,
    bindingNonce?: string,
    credentials?: RealityDeviceCredentials,
  ): Promise<unknown> {
    const requestId = createRequestId();
    const request = createRealityNativeRequest({ requestId, operation, command, bindingNonce, credentials });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("Native Reality request timed out"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(requestId, { operation, resolve, reject, timer });
      try {
        this.endpoint.postMessage(JSON.stringify(request));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  dispose(): void {
    this.endpoint.removeEventListener("message", this.onMessage);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Native Reality channel disposed"));
    }
    this.pending.clear();
  }
}
