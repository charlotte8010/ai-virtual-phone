// High-level memory orchestration: candidate generation, ranking, and prompt selection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryConfig, loadMemoryEntriesByType, updateMemoryRecallStats } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity } from "./memory-embedding";
import { estimateTokens } from "./token-counter";
import { searchMemoryText } from "./memory-text-search";
import {
    rankMemoryCandidates,
    selectRankedMemoryCandidates,
    selectRankedMemoryCandidatesWithTrace,
    type MemoryCandidate,
    type MemoryCandidateSource,
    type MemoryFeatures,
    type MemoryRankingOptions,
    type MemorySelectionDecision,
    type MemorySelectionDecisionReason,
    type MemorySelectionOptions as RankingSelectionOptions,
    type RankedMemoryCandidate,
} from "./memory-ranking";
import { getRecallMemoryIds, type RecallWriteGuard } from "./memory-recall-stats";

const VECTOR_TOP_K = 20;
const KEYWORD_TOP_K = 20;
const RECENT_TOP_K = 10;

export interface MemorySelectionOptions extends MemoryRankingOptions, RankingSelectionOptions {
    config?: MemoryConfig;
    vectorTopK?: number;
    keywordTopK?: number;
    recentTopK?: number;
    /** Opt-in candidate-level retrieval instrumentation. It never writes memory state. */
    debug?: boolean;
    debugCollector?: MemoryRetrievalDebugCollector;
}

export interface MemoryRetrievalDebugLimits {
    vectorTopK: number;
    keywordTopK: number;
    recentTopK: number;
    tokenBudget: number;
    maxSelected: number;
    maxProtectedFutureIntents: number;
    maxPerCluster: number;
}

export interface MemoryRetrievalDebugCandidate {
    memoryId: string;
    sourceApp: MemoryEntry["sourceApp"];
    sources: MemoryCandidateSource[];
    featureScores: MemoryFeatures;
    finalScore: number;
    tokenCost: number;
    protectedReason?: string;
    selected: boolean;
    selectionReason?: MemorySelectionDecisionReason;
    rejectionReason?: MemorySelectionDecisionReason;
}

export interface MemoryRetrievalDebug {
    mode: "hybrid" | "legacy";
    totalMemories: number;
    candidateCount: number;
    channelCounts: Record<MemoryCandidateSource, number>;
    selectedCount: number;
    selectedIds: string[];
    protectedIds: string[];
    usedTokens: number;
    characterId: string;
    query: string;
    timestamp: string;
    limits: MemoryRetrievalDebugLimits;
    /** Present only when debug=true (or a collector is supplied). */
    candidates?: MemoryRetrievalDebugCandidate[];
    selectedMemoryIds: string[];
    /** Populated by a collector after the prompt assembler confirms injection. */
    injectedMemoryIds: string[];
}

export interface MemorySelectionResult {
    selected: MemoryEntry[];
    futureIntents: MemoryEntry[];
    debug?: MemoryRetrievalDebug;
}

export interface MemoryRetrievalDebugSnapshot {
    retrieval?: MemoryRetrievalDebug;
    injectedMemoryIds: string[];
}

export interface MemoryRetrievalDebugCollector {
    recordRetrieval(debug: MemoryRetrievalDebug): void;
    recordInjectedMemoryIds(memoryIds: readonly string[]): void;
    getSnapshot(): MemoryRetrievalDebugSnapshot;
}

/** Create an in-memory debug session for retrieval and confirmed prompt injection. */
export function createMemoryRetrievalDebugCollector(): MemoryRetrievalDebugCollector {
    let retrieval: MemoryRetrievalDebug | undefined;
    let injectedMemoryIds: string[] = [];
    return {
        recordRetrieval(debug): void {
            retrieval = cloneRetrievalDebug(debug);
        },
        recordInjectedMemoryIds(memoryIds): void {
            injectedMemoryIds = [...new Set([
                ...injectedMemoryIds,
                ...memoryIds.filter(id => typeof id === "string" && id.trim().length > 0),
            ])];
        },
        getSnapshot(): MemoryRetrievalDebugSnapshot {
            return {
                retrieval: retrieval
                    ? { ...cloneRetrievalDebug(retrieval), injectedMemoryIds: [...injectedMemoryIds] }
                    : undefined,
                injectedMemoryIds: [...injectedMemoryIds],
            };
        },
    };
}

export function shouldUseCognitiveRetrieval(config: MemoryConfig): boolean {
    return config.cognitiveMemoryEnabled !== false && config.hybridRecallEnabled !== false;
}

/**
 * Select long-term memories for a real prompt. The legacy all-fit behavior is
 * kept behind an explicit feature flag so old users can roll back safely.
 */
export async function selectMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    options: MemorySelectionOptions = {},
): Promise<MemorySelectionResult> {
    const config = options.config ?? loadMemoryConfig();
    const debugEnabled = options.debug === true || options.debugCollector !== undefined;
    const debugLimits = resolveDebugLimits(config, options);
    const debugTimestamp = resolveDebugTimestamp(options.now);
    if (!shouldUseCognitiveRetrieval(config)) {
        const selected = await retrieveLegacyMemoriesForPrompt(characterId, currentContext, config);
        const debug = buildDebugResult({
            mode: "legacy",
            characterId,
            query: currentContext,
            timestamp: debugTimestamp,
            limits: debugLimits,
            totalMemories: selected.length,
            ranked: [],
            selectedIds: selected.map(entry => entry.id),
            selectedCount: selected.length,
            protectedIds: [],
            usedTokens: selected.reduce((total, entry) => total + estimateTokens(entry.content) + 4, 0),
            channelCounts: { vector: 0, keyword: 0, future_intent: 0, recent: 0 },
            debugEnabled,
            debugCollector: options.debugCollector,
        });
        return {
            selected,
            futureIntents: selected.filter(entry => entry.kind === "future_intent"),
            debug,
        };
    }

    const memories = await loadMemoryEntriesByType(characterId, "long_term");
    if (memories.length === 0) {
        const debug = buildDebugResult({
            mode: "hybrid",
            characterId,
            query: currentContext,
            timestamp: debugTimestamp,
            limits: debugLimits,
            totalMemories: memories.length,
            ranked: [],
            selectedIds: [],
            selectedCount: 0,
            protectedIds: [],
            usedTokens: 0,
            channelCounts: { vector: 0, keyword: 0, future_intent: 0, recent: 0 },
            debugEnabled,
            debugCollector: options.debugCollector,
        });
        return {
            selected: [],
            futureIntents: [],
            debug,
        };
    }

    const candidatesById = new Map<string, MemoryCandidate>();
    const channelCounts: Record<MemoryCandidateSource, number> = {
        vector: 0,
        keyword: 0,
        future_intent: 0,
        recent: 0,
    };
    const addCandidate = (candidate: MemoryCandidate): void => {
        const previous = candidatesById.get(candidate.memory.id);
        if (!previous) {
            candidatesById.set(candidate.memory.id, candidate);
            return;
        }
        const sources = [...new Set([
            ...(previous.sources ?? []),
            ...(previous.source ? [previous.source] : []),
            ...(candidate.sources ?? []),
            ...(candidate.source ? [candidate.source] : []),
        ])];
        candidatesById.set(candidate.memory.id, {
            memory: previous.memory,
            sources,
            semanticScore: Math.max(previous.semanticScore ?? -1, candidate.semanticScore ?? -1) >= 0
                ? Math.max(previous.semanticScore ?? -1, candidate.semanticScore ?? -1)
                : undefined,
            keywordScore: Math.max(previous.keywordScore ?? 0, candidate.keywordScore ?? 0),
            tagScore: Math.max(previous.tagScore ?? 0, candidate.tagScore ?? 0),
            temporalScore: Math.max(previous.temporalScore ?? 0, candidate.temporalScore ?? 0),
        });
    };

    if (currentContext.trim()) {
        const keywordResults = searchMemoryText(
            currentContext,
            memories,
            options.keywordTopK ?? KEYWORD_TOP_K,
        );
        for (const result of keywordResults) {
            channelCounts.keyword += 1;
            addCandidate({
                memory: result.entry,
                source: "keyword",
                keywordScore: result.keywordScore,
                tagScore: result.tagScore,
            });
        }

        const embeddingApiConfig = config.vectorRecallEnabled
            ? resolveAuxiliaryApiConfig("embeddingApiConfigId")
            : null;
        const vectorTopK = Math.max(0, Math.floor(options.vectorTopK ?? VECTOR_TOP_K));
        if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
            try {
                const queryEmbedding = await generateEmbedding(currentContext, embeddingApiConfig);
                if (queryEmbedding) {
                    const vectorResults = memories
                        .filter(entry => Array.isArray(entry.embedding) && entry.embedding.length > 0)
                        .map(entry => ({
                            entry,
                            score: cosineSimilarity(queryEmbedding, entry.embedding ?? []),
                        }))
                        .sort((left, right) => right.score - left.score)
                        .slice(0, vectorTopK);
                    for (const result of vectorResults) {
                        channelCounts.vector += 1;
                        addCandidate({ memory: result.entry, source: "vector", semanticScore: result.score });
                    }
                }
            } catch (error) {
                console.warn("[MemoryService] Vector recall failed; continuing with local channels", error);
            }
        }
    }

    const futureCandidates = memories.filter(entry => (
        entry.kind === "future_intent"
        && ["pending", "overdue"].includes(entry.futureIntent?.status ?? "")
    ));
    for (const entry of futureCandidates) {
        channelCounts.future_intent += 1;
        addCandidate({ memory: entry, source: "future_intent" });
    }

    const recentTopK = Math.max(0, Math.floor(options.recentTopK ?? RECENT_TOP_K));
    const recentCandidates = [...memories]
        .sort((left, right) => {
            const leftDate = Date.parse(left.updatedAt || left.createdAt);
            const rightDate = Date.parse(right.updatedAt || right.createdAt);
            return rightDate - leftDate;
        })
        .slice(0, recentTopK);
    for (const entry of recentCandidates) {
        channelCounts.recent += 1;
        addCandidate({ memory: entry, source: "recent" });
    }

    const rankingOptions: MemoryRankingOptions = {
        now: options.now ?? new Date(),
        timezone: options.timezone,
    };
    const ranked = rankMemoryCandidates([...candidatesById.values()], currentContext, rankingOptions);
    const selectionOptions: RankingSelectionOptions = {
        tokenBudget: options.tokenBudget ?? options.longTermTokenBudget ?? config.longTermTokenBudget,
        maxSelected: options.maxSelected ?? (
            options.maxSelectedLongTermMemories === undefined
                ? config.maxSelectedLongTermMemories
                : undefined
        ),
        maxSelectedLongTermMemories: options.maxSelectedLongTermMemories
            ?? (options.maxSelected === undefined ? config.maxSelectedLongTermMemories : undefined),
        maxProtectedFutureIntents: options.maxProtectedFutureIntents ?? config.maxProtectedFutureIntents,
        maxPerCluster: options.maxPerCluster,
    };
    const selectionTrace = debugEnabled
        ? selectRankedMemoryCandidatesWithTrace(ranked, selectionOptions)
        : undefined;
    const selectedRanked = selectionTrace?.selected ?? selectRankedMemoryCandidates(ranked, selectionOptions);
    const selected = selectedRanked.map(item => item.memory);
    const debug = buildDebugResult({
        mode: "hybrid",
        characterId,
        query: currentContext,
        timestamp: debugTimestamp,
        limits: debugLimits,
        totalMemories: memories.length,
        ranked,
        selectionDecisions: selectionTrace?.decisions,
        selectedIds: selected.map(entry => entry.id),
        selectedCount: selected.length,
        protectedIds: selectedRanked.filter(item => item.protectedReason).map(item => item.memory.id),
        usedTokens: selectedRanked.reduce((total, item) => total + item.tokenCost, 0),
        channelCounts,
        debugEnabled,
        debugCollector: options.debugCollector,
    });
    return {
        selected,
        futureIntents: selected.filter(entry => entry.kind === "future_intent"),
        debug,
    };
}

export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig,
    options: Omit<MemorySelectionOptions, "config"> = {},
): Promise<MemoryEntry[]> {
    return (await selectMemoriesForPrompt(characterId, currentContext, { ...options, config })).selected;
}

export type MemoryRecallCommitOptions = RecallWriteGuard & {
    recalledAt?: string;
    debugCollector?: MemoryRetrievalDebugCollector;
};

/**
 * Persist stats only for IDs that the caller confirmed were injected.
 * Persistence failures are intentionally isolated from the prompt path.
 */
export async function commitMemoryRecall(
    characterId: string,
    memoryIds: readonly string[],
    options: MemoryRecallCommitOptions = {},
): Promise<void> {
    const selectedIds = getRecallMemoryIds(memoryIds, options);
    if (selectedIds.length === 0) return;
    options.debugCollector?.recordInjectedMemoryIds(selectedIds);

    try {
        await updateMemoryRecallStats(
            characterId,
            selectedIds,
            options.recalledAt ?? new Date().toISOString(),
            loadMemoryConfig().memoryStabilityEnabled,
        );
    } catch (error) {
        console.warn("[MemoryService] Recall stats write failed; continuing without blocking prompt", error);
    }
}

/** Build the opt-in callback used after the assembler confirms real injection. */
export function createMemoryRecallCallback(
    characterId: string,
    memoryIds: readonly string[],
    options: MemoryRecallCommitOptions = {},
): (() => void) | undefined {
    const selectedIds = getRecallMemoryIds(memoryIds, {
        ...options,
        injected: options.injected ?? true,
    });
    if (selectedIds.length === 0) return undefined;

    return () => {
        void commitMemoryRecall(characterId, selectedIds, options);
    };
}

type DebugResultInput = {
    mode: MemoryRetrievalDebug["mode"];
    characterId: string;
    query: string;
    timestamp: string;
    limits: MemoryRetrievalDebugLimits;
    totalMemories: number;
    ranked: RankedMemoryCandidate[];
    selectionDecisions?: MemorySelectionDecision[];
    selectedIds: string[];
    selectedCount: number;
    protectedIds: string[];
    usedTokens: number;
    channelCounts: Record<MemoryCandidateSource, number>;
    debugEnabled: boolean;
    debugCollector?: MemoryRetrievalDebugCollector;
};

function buildDebugResult(input: DebugResultInput): MemoryRetrievalDebug {
    const debug: MemoryRetrievalDebug = {
        mode: input.mode,
        totalMemories: input.totalMemories,
        candidateCount: input.ranked.length,
        channelCounts: { ...input.channelCounts },
        selectedCount: input.selectedCount,
        selectedIds: [...input.selectedIds],
        protectedIds: [...input.protectedIds],
        usedTokens: input.usedTokens,
        characterId: input.characterId,
        query: input.query,
        timestamp: input.timestamp,
        limits: { ...input.limits },
        selectedMemoryIds: [...input.selectedIds],
        injectedMemoryIds: [],
    };
    if (input.debugEnabled) {
        const decisions = new Map(
            input.selectionDecisions?.map(decision => [decision.candidate.memory.id, decision]) ?? [],
        );
        debug.candidates = input.ranked.map(candidate => {
            const decision = decisions.get(candidate.memory.id);
            const selected = decision?.selected ?? input.selectedIds.includes(candidate.memory.id);
            return {
                memoryId: candidate.memory.id,
                sourceApp: candidate.memory.sourceApp,
                sources: [...candidate.sources],
                featureScores: { ...candidate.features },
                finalScore: candidate.score,
                tokenCost: candidate.tokenCost,
                ...(candidate.protectedReason ? { protectedReason: candidate.protectedReason } : {}),
                selected,
                ...(selected
                    ? { selectionReason: decision?.reason ?? "ranked" }
                    : { rejectionReason: decision?.reason ?? "lower_rank" }),
            };
        });
    }
    input.debugCollector?.recordRetrieval(debug);
    return debug;
}

function resolveDebugTimestamp(value: Date | string | undefined): string {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
    return Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
}

function resolveDebugLimits(config: MemoryConfig, options: MemorySelectionOptions): MemoryRetrievalDebugLimits {
    return {
        vectorTopK: normalizeDebugLimit(options.vectorTopK, VECTOR_TOP_K),
        keywordTopK: normalizeDebugLimit(options.keywordTopK, KEYWORD_TOP_K),
        recentTopK: normalizeDebugLimit(options.recentTopK, RECENT_TOP_K),
        tokenBudget: options.tokenBudget ?? options.longTermTokenBudget ?? config.longTermTokenBudget,
        maxSelected: options.maxSelectedLongTermMemories
            ?? options.maxSelected
            ?? config.maxSelectedLongTermMemories
            ?? 10,
        maxProtectedFutureIntents: options.maxProtectedFutureIntents ?? config.maxProtectedFutureIntents ?? 3,
        maxPerCluster: options.maxPerCluster ?? 2,
    };
}

function normalizeDebugLimit(value: number | undefined, fallback: number): number {
    return Math.max(0, Math.floor(value ?? fallback));
}

function cloneRetrievalDebug(debug: MemoryRetrievalDebug): MemoryRetrievalDebug {
    return {
        ...debug,
        channelCounts: { ...debug.channelCounts },
        selectedIds: [...debug.selectedIds],
        protectedIds: [...debug.protectedIds],
        limits: { ...debug.limits },
        selectedMemoryIds: [...debug.selectedMemoryIds],
        injectedMemoryIds: [...debug.injectedMemoryIds],
        candidates: debug.candidates?.map(candidate => ({
            ...candidate,
            sources: [...candidate.sources],
            featureScores: { ...candidate.featureScores },
        })),
    };
}

/** Legacy retrieval is intentionally isolated so the feature flag is a true rollback path. */
async function retrieveLegacyMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    const longTermEntries = await loadMemoryEntriesByType(characterId, "long_term");
    if (longTermEntries.length === 0 || !currentContext.trim()) return [];

    const budget = config.longTermTokenBudget;
    const totalTokens = longTermEntries.reduce((total, entry) => total + estimateTokens(entry.content) + 4, 0);
    if (totalTokens <= budget) return longTermEntries;

    const embeddingApiConfig = config.vectorRecallEnabled
        ? resolveAuxiliaryApiConfig("embeddingApiConfigId")
        : null;
    if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
        try {
            const queryEmbedding = await generateEmbedding(currentContext, embeddingApiConfig);
            if (queryEmbedding) {
                const withEmbeddings = longTermEntries.filter(entry => entry.embedding && entry.embedding.length > 0);
                if (withEmbeddings.length > 0) {
                    const scored = withEmbeddings
                        .map(entry => ({ entry, score: cosineSimilarity(queryEmbedding, entry.embedding ?? []) }))
                        .sort((left, right) => right.score - left.score);
                    return fillByBudget(scored.map(item => item.entry), budget);
                }
            }
        } catch (error) {
            console.warn("[MemoryService] Legacy vector recall failed; using recency fallback", error);
        }
    }

    const sorted = [...longTermEntries].sort(
        (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
    );
    return fillByBudget(sorted, budget);
}

export async function retrieveCoreMemoriesForPrompt(
    characterId: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    const coreEntries = await loadMemoryEntriesByType(characterId, "core");
    if (coreEntries.length === 0) return [];

    const sorted = [...coreEntries].sort((left, right) => {
        const leftActive = left.metadata?.active ? 1 : 0;
        const rightActive = right.metadata?.active ? 1 : 0;
        if (leftActive !== rightActive) return rightActive - leftActive;
        const leftDate = String(left.metadata?.eventDate ?? left.updatedAt ?? left.createdAt);
        const rightDate = String(right.metadata?.eventDate ?? right.updatedAt ?? right.createdAt);
        return rightDate.localeCompare(leftDate);
    });

    return fillByBudget(sorted, config.coreMemoryTokenBudget);
}

function fillByBudget(entries: MemoryEntry[], budget: number): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    let used = 0;
    for (const entry of entries) {
        const tokens = estimateTokens(entry.content) + 4;
        if (used + tokens > budget) break;
        result.push(entry);
        used += tokens;
    }
    return result;
}
