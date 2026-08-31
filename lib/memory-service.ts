// High-level memory orchestration: candidate generation, ranking, and prompt selection.

import type { MemoryConfig, MemoryEntry } from "./memory-types";
import { loadMemoryConfig, loadMemoryEntriesByType } from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { generateEmbedding, resolveEmbeddingModel, cosineSimilarity } from "./memory-embedding";
import { estimateTokens } from "./token-counter";
import { searchMemoryText } from "./memory-text-search";
import {
    rankMemoryCandidates,
    selectRankedMemoryCandidates,
    type MemoryCandidate,
    type MemoryCandidateSource,
    type MemoryRankingOptions,
    type MemorySelectionOptions as RankingSelectionOptions,
} from "./memory-ranking";

const VECTOR_TOP_K = 20;
const KEYWORD_TOP_K = 20;
const RECENT_TOP_K = 10;

export interface MemorySelectionOptions extends MemoryRankingOptions, RankingSelectionOptions {
    config?: MemoryConfig;
    vectorTopK?: number;
    keywordTopK?: number;
    recentTopK?: number;
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
}

export interface MemorySelectionResult {
    selected: MemoryEntry[];
    futureIntents: MemoryEntry[];
    debug?: MemoryRetrievalDebug;
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
    if (!shouldUseCognitiveRetrieval(config)) {
        const selected = await retrieveLegacyMemoriesForPrompt(characterId, currentContext, config);
        return {
            selected,
            futureIntents: selected.filter(entry => entry.kind === "future_intent"),
            debug: {
                mode: "legacy",
                totalMemories: selected.length,
                candidateCount: selected.length,
                channelCounts: { vector: 0, keyword: 0, future_intent: 0, recent: 0 },
                selectedCount: selected.length,
                selectedIds: selected.map(entry => entry.id),
                protectedIds: [],
                usedTokens: selected.reduce((total, entry) => total + estimateTokens(entry.content) + 4, 0),
            },
        };
    }

    const memories = await loadMemoryEntriesByType(characterId, "long_term");
    if (memories.length === 0 || !currentContext.trim()) {
        return {
            selected: [],
            futureIntents: [],
            debug: {
                mode: "hybrid",
                totalMemories: memories.length,
                candidateCount: 0,
                channelCounts: { vector: 0, keyword: 0, future_intent: 0, recent: 0 },
                selectedCount: 0,
                selectedIds: [],
                protectedIds: [],
                usedTokens: 0,
            },
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
    const selectedRanked = selectRankedMemoryCandidates(ranked, {
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
    });
    const selected = selectedRanked.map(item => item.memory);
    return {
        selected,
        futureIntents: selected.filter(entry => entry.kind === "future_intent"),
        debug: {
            mode: "hybrid",
            totalMemories: memories.length,
            candidateCount: ranked.length,
            channelCounts,
            selectedCount: selected.length,
            selectedIds: selected.map(entry => entry.id),
            protectedIds: selectedRanked.filter(item => item.protectedReason).map(item => item.memory.id),
            usedTokens: selectedRanked.reduce((total, item) => total + item.tokenCost, 0),
        },
    };
}

export async function retrieveMemoriesForPrompt(
    characterId: string,
    currentContext: string,
    config: MemoryConfig,
): Promise<MemoryEntry[]> {
    return (await selectMemoriesForPrompt(characterId, currentContext, { config })).selected;
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
