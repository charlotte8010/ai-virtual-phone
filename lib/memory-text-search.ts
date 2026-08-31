// Lightweight local text search for Cognitive Retrieval v1.
// This intentionally avoids an IndexedDB index or a full BM25 implementation;
// a few hundred memories can be scored cheaply in memory.

import type { MemoryEntry, MemorySearchResult } from "./memory-types";

export interface MemoryTextSearchResult extends MemorySearchResult {
    keywordScore: number;
    tagScore: number;
    matchedTokens: string[];
}

function normalizeText(text: string): string {
    return String(text ?? "").normalize("NFKC").toLocaleLowerCase();
}

/** Exported for tests and future BM25/tokenizer upgrades. */
export function extractMemorySearchTokens(text: string): string[] {
    const normalized = normalizeText(text);
    const latinWords = normalized.match(/[a-z0-9]+/g) ?? [];
    const cjkSegments = normalized.match(/[\u2E80-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]+/g) ?? [];
    const cjkTokens: string[] = [];
    for (const segment of cjkSegments) {
        if (segment.length === 1) {
            cjkTokens.push(segment);
            continue;
        }
        for (let index = 0; index < segment.length - 1; index += 1) {
            cjkTokens.push(segment.slice(index, index + 2));
        }
    }
    return [...new Set([...latinWords, ...cjkTokens])];
}

function tokenMatches(queryToken: string, entryToken: string): boolean {
    return queryToken === entryToken
        || queryToken.includes(entryToken)
        || entryToken.includes(queryToken);
}

function scoreTokenOverlap(queryTokens: string[], entryTokens: string[]): { score: number; matched: string[] } {
    if (queryTokens.length === 0 || entryTokens.length === 0) return { score: 0, matched: [] };
    const matched = queryTokens.filter(queryToken => entryTokens.some(entryToken => tokenMatches(queryToken, entryToken)));
    return {
        score: matched.length / queryTokens.length,
        matched,
    };
}

export function calculateMemoryKeywordScore(query: string, content: string): number {
    return scoreTokenOverlap(extractMemorySearchTokens(query), extractMemorySearchTokens(content)).score;
}

export function calculateMemoryTagScore(query: string, tags: string[] | undefined): number {
    return scoreTokenOverlap(extractMemorySearchTokens(query), extractMemorySearchTokens((tags ?? []).join(" "))).score;
}

/** Return normalized local text matches, including tag overlap for ranking. */
export function searchMemoryText(
    query: string,
    memories: MemoryEntry[],
    topK: number,
): MemoryTextSearchResult[] {
    const queryTokens = extractMemorySearchTokens(query);
    if (queryTokens.length === 0 || topK <= 0) return [];

    const results = memories.map((entry): MemoryTextSearchResult => {
        const contentOverlap = scoreTokenOverlap(queryTokens, extractMemorySearchTokens(entry.content));
        const tagOverlap = scoreTokenOverlap(queryTokens, extractMemorySearchTokens((entry.tags ?? []).join(" ")));
        const keywordScore = contentOverlap.score;
        const tagScore = tagOverlap.score;
        return {
            entry,
            score: keywordScore * 0.7 + tagScore * 0.3,
            keywordScore,
            tagScore,
            matchedTokens: [...new Set([...contentOverlap.matched, ...tagOverlap.matched])],
        };
    }).filter(result => result.score > 0);

    results.sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        if (right.tagScore !== left.tagScore) return right.tagScore - left.tagScore;
        return right.entry.updatedAt.localeCompare(left.entry.updatedAt);
    });
    return results.slice(0, Math.max(0, Math.floor(topK)));
}

/** Compatibility alias for callers that use the channel name. */
export const searchMemoriesByText = searchMemoryText;

export function keywordSearch(
    query: string,
    memories: MemoryEntry[],
    topK: number,
): MemorySearchResult[] {
    return searchMemoryText(query, memories, topK).map(({ entry, score }) => ({ entry, score }));
}
