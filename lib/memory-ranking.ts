// Cognitive Retrieval v1: normalized feature scoring, protected intents,
// diversity control, and hard token-budget selection.

import type { MemoryEntry, MemoryLinkActivationPath } from "./memory-types";

export type MemoryCandidateSource = "vector" | "keyword" | "future_intent" | "recent" | "link";

export interface MemoryCandidate {
    memory: MemoryEntry;
    source?: MemoryCandidateSource;
    sources?: MemoryCandidateSource[];
    semanticScore?: number;
    keywordScore?: number;
    tagScore?: number;
    temporalScore?: number;
    linkActivationScore?: number;
    linkActivationPath?: MemoryLinkActivationPath;
}

export interface MemoryFeatures {
    semantic: number;
    keyword: number;
    tag: number;
    importance: number;
    recency: number;
    access: number;
    stability: number;
    mood: number;
    temporal: number;
    linkActivation: number;
}

export type ProtectedMemoryReason = "due_today" | "due_tomorrow" | "critical_overdue";

export interface RankedMemoryCandidate {
    memory: MemoryEntry;
    score: number;
    features: MemoryFeatures;
    sources: MemoryCandidateSource[];
    linkActivationScore?: number;
    linkActivationPath?: MemoryLinkActivationPath;
    protectedReason?: ProtectedMemoryReason;
    clusterKey?: string;
    tokenCost: number;
}

export type MemorySelectionDecisionReason =
    | "protected_priority"
    | "ranked"
    | "max_selected"
    | "protected_limit"
    | "token_budget"
    | "diversity_limit"
    | "lower_rank";

export interface MemorySelectionDecision {
    candidate: RankedMemoryCandidate;
    selected: boolean;
    reason: MemorySelectionDecisionReason;
}

export interface RankedMemorySelectionTrace {
    selected: RankedMemoryCandidate[];
    decisions: MemorySelectionDecision[];
}

export interface MemoryRankingOptions {
    now?: Date | string;
    timezone?: string;
}

export interface MemorySelectionOptions {
    tokenBudget?: number;
    longTermTokenBudget?: number;
    maxSelected?: number;
    maxSelectedLongTermMemories?: number;
    maxProtectedFutureIntents?: number;
    maxPerCluster?: number;
}

const MIN_USEFUL_SIMILARITY = 0.2;
const REFERENCE_ACCESS_COUNT = 20;
const DEFAULT_MAX_SELECTED = 10;
const DEFAULT_MAX_PROTECTED = 3;
const DEFAULT_MAX_PER_CLUSTER = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const RANK_WEIGHTS: MemoryFeatures = {
    semantic: 0.38,
    keyword: 0.12,
    tag: 0.08,
    importance: 0.14,
    recency: 0.08,
    access: 0.05,
    stability: 0.05,
    mood: 0.03,
    temporal: 0.07,
    linkActivation: 0.08,
};

function clamp(value: number, min = 0, max = 1): number {
    return Math.min(max, Math.max(min, value));
}

function safeDate(value: Date | string | undefined, fallback: Date): Date {
    const result = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? fallback);
    return Number.isFinite(result.getTime()) ? result : new Date(fallback.getTime());
}

function dateKey(value: Date, timezone?: string): string {
    if (timezone) {
        try {
            const parts = new Intl.DateTimeFormat("en-US", {
                timeZone: timezone,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
            }).formatToParts(value);
            const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
            return `${fields.year}-${fields.month}-${fields.day}`;
        } catch {
            // Invalid user time zones fall through to UTC rather than breaking recall.
        }
    }
    return value.toISOString().slice(0, 10);
}

function calendarDayDistance(left: Date, right: Date, timezone?: string): number {
    const leftKey = dateKey(left, timezone);
    const rightKey = dateKey(right, timezone);
    const leftDay = Date.parse(`${leftKey}T00:00:00Z`);
    const rightDay = Date.parse(`${rightKey}T00:00:00Z`);
    return Math.round((leftDay - rightDay) / DAY_MS);
}

function normalizeSemanticScore(score: number | undefined): number {
    if (!Number.isFinite(score)) return 0;
    return clamp((Number(score) - MIN_USEFUL_SIMILARITY) / (1 - MIN_USEFUL_SIMILARITY));
}

function getDecayDays(kind: MemoryEntry["kind"]): number {
    switch (kind) {
        case "user_fact":
        case "self_fact": return 365;
        case "relationship":
        case "knowledge": return 180;
        case "future_intent": return 1;
        default: return 30;
    }
}

function getRecencyScore(memory: MemoryEntry, now: Date): number {
    if (memory.kind === "future_intent") return 0.5;
    const updated = safeDate(memory.updatedAt || memory.createdAt, now);
    const ageDays = Math.max(0, (now.getTime() - updated.getTime()) / DAY_MS);
    return clamp(Math.exp(-ageDays / getDecayDays(memory.kind)));
}

function getMoodScore(memory: MemoryEntry, context: string): number {
    if (!memory.mood) return 0;
    const moodTerms: Record<string, string[]> = {
        happy: ["开心", "高兴", "快乐", "happy"],
        tender: ["温柔", "想你", "拥抱", "tender"],
        excited: ["兴奋", "期待", "激动", "excited"],
        sad: ["难过", "伤心", "失落", "sad"],
        angry: ["生气", "愤怒", "恼火", "angry"],
        anxious: ["焦虑", "担心", "不安", "anxious"],
        afraid: ["害怕", "恐惧", "怕", "afraid"],
        jealous: ["吃醋", "嫉妒", "jealous"],
        embarrassed: ["尴尬", "害羞", "embarrassed"],
        lonely: ["孤单", "寂寞", "lonely"],
        nostalgic: ["怀念", "回忆", "nostalgic"],
        neutral: ["平静", "日常", "neutral"],
    };
    const terms = moodTerms[memory.mood] ?? [];
    return terms.some(term => context.toLocaleLowerCase().includes(term.toLocaleLowerCase())) ? 1 : 0;
}

function getFutureIntentTarget(memory: MemoryEntry): Date | undefined {
    if (memory.kind !== "future_intent") return undefined;
    const value = memory.futureIntent?.targetAt ?? memory.futureIntent?.targetEndAt;
    if (!value) return undefined;
    const target = new Date(value);
    return Number.isFinite(target.getTime()) ? target : undefined;
}

export function getFutureIntentUrgency(
    memory: MemoryEntry,
    now = new Date(),
    timezone?: string,
): number {
    const intent = memory.futureIntent;
    if (memory.kind !== "future_intent" || !intent || !["pending", "overdue"].includes(intent.status)) return 0;
    const target = getFutureIntentTarget(memory);
    if (!target) return 0;

    const dayDistance = calendarDayDistance(target, now, timezone);
    if (intent.status === "overdue" || target.getTime() < now.getTime()) {
        if (Math.abs(dayDistance) <= 1) return 0.8;
        if (Math.abs(dayDistance) <= 3) return 0.55;
        return 0.2;
    }
    if (dayDistance <= 0) return 1;
    if (dayDistance === 1) return 0.9;
    if (dayDistance <= 3) return 0.75;
    if (dayDistance <= 7) return 0.45;
    return 0.2;
}

function getProtectedReason(
    memory: MemoryEntry,
    now: Date,
    timezone?: string,
): ProtectedMemoryReason | undefined {
    const intent = memory.futureIntent;
    if (memory.kind !== "future_intent" || !intent || !["pending", "overdue"].includes(intent.status)) return undefined;
    if (intent.type !== "plan" && intent.type !== "promise") return undefined;
    const target = getFutureIntentTarget(memory);
    if (!target) return undefined;
    const dayDistance = calendarDayDistance(target, now, timezone);
    if (intent.status === "overdue" && dayDistance >= -1 && dayDistance <= 0) return "critical_overdue";
    if (dayDistance === 0) return "due_today";
    if (dayDistance === 1) return "due_tomorrow";
    return undefined;
}

function getCandidateSources(candidate: MemoryCandidate): MemoryCandidateSource[] {
    return [...new Set([
        ...(candidate.sources ?? []),
        ...(candidate.source ? [candidate.source] : []),
    ])];
}

function normalizeLinkActivation(value: number | undefined): number {
    return Number.isFinite(value) ? clamp(value ?? 0) : 0;
}

function linkPathKey(path: MemoryLinkActivationPath | undefined): string {
    if (!path) return "";
    return [
        path.seedMemoryIds.join(","),
        path.memoryIds.join(">"),
        path.linkIds.join(">"),
    ].join("|");
}

function chooseLinkPath(
    left: MemoryLinkActivationPath | undefined,
    right: MemoryLinkActivationPath | undefined,
): MemoryLinkActivationPath | undefined {
    if (!left) return right;
    if (!right) return left;
    if (right.activation !== left.activation) return right.activation > left.activation ? right : left;
    if (right.depth !== left.depth) return right.depth < left.depth ? right : left;
    return linkPathKey(right) < linkPathKey(left) ? right : left;
}

function mergeCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
    const merged = new Map<string, MemoryCandidate>();
    for (const candidate of candidates) {
        const previous = merged.get(candidate.memory.id);
        if (!previous) {
            merged.set(candidate.memory.id, {
                ...candidate,
                sources: getCandidateSources(candidate),
            });
            continue;
        }
        merged.set(candidate.memory.id, {
            memory: previous.memory,
            sources: [...new Set([...getCandidateSources(previous), ...getCandidateSources(candidate)])],
            semanticScore: Math.max(previous.semanticScore ?? -1, candidate.semanticScore ?? -1) >= 0
                ? Math.max(previous.semanticScore ?? -1, candidate.semanticScore ?? -1)
                : undefined,
            keywordScore: Math.max(previous.keywordScore ?? 0, candidate.keywordScore ?? 0),
            tagScore: Math.max(previous.tagScore ?? 0, candidate.tagScore ?? 0),
            temporalScore: Math.max(previous.temporalScore ?? 0, candidate.temporalScore ?? 0),
            linkActivationScore: Math.max(
                normalizeLinkActivation(previous.linkActivationScore),
                normalizeLinkActivation(candidate.linkActivationScore),
            ),
            linkActivationPath: chooseLinkPath(previous.linkActivationPath, candidate.linkActivationPath),
        });
    }
    return [...merged.values()];
}

export function calculateMemoryFeatures(
    memory: MemoryEntry,
    context: string,
    candidate: MemoryCandidate = { memory },
    options: MemoryRankingOptions = {},
): MemoryFeatures {
    const now = safeDate(options.now, new Date());
    const temporal = candidate.temporalScore ?? getFutureIntentUrgency(memory, now, options.timezone);
    const importance = clamp(Number(memory.importance) || 0);
    const rawStability = Number(memory.stability);
    const stability = Number.isFinite(rawStability)
        ? clamp(rawStability)
        : clamp(0.35 + importance * 0.4);
    const accessCount = Math.max(0, Number(memory.accessCount) || 0);
    return {
        semantic: normalizeSemanticScore(candidate.semanticScore),
        keyword: clamp(candidate.keywordScore ?? 0),
        tag: clamp(candidate.tagScore ?? 0),
        importance,
        recency: getRecencyScore(memory, now),
        access: clamp(Math.log1p(accessCount) / Math.log1p(REFERENCE_ACCESS_COUNT)),
        stability,
        mood: getMoodScore(memory, context),
        temporal: clamp(temporal),
        linkActivation: normalizeLinkActivation(candidate.linkActivationScore),
    };
}

function scoreFeatures(features: MemoryFeatures): number {
    return (Object.keys(RANK_WEIGHTS) as Array<keyof MemoryFeatures>)
        .reduce((total, key) => total + features[key] * RANK_WEIGHTS[key], 0);
}

function getMetadataString(memory: MemoryEntry, keys: string[]): string | undefined {
    for (const key of keys) {
        const value = memory.metadata?.[key];
        if (typeof value === "string" && value.trim()) return `${key}:${value.trim()}`;
    }
    return undefined;
}

function getMetadataStrings(memory: MemoryEntry, key: string): string[] {
    const value = memory.metadata?.[key];
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [];
}

/** Best-effort cluster key. Memories without provenance remain unconstrained. */
export function getMemoryClusterKey(memory: MemoryEntry): string | undefined {
    const explicit = getMetadataString(memory, ["memoryClusterId", "sourceEventClusterId", "sourceBatchId"]);
    if (explicit) return explicit;
    const signatures = getMetadataStrings(memory, "sourceEventSignatures");
    if (signatures.length > 0) return `sourceEventSignatures:${[...signatures].sort().join("|")}`;
    const sourceMessageIds = memory.sourceMessageIds ?? getMetadataStrings(memory, "sourceMessageIds");
    if (sourceMessageIds.length > 0) return `sourceMessageIds:${[...sourceMessageIds].sort().join("|")}`;
    return undefined;
}

function estimateMemoryTokens(content: string): number {
    const cjkCount = (content.match(/[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g) ?? []).length;
    return Math.ceil(cjkCount / 1.5 + (content.length - cjkCount) / 4) + 4;
}

export function rankMemoryCandidates(
    candidates: MemoryCandidate[],
    context: string,
    options: MemoryRankingOptions = {},
): RankedMemoryCandidate[] {
    const now = safeDate(options.now, new Date());
    return mergeCandidates(candidates)
        .map(candidate => {
            const features = calculateMemoryFeatures(candidate.memory, context, candidate, { ...options, now });
            return {
                memory: candidate.memory,
                score: scoreFeatures(features),
                features,
                sources: getCandidateSources(candidate),
                linkActivationScore: candidate.linkActivationScore,
                linkActivationPath: candidate.linkActivationPath,
                protectedReason: getProtectedReason(candidate.memory, now, options.timezone),
                clusterKey: getMemoryClusterKey(candidate.memory),
                tokenCost: estimateMemoryTokens(candidate.memory.content),
            } satisfies RankedMemoryCandidate;
        })
        .sort((left, right) => {
            if (right.score !== left.score) return right.score - left.score;
            if (right.features.temporal !== left.features.temporal) return right.features.temporal - left.features.temporal;
            if (right.features.importance !== left.features.importance) return right.features.importance - left.features.importance;
            return right.memory.updatedAt.localeCompare(left.memory.updatedAt) || left.memory.id.localeCompare(right.memory.id);
        });
}

function getSelectionRejectionReason(
    candidate: RankedMemoryCandidate,
    selected: RankedMemoryCandidate[],
    usedTokens: number,
    tokenBudget: number,
    maxPerCluster: number,
): Exclude<MemorySelectionDecisionReason, "protected_priority" | "ranked" | "lower_rank"> | undefined {
    if (usedTokens + candidate.tokenCost > tokenBudget) return "token_budget";
    if (!candidate.clusterKey) return undefined;
    const clusterCount = selected.filter(item => item.clusterKey === candidate.clusterKey).length;
    return clusterCount < maxPerCluster ? undefined : "diversity_limit";
}

function selectRankedMemoryCandidatesInternal(
    ranked: RankedMemoryCandidate[],
    options: MemorySelectionOptions = {},
): RankedMemorySelectionTrace {
    const rawBudget = options.tokenBudget ?? options.longTermTokenBudget ?? Number.POSITIVE_INFINITY;
    const tokenBudget = Number.isFinite(rawBudget) ? Math.max(0, rawBudget) : Number.POSITIVE_INFINITY;
    const maxSelected = Math.max(0, Math.floor(options.maxSelectedLongTermMemories ?? options.maxSelected ?? DEFAULT_MAX_SELECTED));
    const maxProtected = Math.max(0, Math.floor(options.maxProtectedFutureIntents ?? DEFAULT_MAX_PROTECTED));
    const maxPerCluster = Math.max(1, Math.floor(options.maxPerCluster ?? DEFAULT_MAX_PER_CLUSTER));
    const decisions = new Map<string, MemorySelectionDecision>();
    if (maxSelected === 0 || tokenBudget === 0) {
        const reason = maxSelected === 0 ? "max_selected" : "token_budget";
        return {
            selected: [],
            decisions: ranked.map(candidate => ({ candidate, selected: false, reason })),
        };
    }

    const selected: RankedMemoryCandidate[] = [];
    const selectedIds = new Set<string>();
    let usedTokens = 0;
    let protectedCount = 0;

    const recordRejection = (
        candidate: RankedMemoryCandidate,
        reason: Exclude<MemorySelectionDecisionReason, "protected_priority" | "ranked">,
    ): void => {
        if (!decisions.has(candidate.memory.id)) {
            decisions.set(candidate.memory.id, { candidate, selected: false, reason });
        }
    };

    const tryAdd = (
        candidate: RankedMemoryCandidate,
        selectedReason: "protected_priority" | "ranked",
    ): void => {
        if (selectedIds.has(candidate.memory.id)) return;
        if (selected.length >= maxSelected) {
            recordRejection(candidate, "max_selected");
            return;
        }
        const rejectionReason = getSelectionRejectionReason(
            candidate,
            selected,
            usedTokens,
            tokenBudget,
            maxPerCluster,
        );
        if (rejectionReason) {
            recordRejection(candidate, rejectionReason);
            return;
        }
        selected.push(candidate);
        selectedIds.add(candidate.memory.id);
        usedTokens += candidate.tokenCost;
        if (candidate.protectedReason) protectedCount += 1;
        decisions.set(candidate.memory.id, { candidate, selected: true, reason: selectedReason });
    };

    for (const candidate of ranked.filter(item => item.protectedReason)) {
        if (protectedCount >= maxProtected) {
            recordRejection(candidate, "protected_limit");
            break;
        }
        tryAdd(candidate, "protected_priority");
    }
    for (const candidate of ranked) {
        if (candidate.protectedReason && protectedCount >= maxProtected) {
            recordRejection(candidate, "protected_limit");
            continue;
        }
        tryAdd(candidate, "ranked");
        if (selected.length >= maxSelected) break;
    }

    for (const candidate of ranked) {
        if (decisions.has(candidate.memory.id)) continue;
        recordRejection(
            candidate,
            selected.length >= maxSelected ? "max_selected" : "lower_rank",
        );
    }

    return {
        selected,
        decisions: ranked.map(candidate => decisions.get(candidate.memory.id) as MemorySelectionDecision),
    };
}

/** Select after ranking; a long candidate never blocks later short candidates. */
export function selectRankedMemoryCandidates(
    ranked: RankedMemoryCandidate[],
    options: MemorySelectionOptions = {},
): RankedMemoryCandidate[] {
    return selectRankedMemoryCandidatesInternal(ranked, options).selected;
}

/** Select after ranking and retain deterministic per-candidate decisions for debug tooling. */
export function selectRankedMemoryCandidatesWithTrace(
    ranked: RankedMemoryCandidate[],
    options: MemorySelectionOptions = {},
): RankedMemorySelectionTrace {
    return selectRankedMemoryCandidatesInternal(ranked, options);
}
