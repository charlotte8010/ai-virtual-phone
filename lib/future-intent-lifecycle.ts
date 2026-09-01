import type { FutureIntentEvent } from "./future-intent-detector";
import type { FutureIntentMeta, MemoryEntry } from "./memory-types";

export type FutureIntentLifecycleAction = "none" | "overdue" | "fulfilled" | "cancelled" | "replaced";

export type FutureIntentLifecycleDecision = {
    action: FutureIntentLifecycleAction;
    reason: string;
    nextEntry?: MemoryEntry;
    replacementEntry?: MemoryEntry;
};

export type FutureIntentLifecycleOptions = {
    now?: Date;
    timezone?: string;
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
const RESCHEDULE_PATTERN = /(?:改到|改为|改成|挪到|推迟到|延期到|顺延到|换到|改约到)/u;
const FULFILMENT_PATTERN = /(?:完成了?|做完了?|办完了?|搞定了?|已经.{0,8}(?:看完|看了|去了|去过|见面|见了|吃完|吃了)|.{0,8}(?:看完了|看了|去了|去过|见面了|见了|吃完了|吃过了))/u;
const CANCELLATION_PATTERN = /(?:取消|不去了?|不去啦|不去喽|不做了?|不用做了|不用了|算了|放弃|作废|不再.{0,4}(?:做|去|安排|执行))/u;
const RELATION_STOP_WORDS = [
    "明天", "明早", "明晚", "后天", "今天", "今晚", "这周", "本周", "下周", "周末",
    "以后", "到时候", "一起", "已经", "完成", "做完", "办完", "搞定", "取消", "那个",
    "这件事", "计划", "改到", "改为", "改成", "挪到", "推迟到", "延期到", "顺延到", "换到",
    "改约到", "看完", "去了", "去过", "见面", "见了", "吃完", "吃过", "不去了", "不做了",
    "不用了", "算了", "了", "的", "和", "跟", "去", "看", "做", "我", "你", "我们",
];
const RELATION_STOP_PATTERN = new RegExp(RELATION_STOP_WORDS.map(escapeRegExp).join("|"), "gu");
const CHINESE_HOUR_VALUES: Record<string, number> = {
    零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};
const WEEKDAY_VALUES: Record<string, number> = { 日: 6, 天: 6, 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5 };

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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

function hasIntentRelation(intentContent: string, eventContent: string): boolean {
    const normalize = (value: string): string => value
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(RELATION_STOP_PATTERN, "")
        .replace(/[^\p{L}\p{N}]+/gu, "");
    const left = normalize(intentContent);
    const right = normalize(eventContent);
    if (left.length < 2 || right.length < 2) return false;
    if (left.includes(right) || right.includes(left)) return true;
    const leftBigrams = new Set<string>();
    const rightBigrams = new Set<string>();
    for (let index = 0; index < left.length - 1; index += 1) leftBigrams.add(left.slice(index, index + 2));
    for (let index = 0; index < right.length - 1; index += 1) rightBigrams.add(right.slice(index, index + 2));
    return [...leftBigrams].some(value => rightBigrams.has(value));
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

function getTimeZoneOffsetMillis(value: Date, timezone: string): number | undefined {
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            timeZoneName: "longOffset",
        }).formatToParts(value);
        const name = parts.find(part => part.type === "timeZoneName")?.value;
        if (!name || name === "GMT") return 0;
        const match = name.match(/^GMT([+-])(\d{2}):?(\d{2})$/u);
        if (!match) return undefined;
        const minutes = Number(match[2]) * 60 + Number(match[3]);
        return (match[1] === "+" ? 1 : -1) * minutes * 60 * 1000;
    } catch {
        return undefined;
    }
}

function zonedDateToIso(
    parts: { year: number; month: number; day: number; hour: number; minute: number },
    timezone: string,
): string | undefined {
    if (!isValidTimeZone(timezone)) return undefined;
    let guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    for (let index = 0; index < 3; index += 1) {
        const offset = getTimeZoneOffsetMillis(new Date(guess), timezone);
        if (offset === undefined) return undefined;
        guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - offset;
    }
    return new Date(guess).toISOString();
}

function getZonedDateParts(value: Date, timezone: string): { year: number; month: number; day: number; weekday: number } | undefined {
    if (!isValidTimeZone(timezone)) return undefined;
    try {
        const parts = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            year: "numeric",
            month: "numeric",
            day: "numeric",
            weekday: "short",
        }).formatToParts(value);
        const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
        const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(values.weekday);
        return {
            year: Number(values.year),
            month: Number(values.month),
            day: Number(values.day),
            weekday: weekday >= 0 ? weekday : 0,
        };
    } catch {
        return undefined;
    }
}

function addCalendarDays(value: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
    const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function parseChineseNumber(value: string): number | undefined {
    if (/^\d+$/u.test(value)) return Number(value);
    if (value.length === 1) return CHINESE_HOUR_VALUES[value];
    if (value === "十") return 10;
    if (value.startsWith("十")) return 10 + (CHINESE_HOUR_VALUES[value.slice(1)] ?? 0);
    if (value.endsWith("十")) return (CHINESE_HOUR_VALUES[value.slice(0, -1)] ?? 0) * 10;
    if (value.length === 3 && value[1] === "十") {
        return (CHINESE_HOUR_VALUES[value[0]] ?? 0) * 10 + (CHINESE_HOUR_VALUES[value[2]] ?? 0);
    }
    return undefined;
}

function parseClock(value: string): { hour: number; minute: number } | undefined {
    const match = value.match(/(凌晨|早上|早晨|上午|中午|下午|晚上|晚间|今晚)?\s*(\d{1,2}|[零一二三四五六七八九十两]+)(?:(?:[：:]\s*(\d{1,2}))|(?:\s*点\s*(\d{1,2})?))/u);
    if (!match) return undefined;
    let hour = parseChineseNumber(match[2]);
    if (hour === undefined || hour > 23) return undefined;
    const minute = Number(match[3] ?? match[4] ?? 0);
    if (!Number.isFinite(minute) || minute > 59) return undefined;
    if (["下午", "晚上", "晚间", "今晚"].includes(match[1] ?? "") && hour < 12) hour += 12;
    if (match[1] === "中午" && hour < 11) hour += 12;
    return { hour, minute };
}

type ReplacementTime = {
    targetAt: string;
    timePrecision: "exact" | "day";
    originalTimeExpression: string;
};

function parseReplacementTime(event: FutureIntentEvent, timezone: string | undefined): ReplacementTime | undefined {
    const content = event.content;
    const absolute = content.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T\s]+\d{1,2}(?::|：)\d{2})?(?:Z|[+-]\d{2}:?\d{2})?/u);
    if (absolute) {
        const expression = absolute[0].replace(/\//gu, "-");
        const hasClock = /(?:T|\s)\d{1,2}(?::|：)\d{2}/u.test(expression);
        if (/[+-]\d{2}:?\d{2}$|Z$/u.test(expression)) {
            const parsed = parseDate(expression.replace(" ", "T"));
            if (parsed) return { targetAt: parsed.toISOString(), timePrecision: hasClock ? "exact" : "day", originalTimeExpression: absolute[0] };
        }
        const parts = expression.match(/(\d{4})-(\d{1,2})-(\d{1,2})(?:T|\s+)?(?:(\d{1,2})(?::|：)(\d{2}))?/u);
        if (!parts || !isValidTimeZone(timezone)) return undefined;
        const hour = parts[4] === undefined ? 0 : Number(parts[4]);
        const minute = parts[5] === undefined ? 0 : Number(parts[5]);
        const targetAt = zonedDateToIso({ year: Number(parts[1]), month: Number(parts[2]), day: Number(parts[3]), hour, minute }, timezone);
        if (!targetAt) return undefined;
        return { targetAt, timePrecision: hasClock ? "exact" : "day", originalTimeExpression: absolute[0] };
    }

    const chineseAbsolute = content.match(/\d{4}年\d{1,2}月\d{1,2}日[^，。；;！!\n]*/u);
    if (chineseAbsolute) {
        const parts = chineseAbsolute[0].match(/(\d{4})年(\d{1,2})月(\d{1,2})日/u);
        if (!parts || !isValidTimeZone(timezone)) return undefined;
        const clock = parseClock(chineseAbsolute[0].split("日").slice(1).join("日"));
        const targetAt = zonedDateToIso({
            year: Number(parts[1]), month: Number(parts[2]), day: Number(parts[3]), hour: clock?.hour ?? 0, minute: clock?.minute ?? 0,
        }, timezone);
        if (!targetAt) return undefined;
        return { targetAt, timePrecision: clock ? "exact" : "day", originalTimeExpression: chineseAbsolute[0].trim() };
    }

    const relative = content.match(/(?:大后天|后天|明早|明晚|明天|(?:下周|下星期|下礼拜|这周|本周)?(?:周)?[一二三四五六日天])[^，。；;！!\n]*/u);
    if (!relative || !isValidTimeZone(timezone)) return undefined;
    const base = parseDate(event.timestamp);
    const baseParts = base ? getZonedDateParts(base, timezone) : undefined;
    if (!baseParts) return undefined;
    const expression = relative[0].trim();
    const clock = parseClock(expression);
    let targetDay: { year: number; month: number; day: number };
    if (expression.startsWith("大后天")) {
        targetDay = addCalendarDays(baseParts, 3);
    } else if (expression.startsWith("后天")) {
        targetDay = addCalendarDays(baseParts, 2);
    } else if (/^明(?:早|晚|天)/u.test(expression)) {
        targetDay = addCalendarDays(baseParts, 1);
    } else {
        const weekdayMatch = expression.match(/^(下周|下星期|下礼拜|这周|本周)?(?:周)?([一二三四五六日天])/u);
        if (!weekdayMatch) return undefined;
        const targetWeekday = WEEKDAY_VALUES[weekdayMatch[2]];
        const currentMondayIndex = (baseParts.weekday + 6) % 7;
        const delta = weekdayMatch[1] && ["下周", "下星期", "下礼拜"].includes(weekdayMatch[1])
            ? 7 - currentMondayIndex + targetWeekday
            : Math.max(0, targetWeekday - currentMondayIndex);
        targetDay = addCalendarDays(baseParts, delta);
    }
    const targetAt = zonedDateToIso({
        ...targetDay,
        hour: clock?.hour ?? 0,
        minute: clock?.minute ?? 0,
    }, timezone);
    if (!targetAt) return undefined;
    return { targetAt, timePrecision: clock ? "exact" : "day", originalTimeExpression: expression };
}

function createReplacementEntry(
    entry: MemoryEntry,
    event: FutureIntentEvent,
    replacementTime: ReplacementTime,
    replacementId: string,
    at: Date,
): MemoryEntry {
    const currentIntent = entry.futureIntent!;
    const sourceSignature = `${entry.characterId}:${event.sourceApp}:${event.id}`;
    const futureIntent: FutureIntentMeta = {
        type: currentIntent.type,
        status: "pending",
        timePrecision: replacementTime.timePrecision,
        targetAt: replacementTime.targetAt,
        timezone: currentIntent.timezone,
        originalTimeExpression: replacementTime.originalTimeExpression,
    };
    return {
        ...entry,
        id: replacementId,
        content: event.content.trim().slice(0, 2000),
        createdAt: at.toISOString(),
        updatedAt: at.toISOString(),
        sourceMessageIds: [event.id],
        embedding: undefined,
        futureIntent,
        metadata: {
            ...(entry.metadata ?? {}),
            sourceEventSignatures: [sourceSignature],
            sourceEventTimestamps: [event.timestamp],
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

    const related = hasIntentRelation(entry.content, event.content);
    const hasFulfilment = FULFILMENT_PATTERN.test(event.content);
    const hasCancellation = CANCELLATION_PATTERN.test(event.content);
    const hasReschedule = RESCHEDULE_PATTERN.test(event.content);
    const eventKinds = Number(hasFulfilment) + Number(hasCancellation) + Number(hasReschedule);
    if (related && eventKinds > 1) return { action: "none", reason: "conflicting_event_evidence" };

    if (related && hasReschedule) {
        const replacementTime = parseReplacementTime(event, options.timezone || intent.timezone);
        if (!replacementTime) return { action: "none", reason: "replacement_time_unresolved" };
        const replacementId = buildReplacementId();
        const replacementEntry = createReplacementEntry(entry, event, replacementTime, replacementId, eventTime);
        const nextEntry = buildTerminalEntry(entry, event, "cancelled", eventTime);
        nextEntry.futureIntent = { ...nextEntry.futureIntent!, replacedByMemoryId: replacementId };
        return { action: "replaced", reason: "explicit_reschedule", nextEntry, replacementEntry };
    }
    if (related && hasFulfilment) {
        return {
            action: "fulfilled",
            reason: "explicit_completion_evidence",
            nextEntry: buildTerminalEntry(entry, event, "fulfilled", eventTime),
        };
    }
    if (related && hasCancellation) {
        return {
            action: "cancelled",
            reason: "explicit_cancellation_evidence",
            nextEntry: buildTerminalEntry(entry, event, "cancelled", eventTime),
        };
    }

    return decideFutureIntentTimeTransition(entry, options.now ?? eventTime, options.timezone);
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
    const decisions: FutureIntentLifecycleDecision[] = [];
    const changedEntries: MemoryEntry[] = [];
    let eventActionApplied = false;
    let replacementCreated = false;
    for (const entry of entries) {
        const decision = decideFutureIntentTransition(entry, event, { ...options, timezone });
        if (decision.action === "none" || !decision.nextEntry) continue;
        if (["fulfilled", "cancelled", "replaced"].includes(decision.action) && eventActionApplied) continue;
        if (decision.action === "replaced" && replacementCreated) continue;
        decisions.push(decision);
        changedEntries.push(decision.nextEntry);
        if (["fulfilled", "cancelled", "replaced"].includes(decision.action)) eventActionApplied = true;
        if (decision.replacementEntry) {
            changedEntries.push(decision.replacementEntry);
            replacementCreated = true;
        }
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
