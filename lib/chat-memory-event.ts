import type { ChatMessage } from "./chat-storage";
import type { FutureIntentEvent } from "./future-intent-detector";

/** Convert the message returned by pushChatMessage into immutable memory provenance. */
export function toFutureIntentEvent(
    message: Pick<ChatMessage, "id" | "sessionId" | "createdAt" | "content" | "responseBatchId">,
    sourceDetail: "direct" | "group" = "direct",
): FutureIntentEvent {
    return {
        id: message.id,
        sourceApp: "chat",
        sourceDetail,
        timestamp: message.createdAt,
        content: message.content,
        sessionId: message.sessionId,
        ...(message.responseBatchId ? { responseBatchId: message.responseBatchId } : {}),
    };
}

/** Collapse rendered bubbles from one assistant response without losing native provenance. */
export function mergeFutureIntentResponseBatch(events: readonly FutureIntentEvent[]): FutureIntentEvent {
    if (events.length === 0) throw new Error("Cannot merge an empty Future Intent response batch");
    const ordered = [...events].sort((left, right) => {
        const timeDelta = Date.parse(left.timestamp) - Date.parse(right.timestamp);
        return Number.isFinite(timeDelta) && timeDelta !== 0 ? timeDelta : 0;
    });
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    const sourceEventRefs = ordered.flatMap(event => event.sourceEventRefs?.length ? event.sourceEventRefs : [event.id]);
    return {
        ...first,
        id: first.id,
        timestamp: last.timestamp,
        content: ordered.map(event => {
            const refs = event.sourceEventRefs?.length ? event.sourceEventRefs : [event.id];
            return `[event_ref=${refs.join(",")}] ${event.content}`;
        }).join("\n"),
        sourceEventRefs: [...new Set(sourceEventRefs)],
    };
}
