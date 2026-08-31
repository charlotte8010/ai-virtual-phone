import { jsonrepair } from "jsonrepair";
import type { ExtractedMemoryCandidate } from "./memory-extraction";
import type { FutureIntentMeta, MemoryEntry } from "./memory-types";

export type FutureIntentEvent = {
    id: string;
    sourceApp: string;
    timestamp: string;
    content: string;
    sessionId?: string;
};

export type MemoryTimeContext = {
    now: Date;
    timezone?: string;
};

export type FutureIntentDetectionResult = {
    status: "disabled" | "skipped" | "no_candidate" | "saved" | "duplicate" | "updated";
    memory?: MemoryEntry;
    reason?: string;
};

const FUTURE_TIME_PATTERN = /今天(?:晚上|晚|下午|傍晚|夜里)?|明(?:天|早|晚)|后天|这周|本周|周[一二三四五六日天]|周末|下周|月底|下个月|生日|纪念日|以后|到时候/u;
const FUTURE_INTENT_ACTION_PATTERN = /记得|别忘了|约好|答应|说好了|一起|计划|准备|想|希望|想要|一定会|陪|承诺|安排|约|见面|吃饭|看电影/u;
const MEMORY_MOODS = new Set([
    "neutral", "happy", "tender", "excited", "sad", "angry", "anxious",
    "afraid", "jealous", "embarrassed", "lonely", "nostalgic",
]);
const FUTURE_INTENT_TYPES = new Set(["plan", "promise", "goal", "wish", "expectation"]);
const FUTURE_INTENT_STATUSES = new Set(["pending", "overdue", "fulfilled", "cancelled"]);
const TIME_PRECISIONS = new Set(["exact", "day", "range", "vague", "unknown"]);
const PRECISION_RANK: Record<string, number> = {
    unknown: 0,
    vague: 1,
    range: 2,
    day: 3,
    exact: 4,
};
const FUTURE_INTENT_TIME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimString(value: unknown, maxLength: number): string | undefined {
    if (typeof value !== "string") return undefined;
    const result = value.trim();
    return result ? result.slice(0, maxLength) : undefined;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function isValidTimeZone(value: string | undefined): value is string {
    if (!value) return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
        return true;
    } catch {
        return false;
    }
}

function isValidDateString(value: string | undefined): value is string {
    return Boolean(value && Number.isFinite(Date.parse(value)));
}

function sanitizeTags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const tags: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        const tag = trimString(item, 32);
        if (!tag || seen.has(tag)) continue;
        seen.add(tag);
        tags.push(tag);
        if (tags.length >= 6) break;
    }
    return tags;
}

function sanitizeSourceEventRefs(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const refs: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        const ref = trimString(item, 160);
        if (!ref || seen.has(ref)) continue;
        seen.add(ref);
        refs.push(ref);
        if (refs.length >= 32) break;
    }
    return refs.length > 0 ? refs : undefined;
}

function sanitizeFutureIntent(value: unknown): FutureIntentMeta {
    const raw = isRecord(value) ? value : {};
    const type = typeof raw.type === "string" && FUTURE_INTENT_TYPES.has(raw.type)
        ? raw.type as FutureIntentMeta["type"]
        : "expectation";
    const status = typeof raw.status === "string" && FUTURE_INTENT_STATUSES.has(raw.status)
        ? raw.status as FutureIntentMeta["status"]
        : "pending";
    const timePrecision = typeof raw.timePrecision === "string" && TIME_PRECISIONS.has(raw.timePrecision)
        ? raw.timePrecision as NonNullable<FutureIntentMeta["timePrecision"]>
        : "unknown";
    return {
        type,
        status,
        timePrecision,
        targetAt: trimString(raw.targetAt, 100),
        targetEndAt: trimString(raw.targetEndAt, 100),
        timezone: trimString(raw.timezone, 80),
        originalTimeExpression: trimString(raw.originalTimeExpression, 200),
        fulfilledAt: trimString(raw.fulfilledAt, 100),
        cancelledAt: trimString(raw.cancelledAt, 100),
        replacedByMemoryId: trimString(raw.replacedByMemoryId, 100),
    };
}

/** Cheap local gate: it decides whether asking the model is worthwhile. */
export function hasFutureIntentSignal(text: string): boolean {
    const normalized = String(text ?? "").replace(/\s+/g, "");
    return normalized.length > 0
        && FUTURE_TIME_PATTERN.test(normalized)
        && FUTURE_INTENT_ACTION_PATTERN.test(normalized);
}

export function buildFutureIntentPrompt(
    event: FutureIntentEvent,
    timeContext: MemoryTimeContext,
): string {
    const timezone = timeContext.timezone?.trim() || "未提供（请使用事件上下文，不要猜测时区）";
    return [
        "你是 Future Intent 检测器，只分析下面这一条事件。",
        `当前参考时间：${timeContext.now.toISOString()}`,
        `当前参考时区：${timezone}`,
        "如果事件没有明确、值得保留的未来计划、承诺、目标、愿望或预期，输出 {\"memories\":[]}。",
        "如果有，只输出一条 kind=future_intent 的记忆；不得把已经发生的事情改写成未来意图。",
        "futureIntent.type 只能是 plan、promise、goal、wish、expectation；status 初始使用 pending。",
        "exact/day/range 必须尽量给出带时区的绝对 targetAt；vague/unknown 不要编造 targetAt。",
        "originalTimeExpression 保留事件中的原始时间表达。",
        "只输出 JSON，不要 Markdown 或解释文字。",
        "事件：",
        `<native_event>[event_ref=${event.id}] [source_app=${event.sourceApp}] [event_time=${event.timestamp}] ${event.content}</native_event>`,
        "输出格式：{\"memories\":[{\"content\":\"...\",\"tags\":[\"...\"],\"importance\":0.8,\"kind\":\"future_intent\",\"sourceEventRefs\":[\"事件中的 event_ref\"],\"futureIntent\":{\"type\":\"plan\",\"status\":\"pending\",\"timePrecision\":\"exact\",\"targetAt\":\"...\"}}]}",
    ].join("\n");
}

/** Normalize model output without mutating the parsed candidate. */
export function normalizeFutureIntentCandidate(
    candidate: ExtractedMemoryCandidate,
    timeContext: MemoryTimeContext,
): ExtractedMemoryCandidate | null {
    if (!isRecord(candidate) || candidate.kind !== "future_intent") return null;
    const content = trimString(candidate.content, 2000);
    if (!content) return null;

    const rawImportance = typeof candidate.importance === "number"
        ? candidate.importance
        : Number(candidate.importance);
    const importance = clamp(Number.isFinite(rawImportance) ? rawImportance : 0.5, 0, 1);
    const rawFutureIntent = sanitizeFutureIntent(candidate.futureIntent);
    const precision = rawFutureIntent.timePrecision || "unknown";
    const targetAt = precision === "vague" || precision === "unknown"
        ? undefined
        : (isValidDateString(rawFutureIntent.targetAt) ? rawFutureIntent.targetAt : undefined);
    const targetEndAt = precision === "vague" || precision === "unknown"
        ? undefined
        : (isValidDateString(rawFutureIntent.targetEndAt) ? rawFutureIntent.targetEndAt : undefined);
    const validRange = !targetAt || !targetEndAt || Date.parse(targetEndAt) >= Date.parse(targetAt);
    const timezone = isValidTimeZone(rawFutureIntent.timezone)
        ? rawFutureIntent.timezone
        : (isValidTimeZone(timeContext.timezone) ? timeContext.timezone : undefined);
    const futureIntent: FutureIntentMeta = {
        type: rawFutureIntent.type,
        status: rawFutureIntent.status,
        timePrecision: precision,
        ...(validRange && targetAt ? { targetAt } : {}),
        ...(validRange && targetEndAt ? { targetEndAt } : {}),
        ...(timezone ? { timezone } : {}),
        ...(rawFutureIntent.originalTimeExpression
            ? { originalTimeExpression: rawFutureIntent.originalTimeExpression }
            : {}),
        ...(rawFutureIntent.fulfilledAt ? { fulfilledAt: rawFutureIntent.fulfilledAt } : {}),
        ...(rawFutureIntent.cancelledAt ? { cancelledAt: rawFutureIntent.cancelledAt } : {}),
        ...(rawFutureIntent.replacedByMemoryId
            ? { replacedByMemoryId: rawFutureIntent.replacedByMemoryId }
            : {}),
    };

    return {
        content,
        tags: sanitizeTags(candidate.tags),
        importance,
        ...(typeof candidate.mood === "string" && MEMORY_MOODS.has(candidate.mood)
            ? { mood: candidate.mood as ExtractedMemoryCandidate["mood"] }
            : {}),
        kind: "future_intent",
        futureIntent,
        ...(sanitizeSourceEventRefs(candidate.sourceEventRefs)
            ? { sourceEventRefs: sanitizeSourceEventRefs(candidate.sourceEventRefs) }
            : {}),
    };
}

function parseJsonCandidate(value: string): unknown | undefined {
    try {
        return JSON.parse(value) as unknown;
    } catch {
        try {
            return JSON.parse(jsonrepair(value)) as unknown;
        } catch {
            return undefined;
        }
    }
}

function parseStructuredPayload(text: string): unknown | undefined {
    const trimmed = text.trim();
    const candidates = [trimmed];
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) candidates.push(fenced);
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
    for (const candidate of candidates) {
        const parsed = parseJsonCandidate(candidate);
        if (Array.isArray(parsed) || (isRecord(parsed) && Array.isArray(parsed.memories))) return parsed;
    }
    return undefined;
}

/** Parse only structured detector output; plain text is intentionally rejected. */
export function parseFutureIntentModelOutput(
    text: string,
    event: FutureIntentEvent,
    timeContext: MemoryTimeContext,
): ExtractedMemoryCandidate[] {
    const payload = parseStructuredPayload(text);
    const rawMemories = Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload.memories)
            ? payload.memories
            : [];
    for (const raw of rawMemories) {
        if (!isRecord(raw)) continue;
        const normalized = normalizeFutureIntentCandidate({
            ...raw,
            sourceEventRefs: [event.id],
        } as unknown as ExtractedMemoryCandidate, timeContext);
        if (normalized) return [normalized];
    }
    return [];
}

function normalizeMemoryContent(content: string): string {
    return content.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function buildNgrams(value: string): Set<string> {
    if (value.length <= 3) return new Set([value]);
    const result = new Set<string>();
    for (let index = 0; index <= value.length - 3; index += 1) {
        result.add(value.slice(index, index + 3));
    }
    return result;
}

function contentIsSimilar(left: string, right: string): boolean {
    const normalizedLeft = normalizeMemoryContent(left);
    const normalizedRight = normalizeMemoryContent(right);
    if (!normalizedLeft || !normalizedRight) return false;
    if (normalizedLeft === normalizedRight
        || normalizedLeft.includes(normalizedRight)
        || normalizedRight.includes(normalizedLeft)) return true;
    const leftNgrams = buildNgrams(normalizedLeft);
    const rightNgrams = buildNgrams(normalizedRight);
    const intersection = [...leftNgrams].filter(item => rightNgrams.has(item)).length;
    return intersection / Math.max(1, Math.min(leftNgrams.size, rightNgrams.size)) >= 0.6;
}

function sourceSignatureSet(entry: MemoryEntry): Set<string> {
    const raw = entry.metadata?.sourceEventSignatures;
    return new Set(Array.isArray(raw)
        ? raw.filter((value): value is string => typeof value === "string" && value.length > 0)
        : []);
}

function futureIntentTypesMatch(left: FutureIntentMeta, right: FutureIntentMeta): boolean {
    if (left.type === right.type) return true;
    return (left.type === "plan" || left.type === "promise")
        && (right.type === "plan" || right.type === "promise");
}

function futureIntentTimesMatch(left: FutureIntentMeta, right: FutureIntentMeta): boolean {
    const leftStart = left.targetAt ? Date.parse(left.targetAt) : NaN;
    const rightStart = right.targetAt ? Date.parse(right.targetAt) : NaN;
    if (Number.isFinite(leftStart) && Number.isFinite(rightStart)) {
        const leftEnd = left.targetEndAt ? Date.parse(left.targetEndAt) : leftStart;
        const rightEnd = right.targetEndAt ? Date.parse(right.targetEndAt) : rightStart;
        return leftStart <= rightEnd + FUTURE_INTENT_TIME_WINDOW_MS
            && rightStart <= leftEnd + FUTURE_INTENT_TIME_WINDOW_MS;
    }
    if (left.originalTimeExpression && right.originalTimeExpression) {
        return left.originalTimeExpression === right.originalTimeExpression;
    }
    return left.timePrecision === right.timePrecision
        || left.timePrecision === "vague"
        || right.timePrecision === "vague"
        || left.timePrecision === "unknown"
        || right.timePrecision === "unknown";
}

export function isFutureIntentDuplicate(candidate: MemoryEntry, existing: MemoryEntry): boolean {
    if (candidate.kind !== "future_intent" || existing.kind !== "future_intent") return false;
    const candidateIntent = candidate.futureIntent;
    const existingIntent = existing.futureIntent;
    if (!candidateIntent || !existingIntent || !futureIntentTypesMatch(candidateIntent, existingIntent)) return false;

    const candidateSignatures = sourceSignatureSet(candidate);
    const existingSignatures = sourceSignatureSet(existing);
    if ([...candidateSignatures].some(signature => existingSignatures.has(signature))) return true;

    return contentIsSimilar(candidate.content, existing.content)
        && futureIntentTimesMatch(candidateIntent, existingIntent);
}

function readStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string" && item.length > 0)
        : [];
}

function uniqueStrings(...values: Array<string[] | undefined>): string[] {
    return [...new Set(values.flatMap(value => value ?? []))];
}

export function buildFutureIntentMemoryEntry(
    characterId: string,
    event: FutureIntentEvent,
    candidate: ExtractedMemoryCandidate,
    now = new Date(),
): MemoryEntry {
    const sourceSignature = `${characterId}:${event.sourceApp}:${event.id}`;
    return {
        id: `mem_lt_future_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        sourceApp: event.sourceApp as MemoryEntry["sourceApp"],
        type: "long_term",
        content: candidate.content,
        importance: clamp(candidate.importance, 0, 1),
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        tags: [...candidate.tags],
        ...(candidate.mood ? { mood: candidate.mood } : {}),
        kind: "future_intent",
        futureIntent: candidate.futureIntent ? { ...candidate.futureIntent } : {
            type: "expectation",
            status: "pending",
            timePrecision: "unknown",
        },
        sourceMessageIds: [event.id],
        metadata: {
            summarizedEvents: 1,
            timeSpan: event.timestamp,
            ...(event.sessionId ? { sourceSessionIds: [event.sessionId] } : {}),
            sourceEventSignatures: [sourceSignature],
            sourceEventTimestamps: [event.timestamp],
            extractionVersion: "future-intent-v1",
            extractionMode: "immediate_future_intent",
        },
    };
}

export function mergeFutureIntentMemory(existing: MemoryEntry, candidate: MemoryEntry): MemoryEntry {
    const existingIntent = existing.futureIntent;
    const candidateIntent = candidate.futureIntent;
    if (!existingIntent || !candidateIntent) return { ...existing };
    const candidateIsMorePrecise = (PRECISION_RANK[candidateIntent.timePrecision || "unknown"] ?? 0)
        > (PRECISION_RANK[existingIntent.timePrecision || "unknown"] ?? 0);
    const useCandidateDetails = candidateIsMorePrecise || candidate.content.length > existing.content.length;
    const mergedIntent = {
        ...(useCandidateDetails ? existingIntent : candidateIntent),
        ...(useCandidateDetails ? candidateIntent : existingIntent),
        status: existingIntent.status === "pending" ? candidateIntent.status : existingIntent.status,
    };
    const existingMetadata = existing.metadata ?? {};
    const candidateMetadata = candidate.metadata ?? {};
    const sourceEventSignatures = uniqueStrings(
        readStringArray(existingMetadata.sourceEventSignatures),
        readStringArray(candidateMetadata.sourceEventSignatures),
    );
    const sourceEventTimestamps = uniqueStrings(
        readStringArray(existingMetadata.sourceEventTimestamps),
        readStringArray(candidateMetadata.sourceEventTimestamps),
    );
    return {
        ...existing,
        sourceApp: candidate.sourceApp,
        content: useCandidateDetails ? candidate.content : existing.content,
        importance: Math.max(existing.importance, candidate.importance),
        updatedAt: candidate.updatedAt,
        tags: uniqueStrings(existing.tags, candidate.tags).slice(0, 6),
        futureIntent: mergedIntent,
        sourceMessageIds: uniqueStrings(existing.sourceMessageIds, candidate.sourceMessageIds),
        metadata: {
            ...existingMetadata,
            ...candidateMetadata,
            ...(sourceEventSignatures.length > 0 ? { sourceEventSignatures } : {}),
            ...(sourceEventTimestamps.length > 0 ? { sourceEventTimestamps } : {}),
            extractionMode: "immediate_future_intent",
        },
    };
}

const detectorInFlight = new Map<string, Promise<FutureIntentDetectionResult>>();
const lastScannedEventIds = new Map<string, string>();

/** Run the immediate path once for the newest native event of a character. */
export function maybeRunFutureIntentDetection(
    characterId: string,
): Promise<FutureIntentDetectionResult> {
    const inFlight = detectorInFlight.get(characterId);
    if (inFlight) return inFlight;
    const task = runFutureIntentDetection(characterId).finally(() => {
        detectorInFlight.delete(characterId);
    });
    detectorInFlight.set(characterId, task);
    return task;
}

async function runFutureIntentDetection(characterId: string): Promise<FutureIntentDetectionResult> {
    if (typeof window === "undefined") return { status: "skipped", reason: "browser_only" };

    const [memoryStorage, timelineAssembler, settingsStorage, characterStorage, apiHelpers, memoryEmbedding, memoryExtraction] = await Promise.all([
        import("./memory-storage"),
        import("./short-term-assembler"),
        import("./settings-storage"),
        import("./character-storage"),
        import("./api-helpers"),
        import("./memory-embedding"),
        import("./memory-extraction"),
    ]);
    const config = memoryStorage.loadMemoryConfig();
    if (config.futureIntentEnabled === false) return { status: "disabled" };

    const entries = timelineAssembler.filterTimelineByAllowedSources(
        timelineAssembler.loadNativeTimeline(characterId),
        config.shortTermAllowedSources,
    );
    const event = entries[entries.length - 1];
    if (!event || lastScannedEventIds.get(characterId) === event.id) {
        return { status: "skipped", reason: "event_already_scanned" };
    }
    if (!hasFutureIntentSignal(event.content)) {
        lastScannedEventIds.set(characterId, event.id);
        return { status: "skipped", reason: "heuristic_miss" };
    }

    const apiConfig = settingsStorage.resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) return { status: "skipped", reason: "missing_memory_summary_api" };

    const character = characterStorage.loadCharacters().find(item => item.id === characterId);
    const timeContext: MemoryTimeContext = {
        now: new Date(),
        timezone: character?.timeZone,
    };
    const result = await apiHelpers.simpleLLMCall(
        apiConfig,
        [{ role: "user", content: buildFutureIntentPrompt(event, timeContext) }],
        { temperature: 0.2 },
    );
    if (!result.content || result.wasTruncated) {
        return { status: "skipped", reason: result.wasTruncated ? "truncated_model_output" : "empty_model_output" };
    }

    const extraction = memoryExtraction.extractMemoriesFromModelOutput(result.content);
    const candidates = extraction.mode === "structured"
        ? extraction.memories
            .map(candidate => normalizeFutureIntentCandidate({ ...candidate, sourceEventRefs: [event.id] }, timeContext))
            .filter((candidate): candidate is ExtractedMemoryCandidate => Boolean(candidate))
        : [];
    lastScannedEventIds.set(characterId, event.id);
    const candidate = candidates[0];
    if (!candidate) return { status: "no_candidate" };

    const entry = buildFutureIntentMemoryEntry(characterId, event, candidate, new Date());
    const existingEntries = await memoryStorage.loadMemoryEntriesByType(characterId, "long_term");
    const duplicate = existingEntries.find(existing => isFutureIntentDuplicate(entry, existing));
    if (duplicate) {
        const merged = mergeFutureIntentMemory(duplicate, entry);
        const changed = merged.content !== duplicate.content
            || JSON.stringify(merged.futureIntent) !== JSON.stringify(duplicate.futureIntent)
            || JSON.stringify(merged.sourceMessageIds) !== JSON.stringify(duplicate.sourceMessageIds)
            || JSON.stringify(merged.tags) !== JSON.stringify(duplicate.tags);
        if (!changed) return { status: "duplicate", memory: duplicate };
        await memoryStorage.saveMemoryEntry(merged);
        return { status: "updated", memory: merged };
    }

    // Text is persisted before embedding so an embedding outage cannot lose the intent.
    await memoryStorage.saveMemoryEntry(entry);
    let savedEntry = entry;
    const embeddingApiConfig = config.vectorRecallEnabled
        ? settingsStorage.resolveAuxiliaryApiConfig("embeddingApiConfigId")
        : null;
    if (embeddingApiConfig && memoryEmbedding.resolveEmbeddingModel(embeddingApiConfig)) {
        try {
            const embedding = await memoryEmbedding.generateEmbedding(entry.content, embeddingApiConfig);
            if (embedding) {
                savedEntry = { ...entry, embedding, updatedAt: new Date().toISOString() };
                await memoryStorage.saveMemoryEntry(savedEntry);
            }
        } catch (error) {
            console.warn("[FutureIntent] Embedding failed; text memory was retained", error);
        }
    }
    return { status: "saved", memory: savedEntry };
}
