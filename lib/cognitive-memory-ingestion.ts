import type { ChatMessage } from "./chat-storage";
import { dbWaitForMessagePersistence } from "./chat-db";
import { incrementEventCounter } from "./memory-storage";
import { toFutureIntentEvent } from "./chat-memory-event";

export type CognitiveMessageIngestionInput = {
    characterId: string;
    characterName: string;
    message: Pick<ChatMessage, "id" | "sessionId" | "createdAt" | "content" | "role">;
};

type CognitiveMessageIngestionOptions = {
    persistenceConfirmed?: boolean;
};

type PersistedIngestionState = {
    tail: Promise<void>;
    pendingByEventId: Map<string, Promise<boolean>>;
    processedEventIds: Set<string>;
    processedOrder: string[];
};

const MAX_PROCESSED_EVENT_IDS = 256;
const persistedIngestionStates = new Map<string, PersistedIngestionState>();

function getPersistedIngestionState(characterId: string): PersistedIngestionState {
    const existing = persistedIngestionStates.get(characterId);
    if (existing) return existing;
    const created: PersistedIngestionState = {
        tail: Promise.resolve(),
        pendingByEventId: new Map(),
        processedEventIds: new Set(),
        processedOrder: [],
    };
    persistedIngestionStates.set(characterId, created);
    return created;
}

function rememberProcessedEvent(state: PersistedIngestionState, eventId: string): void {
    if (state.processedEventIds.has(eventId)) return;
    state.processedEventIds.add(eventId);
    state.processedOrder.push(eventId);
    if (state.processedOrder.length > MAX_PROCESSED_EVENT_IDS) {
        const oldest = state.processedOrder.shift();
        if (oldest) state.processedEventIds.delete(oldest);
    }
}

function scheduleSummarization(input: CognitiveMessageIngestionInput): void {
    if (input.message.role !== "assistant" || typeof window === "undefined") return;
    void import("./memory-summarizer")
        .then(({ maybeRunSummarization }) => maybeRunSummarization(input.characterId, input.characterName))
        .catch(error => console.warn("[CognitiveMemory] Memory summarization check failed:", error));
}

function buildEvent(input: CognitiveMessageIngestionInput) {
    if (input.message.role !== "user" && input.message.role !== "assistant") return null;
    return toFutureIntentEvent(input.message, "direct");
}

/** Run the existing Chat cognitive lifecycle for one exact persisted message. */
export function ingestCognitiveMessageEvent(
    input: CognitiveMessageIngestionInput,
    options: CognitiveMessageIngestionOptions = {},
): Promise<boolean> {
    const event = buildEvent(input);
    if (!event) return Promise.resolve(false);

    if (options.persistenceConfirmed !== true) {
        incrementEventCounter(input.characterId, event);
        scheduleSummarization(input);
        return Promise.resolve(true);
    }

    const state = getPersistedIngestionState(input.characterId);
    const existing = state.pendingByEventId.get(event.id);
    if (existing) return existing;
    if (state.processedEventIds.has(event.id)) return Promise.resolve(true);

    const next = state.tail.then(async () => {
        if (state.processedEventIds.has(event.id)) return true;
        if (!await dbWaitForMessagePersistence(event.id)) return false;
        incrementEventCounter(input.characterId, event, { persistenceConfirmed: true });
        rememberProcessedEvent(state, event.id);
        scheduleSummarization(input);
        return true;
    }).catch(error => {
        console.warn("[CognitiveMemory] Persisted event ingestion failed:", error);
        return false;
    });
    state.pendingByEventId.set(event.id, next);
    state.tail = next.then(() => undefined, () => undefined);
    void next.then(
        () => { if (state.pendingByEventId.get(event.id) === next) state.pendingByEventId.delete(event.id); },
        () => { if (state.pendingByEventId.get(event.id) === next) state.pendingByEventId.delete(event.id); },
    );
    return next;
}
