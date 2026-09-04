export const CHAT_MESSAGES_UPDATED_EVENT = "chat-messages-updated";

export function dispatchChatMessagesUpdated(sessionId: string, messageId?: string): void {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent(CHAT_MESSAGES_UPDATED_EVENT, {
        detail: {
            sessionId,
            ...(messageId ? { messageId } : {}),
        },
    }));
}
