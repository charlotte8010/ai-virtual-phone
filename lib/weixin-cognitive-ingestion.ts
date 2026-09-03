import type { ChatMessage } from "./chat-storage";

export type WeixinCloudCognitiveCursor = {
    version: 1;
    initialized: boolean;
    latest?: {
        timestamp: string;
        externalId: string;
    };
};

type WeixinCloudCursorMessage = {
    direction: "inbound" | "outbound" | "local";
    role: "user" | "assistant" | "system";
    externalId: string;
    receivedAt?: string;
    createdAt?: string;
};

type ImportedMessageResult = {
    message: Pick<ChatMessage, "id" | "role" | "cloudSync">;
    inserted: boolean;
};

function cursorKey(message: WeixinCloudCursorMessage): { timestamp: string; externalId: string } | null {
    const timestamp = (message.receivedAt || message.createdAt || "").trim();
    const externalId = message.externalId.trim();
    if (!timestamp || !externalId) return null;
    return { timestamp, externalId };
}

function compareCursorKey(
    left: { timestamp: string; externalId: string },
    right: { timestamp: string; externalId: string },
): number {
    const timestampOrder = left.timestamp.localeCompare(right.timestamp);
    return timestampOrder !== 0 ? timestampOrder : left.externalId.localeCompare(right.externalId);
}

export function isRealtimeWeixinCloudMessage(
    message: WeixinCloudCursorMessage,
    cursor: WeixinCloudCognitiveCursor,
): boolean {
    if (!cursor.initialized) return false;
    if (message.direction === "local") return false;
    if (message.direction !== "inbound" && message.direction !== "outbound") return false;
    if (message.role !== "user" && message.role !== "assistant") return false;
    const key = cursorKey(message);
    if (!key) return false;
    return !cursor.latest || compareCursorKey(key, cursor.latest) > 0;
}

export function advanceWeixinCloudCognitiveCursor(
    cursor: WeixinCloudCognitiveCursor,
    message: WeixinCloudCursorMessage,
): WeixinCloudCognitiveCursor {
    const key = cursorKey(message);
    if (!key) return { ...cursor, initialized: true };
    if (cursor.latest && compareCursorKey(key, cursor.latest) <= 0) {
        return { ...cursor, initialized: true };
    }
    return { version: 1, initialized: true, latest: key };
}

export function shouldIngestWeixinImportedMessage(
    result: ImportedMessageResult,
    realtime: boolean,
): boolean {
    if (!realtime || !result.inserted) return false;
    const sync = result.message.cloudSync;
    if (sync?.source !== "weixin-cloud") return false;
    if (sync.direction !== "inbound" && sync.direction !== "outbound") return false;
    return result.message.role === "user" || result.message.role === "assistant";
}
