import type { ChatMessage } from "./chat-storage";
import type { FutureIntentEvent } from "./future-intent-detector";

/** Convert the message returned by pushChatMessage into immutable memory provenance. */
export function toFutureIntentEvent(
    message: Pick<ChatMessage, "id" | "sessionId" | "createdAt" | "content">,
    sourceDetail: "direct" | "group" = "direct",
): FutureIntentEvent {
    return {
        id: message.id,
        sourceApp: "chat",
        sourceDetail,
        timestamp: message.createdAt,
        content: message.content,
        sessionId: message.sessionId,
    };
}
