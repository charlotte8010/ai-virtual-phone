import { jsonrepair } from "jsonrepair";
import type {
    FutureIntentMeta,
    FutureIntentStatus,
    FutureIntentType,
    MemoryKind,
    MemoryMood,
    TimePrecision,
} from "./memory-types";

export interface ExtractedMemoryCandidate {
    content: string;
    tags: string[];
    importance: number;
    mood?: MemoryMood;
    kind: MemoryKind;
    futureIntent?: FutureIntentMeta;
    sourceEventRefs?: string[];
}

export interface MemoryExtractionResult {
    memories: ExtractedMemoryCandidate[];
    mode: "structured" | "plain_text_fallback";
}

const MAX_MEMORIES_PER_BATCH = 8;
const MAX_TAGS_PER_MEMORY = 6;
const MAX_TAG_LENGTH = 32;
const MAX_CONTENT_LENGTH = 2000;
const MAX_SOURCE_REFS = 32;

const MEMORY_KINDS: readonly MemoryKind[] = [
    "event",
    "relationship",
    "user_fact",
    "self_fact",
    "knowledge",
    "future_intent",
];

const MEMORY_MOODS: readonly MemoryMood[] = [
    "neutral",
    "happy",
    "tender",
    "excited",
    "sad",
    "angry",
    "anxious",
    "afraid",
    "jealous",
    "embarrassed",
    "lonely",
    "nostalgic",
];

const FUTURE_INTENT_TYPES: readonly FutureIntentType[] = [
    "plan",
    "promise",
    "goal",
    "wish",
    "expectation",
];

const FUTURE_INTENT_STATUSES: readonly FutureIntentStatus[] = [
    "pending",
    "overdue",
    "fulfilled",
    "cancelled",
];

const TIME_PRECISIONS: readonly TimePrecision[] = [
    "exact",
    "day",
    "range",
    "vague",
    "unknown",
];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown, maxLength: number): string | undefined {
    if (typeof value !== "string") return undefined;
    const normalized = value.trim();
    return normalized ? normalized.slice(0, maxLength) : undefined;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
    return typeof value === "string" && values.includes(value as T);
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function sanitizeTags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const unique = new Set<string>();
    for (const tag of value) {
        if (typeof tag !== "string") continue;
        const normalized = tag.trim().slice(0, MAX_TAG_LENGTH);
        if (normalized) unique.add(normalized);
        if (unique.size >= MAX_TAGS_PER_MEMORY) break;
    }
    return Array.from(unique);
}

function sanitizeSourceRefs(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const unique = new Set<string>();
    for (const ref of value) {
        if (typeof ref !== "string") continue;
        const normalized = ref.trim();
        if (normalized) unique.add(normalized);
        if (unique.size >= MAX_SOURCE_REFS) break;
    }
    const refs = Array.from(unique);
    return refs.length > 0 ? refs : undefined;
}

function sanitizeFutureIntent(value: unknown): FutureIntentMeta {
    const raw = isRecord(value) ? value : {};
    const type = isOneOf(raw.type, FUTURE_INTENT_TYPES) ? raw.type : "expectation";
    const status = isOneOf(raw.status, FUTURE_INTENT_STATUSES) ? raw.status : "pending";
    const timePrecision = isOneOf(raw.timePrecision, TIME_PRECISIONS)
        ? raw.timePrecision
        : "unknown";
    return {
        type,
        status,
        timePrecision,
        targetAt: asTrimmedString(raw.targetAt, 100),
        targetEndAt: asTrimmedString(raw.targetEndAt, 100),
        timezone: asTrimmedString(raw.timezone, 80),
        originalTimeExpression: asTrimmedString(raw.originalTimeExpression, 200),
        fulfilledAt: asTrimmedString(raw.fulfilledAt, 100),
        cancelledAt: asTrimmedString(raw.cancelledAt, 100),
        replacedByMemoryId: asTrimmedString(raw.replacedByMemoryId, 100),
    };
}

export function sanitizeExtractedMemory(raw: unknown): ExtractedMemoryCandidate | null {
    if (!isRecord(raw)) return null;
    const content = asTrimmedString(raw.content, MAX_CONTENT_LENGTH);
    if (!content) return null;

    const rawImportance = typeof raw.importance === "number"
        ? raw.importance
        : typeof raw.importance === "string"
            ? Number(raw.importance)
            : 0.5;
    const importance = clamp(Number.isFinite(rawImportance) ? rawImportance : 0.5, 0, 1);
    const kind = isOneOf(raw.kind, MEMORY_KINDS) ? raw.kind : "event";
    const mood = isOneOf(raw.mood, MEMORY_MOODS) ? raw.mood : undefined;
    const futureIntent = kind === "future_intent"
        ? sanitizeFutureIntent(raw.futureIntent)
        : undefined;
    const sourceEventRefs = sanitizeSourceRefs(raw.sourceEventRefs);

    return {
        content,
        tags: sanitizeTags(raw.tags),
        importance,
        ...(mood ? { mood } : {}),
        kind,
        ...(futureIntent ? { futureIntent } : {}),
        ...(sourceEventRefs ? { sourceEventRefs } : {}),
    };
}

function extractCodeBlocks(text: string): string[] {
    const blocks: string[] = [];
    const pattern = /```(?:json)?\s*([\s\S]*?)```/gi;
    for (const match of text.matchAll(pattern)) {
        if (match[1]) blocks.push(match[1].trim());
    }
    return blocks;
}

function extractJsonFragment(text: string): string | undefined {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return undefined;
    return text.slice(start, end + 1);
}

function parseJsonCandidate(candidate: string): unknown | undefined {
    try {
        return JSON.parse(candidate) as unknown;
    } catch {
        try {
            return JSON.parse(jsonrepair(candidate)) as unknown;
        } catch {
            return undefined;
        }
    }
}

function parseStructuredPayload(text: string): unknown | undefined {
    const candidates = [
        text.trim(),
        ...extractCodeBlocks(text),
    ];
    const fragment = extractJsonFragment(text);
    if (fragment) candidates.push(fragment);

    for (const candidate of candidates) {
        const parsed = parseJsonCandidate(candidate);
        if (Array.isArray(parsed) || (isRecord(parsed) && Array.isArray(parsed.memories))) {
            return parsed;
        }
    }
    return undefined;
}

function getRawMemories(payload: unknown): unknown[] | undefined {
    if (Array.isArray(payload)) return payload;
    if (isRecord(payload) && Array.isArray(payload.memories)) return payload.memories;
    return undefined;
}

function buildPlainTextFallback(text: string): ExtractedMemoryCandidate[] {
    const candidate = sanitizeExtractedMemory({
        content: text,
        tags: [],
        importance: 0.8,
        kind: "event",
    });
    return candidate ? [candidate] : [];
}

export function extractMemoriesFromModelOutput(text: string): MemoryExtractionResult {
    const output = text.trim();
    const payload = parseStructuredPayload(output);
    const rawMemories = getRawMemories(payload);
    if (rawMemories) {
        return {
            memories: rawMemories
                .map(sanitizeExtractedMemory)
                .filter((memory): memory is ExtractedMemoryCandidate => memory !== null)
                .slice(0, MAX_MEMORIES_PER_BATCH),
            mode: "structured",
        };
    }
    return {
        memories: buildPlainTextFallback(output),
        mode: "plain_text_fallback",
    };
}
