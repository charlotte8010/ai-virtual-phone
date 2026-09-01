import { normalizeFutureIntentCandidate, type FutureIntentEvent, type MemoryTimeContext } from "./future-intent-detector";
import type { ExtractedMemoryCandidate } from "./memory-extraction";
import type { FutureIntentMeta, MemoryEntry } from "./memory-types";

export type FutureIntentLifecycleAction = "none" | "overdue" | "fulfilled" | "cancelled" | "replaced";

export type FutureIntentLifecycleSemanticDecision =
    | { action: "none" }
    | { action: "fulfilled" }
    | { action: "cancelled" }
    | { action: "replaced"; replacement: ExtractedMemoryCandidate };

export type FutureIntentLifecycleDecision = {
    action: FutureIntentLifecycleAction;
    reason: string;
    nextEntry?: MemoryEntry;
    replacementEntry?: MemoryEntry;
};

export type FutureIntentLifecycleCandidate = {
    ref: `F${number}`;
    content: string;
    sourceApp: MemoryEntry["sourceApp"];
    type: FutureIntentMeta["type"];
    status: "pending" | "overdue";
    timePrecision?: FutureIntentMeta["timePrecision"];
    targetAt?: string;
    targetEndAt?: string;
    timezone?: string;
    originalTimeExpression?: string;
};

export type FutureIntentLifecycleModelDecision =
    | { action: "none" }
    | { action: "fulfilled" | "cancelled"; targetIndex: number }
    | { action: "replaced"; targetIndex: number; replacement: ExtractedMemoryCandidate };

export type FutureIntentLifecycleClassifier = (
    event: FutureIntentEvent,
    candidates: readonly FutureIntentLifecycleCandidate[],
    timeContext: MemoryTimeContext,
) => Promise<FutureIntentLifecycleModelDecision | null>;

export type FutureIntentLifecycleOptions = {
    now?: Date;
    timezone?: string;
    classifier?: FutureIntentLifecycleClassifier;
    semanticDecision?: FutureIntentLifecycleSemanticDecision;
};

export type FutureIntentLifecycleStore = {
    loadMemoryEntriesByType: (
        characterId: string,
        type: MemoryEntry["type"],
    ) => Promise<MemoryEntry[]>;
    saveMemoryEntries: (entries: MemoryEntry[]) => Promise<void>;
    loadMemoryConfig?: () => { futureIntentEnabled?: boolean };
};

export type FutureIntentLifecycleRunResult = {
    status: "disabled" | "no_change" | "overdue" | "fulfilled" | "cancelled" | "replaced" | "updated" | "write_failed";
    changedCount?: number;
    reason?: string;
};

const TERMINAL_STATUSES = new Set<FutureIntentMeta["status"]>(["fulfilled", "cancelled"]);
const MAX_CLASSIFIER_CANDIDATES = 32;

function isValidTimeZone(value: string | undefined): value is string {
    if (!value) return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
        return true;
    } catch {
        return false;
    }
}

function parseDate(value: string | undefined): Date | undefined {
    if (!value) return undefined;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

function readStringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
}

function getCalendarDayKey(value: Date, timezone: string): string | undefined {
    if (!isValidTimeZone(timezone)) return undefined;
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
        }).formatToParts(value);
        const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
        return `${values.year}-${values.month}-${values.day}`;
    } catch {
        return undefined;
    }
}

function temporalPrecision(intent: FutureIntentMeta): string {
    return intent.timePrecision || (intent.targetEndAt ? "range" : "exact");
}

function lifecycleEventIds(entry: MemoryEntry): string[] {
    return readStringArray(entry.metadata?.futureIntentLifecycleEventIds);
}

function hasSeenEvent(entry: MemoryEntry, event: FutureIntentEvent): boolean {
    return entry.sourceMessageIds?.includes(event.id) === true
        || lifecycleEventIds(entry).includes(event.id);
}

function buildLifecycleMetadata(
    entry: MemoryEntry,
    event: FutureIntentEvent,
    action: Exclude<FutureIntentLifecycleAction, "none" | "overdue">,
): Record<string, unknown> {
    const previousIds = lifecycleEventIds(entry);
    return {
        ...(entry.metadata ?? {}),
        futureIntentLifecycleEventIds: [...new Set([...previousIds, event.id])],
        futureIntentLifecycle: {
            action,
            eventId: event.id,
            sourceApp: event.sourceApp,
            ...(event.sourceDetail ? { sourceDetail: event.sourceDetail } : {}),
            timestamp: event.timestamp,
            ...(event.sessionId ? { sessionId: event.sessionId } : {}),
        },
    };
}

function buildTimeTransitionMetadata(entry: MemoryEntry, at: Date): Record<string, unknown> {
    return {
        ...(entry.metadata ?? {}),
        futureIntentLifecycle: {
            action: "overdue",
            reason: "target_window_elapsed",
            timestamp: at.toISOString(),
        },
    };
}

function buildTerminalEntry(
    entry: MemoryEntry,
    event: FutureIntentEvent,
    action: "fulfilled" | "cancelled",
    at: Date,
): MemoryEntry {
    const currentIntent = entry.futureIntent;
    if (!currentIntent) return entry;
    const nextIntent: FutureIntentMeta = {
        ...currentIntent,
        status: action,
        ...(action === "fulfilled"
            ? { fulfilledAt: at.toISOString(), cancelledAt: undefined }
            : { cancelledAt: at.toISOString(), fulfilledAt: undefined }),
    };
    return {
        ...entry,
        updatedAt: at.toISOString(),
        futureIntent: nextIntent,
        metadata: buildLifecycleMetadata(entry, event, action),
    };
}

function buildReplacementId(): string {
    return `mem_lt_future_replace_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createReplacementEntry(
    entry: MemoryEntry,
    event: FutureIntentEvent,
    replacement: ExtractedMemoryCandidate,
    replacementId: string,
    at: Date,
): MemoryEntry | undefined {
    const replacementIntent = replacement.futureIntent;
    if (!replacementIntent || replacement.kind !== "future_intent") return undefined;
    const sourceSignature = `${entry.characterId}:${event.sourceApp}:${event.id}`;
    const tags = replacement.tags.length > 0 ? [...replacement.tags] : entry.tags ? [...entry.tags] : undefined;
    const futureIntent: FutureIntentMeta = {
        ...replacementIntent,
        status: "pending",
        fulfilledAt: undefined,
        cancelledAt: undefined,
        replacedByMemoryId: undefined,
    };
    return {
        id: replacementId,
        characterId: entry.characterId,
        sourceApp: event.sourceApp,
        type: "long_term",
        content: replacement.content,
        importance: replacement.importance,
        createdAt: at.toISOString(),
        updatedAt: at.toISOString(),
        ...(tags ? { tags } : {}),
        ...(replacement.mood ? { mood: replacement.mood } : {}),
        kind: "future_intent",
        futureIntent,
        sourceMessageIds: [event.id],
        metadata: {
            sourceEventSignatures: [sourceSignature],
            sourceEventTimestamps: [event.timestamp],
            ...(event.sessionId ? { sourceSessionIds: [event.sessionId] } : {}),
            extractionVersion: "future-intent-lifecycle-v2",
            extractionMode: "future_intent_lifecycle_replacement",
            futureIntentLifecycleEventIds: [event.id],
            futureIntentLifecycle: {
                action: "replacement_created",
                eventId: event.id,
                sourceApp: event.sourceApp,
                ...(event.sourceDetail ? { sourceDetail: event.sourceDetail } : {}),
                timestamp: event.timestamp,
                replacedMemoryId: entry.id,
            },
        },
    };
}

export function decideFutureIntentTimeTransition(
    entry: MemoryEntry,
    now: Date,
    timezone?: string,
): FutureIntentLifecycleDecision {
    const intent = entry.futureIntent;
    if (entry.kind !== "future_intent" || !intent || intent.status !== "pending" || intent.replacedByMemoryId) {
        return { action: "none", reason: "not_pending" };
    }
    if (!Number.isFinite(now.getTime())) return { action: "none", reason: "invalid_now" };

    const precision = temporalPrecision(intent);
    const targetAt = parseDate(intent.targetAt);
    if (["vague", "unknown"].includes(precision)) return { action: "none", reason: "non_actionable_precision" };
    if (!["exact", "day", "range"].includes(precision)) return { action: "none", reason: "invalid_precision" };
    if (precision === "range") {
        const targetEndAt = parseDate(intent.targetEndAt);
        if (!targetAt || !targetEndAt || targetEndAt.getTime() < targetAt.getTime()) {
            return { action: "none", reason: "invalid_range" };
        }
        if (now.getTime() <= targetEndAt.getTime()) return { action: "none", reason: "target_window_open" };
    } else if (precision === "day") {
        if (!targetAt) return { action: "none", reason: "invalid_day_target" };
        const effectiveTimezone = timezone || intent.timezone;
        if (!effectiveTimezone) return { action: "none", reason: "missing_day_timezone" };
        const targetDay = getCalendarDayKey(targetAt, effectiveTimezone);
        const currentDay = getCalendarDayKey(now, effectiveTimezone);
        if (!targetDay || !currentDay || currentDay <= targetDay) return { action: "none", reason: "target_day_open" };
    } else {
        if (!targetAt) return { action: "none", reason: "invalid_exact_target" };
        if (now.getTime() <= targetAt.getTime()) return { action: "none", reason: "target_time_open" };
    }

    const nextEntry: MemoryEntry = {
        ...entry,
        updatedAt: now.toISOString(),
        futureIntent: { ...intent, status: "overdue" },
        metadata: buildTimeTransitionMetadata(entry, now),
    };
    return { action: "overdue", reason: "target_window_elapsed", nextEntry };
}

export function decideFutureIntentTransition(
    entry: MemoryEntry,
    event: FutureIntentEvent,
    options: FutureIntentLifecycleOptions = {},
): FutureIntentLifecycleDecision {
    const intent = entry.futureIntent;
    if (entry.kind !== "future_intent" || !intent || TERMINAL_STATUSES.has(intent.status) || intent.replacedByMemoryId) {
        return { action: "none", reason: "terminal_or_inactive" };
    }
    if (hasSeenEvent(entry, event)) return { action: "none", reason: "event_already_applied" };
    const eventTime = parseDate(event.timestamp);
    if (!eventTime) return { action: "none", reason: "invalid_event_time" };

    const semanticDecision = options.semanticDecision;
    if (semanticDecision && semanticDecision.action !== "none") {
        if (semanticDecision.action === "fulfilled" || semanticDecision.action === "cancelled") {
            return {
                action: semanticDecision.action,
                reason: semanticDecision.action === "fulfilled"
                    ? "classifier_completion_evidence"
                    : "classifier_cancellation_evidence",
                nextEntry: buildTerminalEntry(entry, event, semanticDecision.action, eventTime),
            };
        }
        const replacementEntry = createReplacementEntry(
            entry,
            event,
            semanticDecision.replacement,
            buildReplacementId(),
            eventTime,
        );
        if (replacementEntry) {
            const nextEntry = buildTerminalEntry(entry, event, "cancelled", eventTime);
            nextEntry.futureIntent = { ...nextEntry.futureIntent!, replacedByMemoryId: replacementEntry.id };
            return { action: "replaced", reason: "classifier_reschedule_evidence", nextEntry, replacementEntry };
        }
    }

    return decideFutureIntentTimeTransition(entry, options.now ?? eventTime, options.timezone);
}

function normalizedText(value: string): string {
    return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function buildTextNgrams(value: string): Set<string> {
    if (value.length <= 3) return value ? new Set([value]) : new Set();
    const result = new Set<string>();
    for (let index = 0; index <= value.length - 3; index += 1) result.add(value.slice(index, index + 3));
    return result;
}

function candidateHeuristicScore(entry: MemoryEntry, event: FutureIntentEvent): number {
    let score = 0;
    if (entry.sourceApp === event.sourceApp) score += 2;
    const sessionIds = readStringArray(entry.metadata?.sourceSessionIds);
    if (event.sessionId && sessionIds.includes(event.sessionId)) score += 8;
    const left = buildTextNgrams(normalizedText(entry.content));
    const right = buildTextNgrams(normalizedText(event.content));
    if (left.size > 0 && right.size > 0) {
        const overlap = [...left].filter(gram => right.has(gram)).length;
        score += Math.min(6, overlap);
    }
    const target = parseDate(entry.futureIntent?.targetEndAt || entry.futureIntent?.targetAt);
    const eventTime = parseDate(event.timestamp);
    if (target && eventTime) {
        const days = Math.abs(target.getTime() - eventTime.getTime()) / 86_400_000;
        score += Math.max(0, 4 - Math.min(4, days / 7));
    }
    if (entry.futureIntent?.status === "overdue") score += 1;
    return score;
}

function candidateFromEntry(entry: MemoryEntry, ref: `F${number}`): FutureIntentLifecycleCandidate | undefined {
    const intent = entry.futureIntent;
    if (!intent || (intent.status !== "pending" && intent.status !== "overdue") || intent.replacedByMemoryId) return undefined;
    return {
        ref,
        content: entry.content,
        sourceApp: entry.sourceApp,
        type: intent.type,
        status: intent.status,
        ...(intent.timePrecision ? { timePrecision: intent.timePrecision } : {}),
        ...(intent.targetAt ? { targetAt: intent.targetAt } : {}),
        ...(intent.targetEndAt ? { targetEndAt: intent.targetEndAt } : {}),
        ...(intent.timezone ? { timezone: intent.timezone } : {}),
        ...(intent.originalTimeExpression ? { originalTimeExpression: intent.originalTimeExpression } : {}),
    };
}

type CandidateBinding = {
    entry: MemoryEntry;
    candidate: FutureIntentLifecycleCandidate;
};

function buildCandidateBindings(entries: MemoryEntry[], event: FutureIntentEvent): CandidateBinding[] {
    const eligible = entries
        .map(entry => ({ entry, candidate: candidateFromEntry(entry, "F0" as `F${number}`) }))
        .filter((item): item is { entry: MemoryEntry; candidate: FutureIntentLifecycleCandidate } => Boolean(item.candidate));
    const selected = eligible.length <= MAX_CLASSIFIER_CANDIDATES
        ? eligible
        : [...eligible]
            .sort((left, right) => candidateHeuristicScore(right.entry, event) - candidateHeuristicScore(left.entry, event))
            .slice(0, MAX_CLASSIFIER_CANDIDATES);
    return selected.map((item, index) => ({
        entry: item.entry,
        candidate: { ...item.candidate, ref: `F${index}` as `F${number}` },
    }));
}

export function buildFutureIntentLifecycleCandidates(
    entries: MemoryEntry[],
    event: FutureIntentEvent,
): FutureIntentLifecycleCandidate[] {
    return buildCandidateBindings(entries, event).map(item => item.candidate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    const allowedSet = new Set(allowed);
    return Object.keys(value).every(key => allowedSet.has(key));
}

function readNonEmptyString(value: unknown, maxLength: number): string | undefined {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function hasDuplicateObjectKeys(text: string): boolean {
    const stack: Set<string>[] = [];
    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (char === '"') {
            const start = index;
            let escaped = false;
            index += 1;
            for (; index < text.length; index += 1) {
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (text[index] === "\\") {
                    escaped = true;
                    continue;
                }
                if (text[index] === '"') break;
            }
            const afterString = text.slice(index + 1).match(/^\s*:/u);
            if (afterString && stack.length > 0) {
                let key: string;
                try {
                    key = JSON.parse(text.slice(start, index + 1)) as string;
                } catch {
                    return true;
                }
                const current = stack[stack.length - 1];
                if (current.has(key)) return true;
                current.add(key);
            }
            continue;
        }
        if (char === "{") stack.push(new Set());
        else if (char === "}") stack.pop();
    }
    return false;
}

function parseTargetIndex(value: unknown, candidates: readonly FutureIntentLifecycleCandidate[]): number | undefined {
    if (typeof value !== "string" || !/^F(?:0|[1-9]\d*)$/u.test(value)) return undefined;
    const index = Number(value.slice(1));
    return candidates[index]?.ref === value ? index : undefined;
}

function isValidDateString(value: unknown): value is string {
    return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function parseReplacementCandidate(
    value: unknown,
    timeContext: MemoryTimeContext,
): ExtractedMemoryCandidate | undefined {
    if (!isRecord(value) || !hasOnlyKeys(value, ["content", "type", "timePrecision", "targetAt", "targetEndAt", "timezone", "originalTimeExpression"])) {
        return undefined;
    }
    const content = readNonEmptyString(value.content, 2000);
    const originalTimeExpression = readNonEmptyString(value.originalTimeExpression, 200);
    const types = new Set(["plan", "promise", "goal", "wish", "expectation"]);
    const precisions = new Set(["exact", "day", "range", "vague", "unknown"]);
    if (!content || !originalTimeExpression || typeof value.type !== "string" || !types.has(value.type)
        || typeof value.timePrecision !== "string" || !precisions.has(value.timePrecision)) return undefined;

    const precision = value.timePrecision;
    const targetAt = value.targetAt;
    const targetEndAt = value.targetEndAt;
    if (["exact", "day", "range"].includes(precision)) {
        if (!isValidDateString(targetAt)) return undefined;
        if (precision === "range" && (!isValidDateString(targetEndAt) || Date.parse(targetEndAt) < Date.parse(targetAt))) return undefined;
        if (precision !== "range" && targetEndAt !== undefined) return undefined;
    } else if (targetAt !== undefined || targetEndAt !== undefined) {
        return undefined;
    }
    if (value.timezone !== undefined && (typeof value.timezone !== "string" || !isValidTimeZone(value.timezone))) return undefined;

    const normalized = normalizeFutureIntentCandidate({
        content,
        tags: [],
        importance: 0.5,
        kind: "future_intent",
        futureIntent: {
            type: value.type as FutureIntentMeta["type"],
            status: "pending",
            timePrecision: precision as NonNullable<FutureIntentMeta["timePrecision"]>,
            ...(targetAt !== undefined ? { targetAt: targetAt as string } : {}),
            ...(targetEndAt !== undefined ? { targetEndAt: targetEndAt as string } : {}),
            ...(value.timezone !== undefined ? { timezone: value.timezone as string } : {}),
            originalTimeExpression,
        },
    }, timeContext);
    if (!normalized?.futureIntent || normalized.futureIntent.timePrecision !== precision) return undefined;
    if (["exact", "day", "range"].includes(precision) && normalized.futureIntent.targetAt !== targetAt) return undefined;
    if (precision === "range" && normalized.futureIntent.targetEndAt !== targetEndAt) return undefined;
    return normalized;
}

/** Build the only prompt used for lifecycle semantic classification. */
export function buildFutureIntentLifecyclePrompt(
    event: FutureIntentEvent,
    timeContext: MemoryTimeContext,
    candidates: readonly FutureIntentLifecycleCandidate[],
): string {
    const timezone = timeContext.timezone?.trim() || "未提供";
    const candidateText = candidates.length === 0
        ? "（没有未解决候选）"
        : candidates.map(candidate => [
            `[${candidate.ref}]`,
            `content=${candidate.content}`,
            `source_app=${candidate.sourceApp}`,
            `type=${candidate.type}`,
            `status=${candidate.status}`,
            `time_precision=${candidate.timePrecision || "unknown"}`,
            candidate.targetAt ? `target_at=${candidate.targetAt}` : "",
            candidate.targetEndAt ? `target_end_at=${candidate.targetEndAt}` : "",
            candidate.timezone ? `timezone=${candidate.timezone}` : "",
            candidate.originalTimeExpression ? `original_time=${candidate.originalTimeExpression}` : "",
        ].filter(Boolean).join(" ")).join("\n");
    return [
        "你是 Future Intent lifecycle classifier。",
        `当前参考时间：${timeContext.now.toISOString()}`,
        `角色时区：${timezone}`,
        "只判断当前 exact event，不要猜测整个历史。",
        "必须有明确语义证据；主题相似不等于同一计划，关键词重叠不等于同一计划。",
        "综合人物、对象、行为、时间、地点等信息；多个相似候选时只能选择事件明确指向的那个。",
        "无法唯一确认时输出 none。疑问句、假设、猜测、建议、条件句都不能推进 lifecycle。",
        "targetAt 已经过期不代表 fulfilled；overdue 由代码按时间规则处理。",
        "只能输出 action=none、fulfilled、cancelled、replaced；不能输出 overdue。",
        "候选引用只允许使用 F0/F1/...，不允许返回真实 memory ID 或候选列表之外的 ID。",
        "宁可 none，不要猜。只输出 JSON，不要 explanation。",
        "未解决 Future Intent 候选：",
        candidateText,
        "当前 exact native event：",
        `<native_event>[event_ref=${event.id}] [source_app=${event.sourceApp}] [source_detail=${event.sourceDetail || ""}] [event_time=${event.timestamp}] ${event.content}</native_event>`,
        "输出格式：{\"action\":\"none\"}，或 {\"action\":\"fulfilled\",\"target\":\"F1\"}，或 {\"action\":\"cancelled\",\"target\":\"F1\"}，或 {\"action\":\"replaced\",\"target\":\"F1\",\"replacement\":{\"content\":\"...\",\"type\":\"plan\",\"timePrecision\":\"exact\",\"targetAt\":\"...\",\"originalTimeExpression\":\"...\"}}。",
    ].join("\n");
}

/** Parse the strict classifier contract; malformed or ambiguous output is a no-op. */
export function parseFutureIntentLifecycleModelOutput(
    text: string,
    candidates: readonly FutureIntentLifecycleCandidate[],
    timeContext: MemoryTimeContext,
): FutureIntentLifecycleModelDecision | null {
    const source = text.trim();
    if (!source || hasDuplicateObjectKeys(source)) return null;
    let value: unknown;
    try {
        value = JSON.parse(source) as unknown;
    } catch {
        return null;
    }
    if (!isRecord(value) || typeof value.action !== "string") return null;
    if (value.action === "none") return hasOnlyKeys(value, ["action"]) ? { action: "none" } : null;
    if (value.action !== "fulfilled" && value.action !== "cancelled" && value.action !== "replaced") return null;
    if (!hasOnlyKeys(value, value.action === "replaced" ? ["action", "target", "replacement"] : ["action", "target"])) return null;
    const targetIndex = parseTargetIndex(value.target, candidates);
    if (targetIndex === undefined) return null;
    if (value.action !== "replaced") return { action: value.action, targetIndex };
    const replacement = parseReplacementCandidate(value.replacement, timeContext);
    return replacement ? { action: "replaced", targetIndex, replacement } : null;
}

async function classifyWithMemorySummaryApi(
    event: FutureIntentEvent,
    candidates: readonly FutureIntentLifecycleCandidate[],
    timeContext: MemoryTimeContext,
): Promise<FutureIntentLifecycleModelDecision | null> {
    if (typeof window === "undefined") return null;
    const [{ resolveAuxiliaryApiConfig }, { simpleLLMCall }] = await Promise.all([
        import("./settings-storage"),
        import("./api-helpers"),
    ]);
    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) return null;
    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: buildFutureIntentLifecyclePrompt(event, timeContext, candidates) }],
        { temperature: 0, max_tokens: 700 },
    );
    if (!result.content || result.wasTruncated) return null;
    return parseFutureIntentLifecycleModelOutput(result.content, candidates, timeContext);
}

async function resolveLifecycleStore(store?: FutureIntentLifecycleStore): Promise<FutureIntentLifecycleStore> {
    if (store) return store;
    const memoryStorage = await import("./memory-storage");
    return {
        loadMemoryEntriesByType: memoryStorage.loadMemoryEntriesByType,
        saveMemoryEntries: memoryStorage.saveMemoryEntries,
        loadMemoryConfig: memoryStorage.loadMemoryConfig,
    };
}

async function resolveCharacterTimezone(characterId: string, explicitTimezone?: string): Promise<string | undefined> {
    if (explicitTimezone) return explicitTimezone;
    try {
        const { loadCharacters } = await import("./character-storage");
        return loadCharacters().find(character => character.id === characterId)?.timeZone;
    } catch {
        return undefined;
    }
}

function resultForDecisions(decisions: FutureIntentLifecycleDecision[]): FutureIntentLifecycleRunResult["status"] {
    if (decisions.some(decision => decision.action === "replaced")) return "replaced";
    if (decisions.some(decision => decision.action === "fulfilled")) return "fulfilled";
    if (decisions.some(decision => decision.action === "cancelled")) return "cancelled";
    if (decisions.some(decision => decision.action === "overdue")) return "overdue";
    return "updated";
}

export async function runFutureIntentLifecycle(
    characterId: string,
    event: FutureIntentEvent,
    options: FutureIntentLifecycleOptions & { store?: FutureIntentLifecycleStore } = {},
): Promise<FutureIntentLifecycleRunResult> {
    const store = await resolveLifecycleStore(options.store);
    if (store.loadMemoryConfig?.().futureIntentEnabled === false) return { status: "disabled" };
    const timezone = await resolveCharacterTimezone(characterId, options.timezone);
    const entries = await store.loadMemoryEntriesByType(characterId, "long_term");
    const bindings = buildCandidateBindings(entries, event);
    const eventTime = parseDate(event.timestamp);
    const referenceNow = options.now && Number.isFinite(options.now.getTime())
        ? options.now
        : eventTime || new Date();
    let modelDecision: FutureIntentLifecycleModelDecision | null = null;
    if (bindings.length > 0) {
        const classifier = options.classifier || classifyWithMemorySummaryApi;
        try {
            modelDecision = await classifier(event, bindings.map(item => item.candidate), { now: referenceNow, timezone });
        } catch (error) {
            console.warn("[FutureIntentLifecycle] Semantic classifier failed; continuing with time maintenance", error);
        }
    }
    const targetBinding = modelDecision && modelDecision.action !== "none"
        && Number.isInteger(modelDecision.targetIndex)
        ? bindings[modelDecision.targetIndex]
        : undefined;
    const changedEntries: MemoryEntry[] = [];
    const decisions: FutureIntentLifecycleDecision[] = [];
    let eventActionApplied = false;
    for (const entry of entries) {
        const semanticDecision = targetBinding?.entry.id === entry.id && modelDecision && modelDecision.action !== "none"
            ? modelDecision.action === "replaced"
                ? { action: "replaced" as const, replacement: modelDecision.replacement }
                : { action: modelDecision.action }
            : undefined;
        const decision = decideFutureIntentTransition(entry, event, {
            now: options.now,
            timezone,
            semanticDecision,
        });
        if (decision.action === "none" || !decision.nextEntry) continue;
        if (["fulfilled", "cancelled", "replaced"].includes(decision.action) && eventActionApplied) continue;
        decisions.push(decision);
        changedEntries.push(decision.nextEntry);
        if (["fulfilled", "cancelled", "replaced"].includes(decision.action)) eventActionApplied = true;
        if (decision.replacementEntry) changedEntries.push(decision.replacementEntry);
    }
    if (changedEntries.length === 0) return { status: "no_change" };
    try {
        await store.saveMemoryEntries(changedEntries);
    } catch (error) {
        console.warn("[FutureIntentLifecycle] Lifecycle write failed; continuing without blocking chat", error);
        return { status: "write_failed", reason: error instanceof Error ? error.message : String(error) };
    }
    return { status: resultForDecisions(decisions), changedCount: changedEntries.length };
}

export async function maintainFutureIntentLifecycle(
    characterId: string,
    now = new Date(),
    options: { timezone?: string; store?: FutureIntentLifecycleStore } = {},
): Promise<FutureIntentLifecycleRunResult> {
    const store = await resolveLifecycleStore(options.store);
    if (store.loadMemoryConfig?.().futureIntentEnabled === false) return { status: "disabled" };
    const timezone = await resolveCharacterTimezone(characterId, options.timezone);
    const entries = await store.loadMemoryEntriesByType(characterId, "long_term");
    const changedEntries = entries
        .map(entry => decideFutureIntentTimeTransition(entry, now, timezone).nextEntry)
        .filter((entry): entry is MemoryEntry => Boolean(entry));
    if (changedEntries.length === 0) return { status: "no_change" };
    try {
        await store.saveMemoryEntries(changedEntries);
    } catch (error) {
        console.warn("[FutureIntentLifecycle] Maintenance write failed; continuing without blocking chat", error);
        return { status: "write_failed", reason: error instanceof Error ? error.message : String(error) };
    }
    return { status: "overdue", changedCount: changedEntries.length };
}

type LifecycleQueueItem = {
    characterId: string;
    event: FutureIntentEvent;
    resolve: (result: FutureIntentLifecycleRunResult) => void;
    reject: (error: unknown) => void;
};

type LifecycleQueueState = {
    pending: LifecycleQueueItem[];
    pendingByEventId: Map<string, Promise<FutureIntentLifecycleRunResult>>;
    processedEventIds: Set<string>;
    processedOrder: string[];
    running: boolean;
};

const MAX_PROCESSED_LIFECYCLE_EVENTS = 256;
const lifecycleQueueStates = new Map<string, LifecycleQueueState>();

function getLifecycleQueueState(characterId: string): LifecycleQueueState {
    const existing = lifecycleQueueStates.get(characterId);
    if (existing) return existing;
    const created: LifecycleQueueState = {
        pending: [],
        pendingByEventId: new Map(),
        processedEventIds: new Set(),
        processedOrder: [],
        running: false,
    };
    lifecycleQueueStates.set(characterId, created);
    return created;
}

function rememberProcessedLifecycleEvent(state: LifecycleQueueState, eventId: string): void {
    if (state.processedEventIds.has(eventId)) return;
    state.processedEventIds.add(eventId);
    state.processedOrder.push(eventId);
    if (state.processedOrder.length > MAX_PROCESSED_LIFECYCLE_EVENTS) {
        const oldest = state.processedOrder.shift();
        if (oldest) state.processedEventIds.delete(oldest);
    }
}

async function drainLifecycleQueue(characterId: string, state: LifecycleQueueState): Promise<void> {
    if (state.running) return;
    state.running = true;
    try {
        while (state.pending.length > 0) {
            const item = state.pending.shift();
            if (!item) continue;
            try {
                const result = await runFutureIntentLifecycle(item.characterId, item.event);
                rememberProcessedLifecycleEvent(state, item.event.id);
                item.resolve(result);
            } catch (error) {
                item.reject(error);
            } finally {
                state.pendingByEventId.delete(item.event.id);
            }
        }
    } finally {
        state.running = false;
        if (state.pending.length > 0) void drainLifecycleQueue(characterId, state);
    }
}

/** Queue exact native events so lifecycle writes cannot race per character. */
export function maybeRunFutureIntentLifecycle(
    characterId: string,
    event: FutureIntentEvent,
): Promise<FutureIntentLifecycleRunResult> {
    const state = getLifecycleQueueState(characterId);
    const pending = state.pendingByEventId.get(event.id);
    if (pending) return pending;
    if (state.processedEventIds.has(event.id)) return Promise.resolve({ status: "no_change", reason: "event_already_applied" });
    const promise = new Promise<FutureIntentLifecycleRunResult>((resolve, reject) => {
        state.pending.push({ characterId, event, resolve, reject });
    });
    state.pendingByEventId.set(event.id, promise);
    void drainLifecycleQueue(characterId, state);
    return promise;
}
