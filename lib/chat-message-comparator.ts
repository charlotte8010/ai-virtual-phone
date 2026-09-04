import type { ChatMessage } from "./chat-storage";

export function areChatMessagesEqualForBubble(previous: ChatMessage, next: ChatMessage): boolean {
    if (previous === next) return true;
    if (previous.id !== next.id) return false;
    if (previous.content !== next.content) return false;
    if (previous.mediaType !== next.mediaType) return false;
    if (previous.isRetracted !== next.isRetracted) return false;
    if (previous.isTyping !== next.isTyping) return false;
    if (previous.mediaData?.status !== next.mediaData?.status) return false;
    if (previous.mediaData?.label !== next.mediaData?.label) return false;
    if (previous.mediaData?.claimedBy?.length !== next.mediaData?.claimedBy?.length) return false;
    if (previous.mediaData?.appName !== next.mediaData?.appName) return false;
    if (previous.mediaData?.appCardTitle !== next.mediaData?.appCardTitle) return false;
    if (previous.mediaData?.appCardBody !== next.mediaData?.appCardBody) return false;
    if (previous.mediaData?.appCardLayout !== next.mediaData?.appCardLayout) return false;
    if (previous.mediaData?.imageGenerationPrompt !== next.mediaData?.imageGenerationPrompt) return false;
    if (previous.mediaData?.imageGenerationStatus !== next.mediaData?.imageGenerationStatus) return false;
    if (previous.mediaData?.imageGenerationError !== next.mediaData?.imageGenerationError) return false;
    if (previous.mediaType?.startsWith("plugin:") && previous.mediaData !== next.mediaData) return false;
    if (previous.mediaUrl !== next.mediaUrl) return false;
    return true;
}
