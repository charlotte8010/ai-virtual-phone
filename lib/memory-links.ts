import type {
    MemoryEntry,
    MemoryLink,
    MemoryLinkActivationPath,
} from "./memory-types";
import * as memoryStorage from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { cosineSimilarity, generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";

export const MAX_LINK_SEEDS = 4;
export const MAX_LINK_DEPTH = 2;
export const MAX_LINK_NEIGHBORS_PER_SEED = 2;
export const MAX_EXPANDED_MEMORY_LINKS = 16;
export const MAX_LINK_EXPANSION_NODES = 32;
export const MAX_LINKS_PER_MEMORY = 8;
export const MIN_LINK_STRENGTH = 0.25;
export const MIN_LINK_ACTIVATION = 0.1;
export const LINK_DEPTH_DECAY = 0.6;
export const MAX_LINK_GENERATION_CANDIDATES = 8;
export const MAX_GENERATED_LINKS_PER_MEMORY = 2;
export const MIN_SEMANTIC_LINK_SIMILARITY = 0.55;
export const MAX_BACKFILL_BATCH_SIZE = 8;
export const MAX_BACKFILL_NEIGHBORS = 8;

const BACKFILL_VERSION = "c9-memory-links-v1";
const BACKFILL_PROGRESS_PREFIX = "ai_phone_memory_link_backfill_";

export type MemoryLinkGenerationResult = {
    status: "created" | "unchanged" | "skipped" | "failed";
    createdCount: number;
    consideredCount: number;
    reason?: string;
};

export interface MemoryLinkGenerationOptions {
    candidateEntries?: readonly MemoryEntry[];
}

export interface MemoryLinkBackfillOptions {
    batchSize?: number;
    reset?: boolean;
}

export interface MemoryLinkBackfillResult {
    status: "paused" | "complete" | "failed" | "skipped";
    processedCount: number;
    createdCount: number;
    cursor?: string;
    complete: boolean;
}

export type MemoryLinkInput = {
    id?: unknown;
    characterId?: unknown;
    fromMemoryId?: unknown;
    toMemoryId?: unknown;
    type?: unknown;
    strength?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
};

export interface LinkActivationCandidate {
    memoryId: string;
    linkActivationScore: number;
    linkActivationPath: MemoryLinkActivationPath;
    seedMemoryIds: string[];
}

export interface MemoryLinkExpansionLimits {
    maxSeeds: number;
    maxDepth: number;
    neighborsPerSeed: number;
    maxExpanded: number;
    maxExpansionNodes: number;
    minLinkStrength: number;
    minActivation: number;
    depthDecay: number;
}

export interface MemoryLinkExpansion {
    seedMemoryIds: string[];
    candidates: LinkActivationCandidate[];
    limits: MemoryLinkExpansionLimits;
}

function finiteNumber(value: unknown): number | undefined {
    const number = typeof value === "number"
        ? value
        : typeof value === "string" && value.trim()
            ? Number(value)
            : Number.NaN;
    return Number.isFinite(number) ? number : undefined;
}

function normalizeTimestamp(value: unknown, fallback: string): string {
    if (typeof value !== "string") return fallback;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

function nonEmptyString(value: unknown): string | undefined {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function normalizeMemoryLink(input: unknown, now = new Date()): MemoryLink | null {
    if (!input || typeof input !== "object") return null;
    const record = input as MemoryLinkInput;
    const id = nonEmptyString(record.id);
    const characterId = nonEmptyString(record.characterId);
    const fromMemoryId = nonEmptyString(record.fromMemoryId);
    const toMemoryId = nonEmptyString(record.toMemoryId);
    const rawType = nonEmptyString(record.type);
    const type = rawType?.toLocaleLowerCase() === "emotional" ? "emotion" : rawType;
    const rawStrength = finiteNumber(record.strength);
    if (!id || !characterId || !fromMemoryId || !toMemoryId || fromMemoryId === toMemoryId || !type) return null;
    if (rawStrength === undefined || rawStrength < 0) return null;

    const fallbackTimestamp = Number.isFinite(now.getTime()) ? now.toISOString() : new Date(0).toISOString();
    return {
        id,
        characterId,
        fromMemoryId,
        toMemoryId,
        type,
        strength: Math.min(1, Math.max(0, rawStrength)),
        createdAt: normalizeTimestamp(record.createdAt, fallbackTimestamp),
        updatedAt: normalizeTimestamp(record.updatedAt, fallbackTimestamp),
    };
}

function linkKey(link: MemoryLink): string {
    return `${link.characterId}\u0000${link.fromMemoryId}\u0000${link.toMemoryId}\u0000${link.type}`;
}

function compareLinkQuality(left: MemoryLink, right: MemoryLink): number {
    if (right.strength !== left.strength) return right.strength - left.strength;
    return left.id.localeCompare(right.id);
}

export function pruneMemoryLinks(
    links: readonly unknown[],
    maxLinks = MAX_LINKS_PER_MEMORY,
): MemoryLink[] {
    const deduplicated = new Map<string, MemoryLink>();
    for (const input of links) {
        const link = normalizeMemoryLink(input);
        if (!link) continue;
        const previous = deduplicated.get(linkKey(link));
        if (!previous || compareLinkQuality(link, previous) < 0) deduplicated.set(linkKey(link), link);
    }
    return [...deduplicated.values()]
        .sort(compareLinkQuality)
        .slice(0, Math.max(0, Math.floor(maxLinks)));
}

function createLinkId(): string {
    const randomUuid = globalThis.crypto?.randomUUID;
    if (typeof randomUuid === "function") return randomUuid.call(globalThis.crypto);
    return `memory-link-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function createMemoryLink(input: MemoryLinkInput): Promise<MemoryLink | null> {
    const now = new Date();
    const normalized = normalizeMemoryLink({
        ...input,
        id: input.id ?? createLinkId(),
        createdAt: input.createdAt ?? now.toISOString(),
        updatedAt: input.updatedAt ?? now.toISOString(),
    }, now);
    if (!normalized) return null;

    try {
        if (typeof memoryStorage.loadMemoryEntriesByType !== "function") return null;
        const entries = await memoryStorage.loadMemoryEntriesByType(normalized.characterId, "long_term");
        const memoryIds = new Set(
            (Array.isArray(entries) ? entries : [])
                .filter(entry => entry.characterId === normalized.characterId && entry.type === "long_term")
                .map(entry => entry.id),
        );
        if (!memoryIds.has(normalized.fromMemoryId) || !memoryIds.has(normalized.toMemoryId)) return null;
    } catch {
        return null;
    }

    let existing: MemoryLink[] = [];
    try {
        if (typeof memoryStorage.loadMemoryLinks === "function") {
            const loaded = await memoryStorage.loadMemoryLinks(normalized.characterId);
            existing = Array.isArray(loaded) ? loaded : [];
        }
    } catch {
        return null;
    }

    const outgoing = existing.filter(link => link.fromMemoryId === normalized.fromMemoryId);
    const kept = pruneMemoryLinks([...outgoing, normalized], MAX_LINKS_PER_MEMORY);
    const created = kept.find(link => link.id === normalized.id);
    if (!created) return null;

    try {
        if (typeof memoryStorage.saveMemoryLinks === "function") {
            await memoryStorage.saveMemoryLinks(kept);
        } else if (typeof memoryStorage.saveMemoryLink === "function") {
            await memoryStorage.saveMemoryLink(created);
        } else {
            return null;
        }
        const keptIds = new Set(kept.map(link => link.id));
        const staleIds = outgoing
            .filter(link => !keptIds.has(link.id))
            .map(link => link.id);
        if (staleIds.length > 0 && typeof memoryStorage.deleteMemoryLinks === "function") {
            await memoryStorage.deleteMemoryLinks(staleIds);
        }
        return { ...created };
    } catch {
        return null;
    }
}

function hasValidEmbedding(value: unknown): value is number[] {
    return Array.isArray(value)
        && value.length > 0
        && value.every(item => typeof item === "number" && Number.isFinite(item));
}

function memoryDate(memory: MemoryEntry): number {
    const value = Date.parse(memory.updatedAt || memory.createdAt);
    return Number.isFinite(value) ? value : 0;
}

function sortRecentMemories(left: MemoryEntry, right: MemoryEntry): number {
    return memoryDate(right) - memoryDate(left) || left.id.localeCompare(right.id);
}

function getGenerationCandidatePool(
    entry: MemoryEntry,
    candidates: readonly MemoryEntry[],
    embedding: number[],
): MemoryEntry[] {
    const eligible = candidates.filter(candidate => (
        candidate.id !== entry.id
        && candidate.characterId === entry.characterId
        && candidate.type === "long_term"
        && isTraversableMemory(candidate)
    ));
    const recent = [...eligible]
        .sort(sortRecentMemories)
        .slice(0, MAX_LINK_GENERATION_CANDIDATES);
    const semantic = eligible
        .filter(candidate => hasValidEmbedding(candidate.embedding))
        .map(candidate => ({
            candidate,
            score: cosineSimilarity(embedding, candidate.embedding!),
        }))
        .filter(result => Number.isFinite(result.score))
        .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id))
        .slice(0, MAX_LINK_GENERATION_CANDIDATES)
        .map(result => result.candidate);
    const pool = new Map<string, MemoryEntry>();
    for (const candidate of [...semantic, ...recent]) pool.set(candidate.id, candidate);
    return [...pool.values()].slice(0, MAX_LINK_GENERATION_CANDIDATES);
}

async function loadLinkGenerationCandidates(
    entry: MemoryEntry,
    options: MemoryLinkGenerationOptions,
): Promise<MemoryEntry[]> {
    if (options.candidateEntries) {
        return options.candidateEntries
            .filter(candidate => (
                candidate.id !== entry.id
                && candidate.characterId === entry.characterId
                && candidate.type === "long_term"
                && isTraversableMemory(candidate)
            ))
            .slice(0, MAX_LINK_GENERATION_CANDIDATES);
    }
    if (typeof memoryStorage.loadMemoryEntriesByType !== "function") return [];
    const loaded = await memoryStorage.loadMemoryEntriesByType(entry.characterId, "long_term");
    return Array.isArray(loaded) ? loaded : [];
}

function desiredLinkId(fromMemoryId: string, toMemoryId: string): string {
    return `memory-link-topic-${fromMemoryId}-${toMemoryId}`;
}

/**
 * Use embedding similarity as the semantic link judgment. The surrounding
 * code only validates, caps, deduplicates, and persists the result; it does
 * not infer relationships with regexes or block the memory write path.
 */
export async function maybeGenerateMemoryLinksForEntry(
    entry: MemoryEntry,
    options: MemoryLinkGenerationOptions = {},
): Promise<MemoryLinkGenerationResult> {
    if (!entry || entry.type !== "long_term" || !entry.id || !entry.characterId || !isTraversableMemory(entry)) {
        return { status: "skipped", createdCount: 0, consideredCount: 0, reason: "not_long_term" };
    }
    try {
        const config = typeof memoryStorage.loadMemoryConfig === "function"
            ? memoryStorage.loadMemoryConfig()
            : undefined;
        if (config?.memoryLinksEnabled === false) {
            return { status: "skipped", createdCount: 0, consideredCount: 0, reason: "disabled" };
        }

        let embedding = hasValidEmbedding(entry.embedding) ? [...entry.embedding] : undefined;
        if (!embedding) {
            const apiConfig = resolveAuxiliaryApiConfig("embeddingApiConfigId");
            if (!apiConfig || !resolveEmbeddingModel(apiConfig)) {
                return { status: "skipped", createdCount: 0, consideredCount: 0, reason: "no_embedding_model" };
            }
            const generated = await generateEmbedding(entry.content, apiConfig);
            if (!hasValidEmbedding(generated)) {
                return { status: "skipped", createdCount: 0, consideredCount: 0, reason: "no_embedding" };
            }
            embedding = [...generated];
        }

        const loadedCandidates = await loadLinkGenerationCandidates(entry, options);
        const candidatePool = options.candidateEntries
            ? loadedCandidates
            : getGenerationCandidatePool(entry, loadedCandidates, embedding);
        const judgedCandidates = candidatePool
            .map(candidate => ({
                candidate,
                score: cosineSimilarity(embedding, candidate.embedding ?? []),
            }))
            .filter(result => Number.isFinite(result.score) && result.score >= MIN_SEMANTIC_LINK_SIMILARITY)
            .sort((left, right) => right.score - left.score || left.candidate.id.localeCompare(right.candidate.id))
            .slice(0, MAX_GENERATED_LINKS_PER_MEMORY);
        if (judgedCandidates.length === 0) {
            return { status: "skipped", createdCount: 0, consideredCount: candidatePool.length, reason: "no_semantic_match" };
        }

        let existing: MemoryLink[] = [];
        if (typeof memoryStorage.loadMemoryLinks === "function") {
            const loadedLinks = await memoryStorage.loadMemoryLinks(entry.characterId);
            existing = Array.isArray(loadedLinks)
                ? loadedLinks.map(link => normalizeMemoryLink(link)).filter((link): link is MemoryLink => Boolean(link))
                : [];
        }
        const existingByKey = new Map(existing.map(link => [linkKey(link), link]));
        let createdCount = 0;
        let satisfiedRelationCount = 0;
        const relationCount = judgedCandidates.length * 2;
        for (const { candidate, score } of judgedCandidates) {
            for (const [fromMemoryId, toMemoryId] of [
                [entry.id, candidate.id],
                [candidate.id, entry.id],
            ]) {
                const key = linkKey({
                    id: desiredLinkId(fromMemoryId, toMemoryId),
                    characterId: entry.characterId,
                    fromMemoryId,
                    toMemoryId,
                    type: "topic",
                    strength: score,
                    createdAt: entry.createdAt,
                    updatedAt: entry.updatedAt,
                });
                const current = existingByKey.get(key);
                if (current && current.strength >= score) {
                    satisfiedRelationCount += 1;
                    continue;
                }
                const created = await createMemoryLink({
                    id: desiredLinkId(fromMemoryId, toMemoryId),
                    characterId: entry.characterId,
                    fromMemoryId,
                    toMemoryId,
                    type: "topic",
                    strength: score,
                    createdAt: entry.createdAt,
                    updatedAt: entry.updatedAt,
                });
                if (created) {
                    createdCount += 1;
                    satisfiedRelationCount += 1;
                    existingByKey.set(key, created);
                }
            }
        }
        if (satisfiedRelationCount < relationCount) {
            return { status: "failed", createdCount, consideredCount: candidatePool.length, reason: "link_write_failed" };
        }
        return createdCount > 0
            ? { status: "created", createdCount, consideredCount: candidatePool.length }
            : { status: "unchanged", createdCount: 0, consideredCount: candidatePool.length };
    } catch (error) {
        console.warn("[MemoryLinks] Link generation failed; memory remains available", error);
        return { status: "failed", createdCount: 0, consideredCount: 0, reason: "generation_failed" };
    }
}

const scheduledGeneration = new Map<string, Promise<MemoryLinkGenerationResult>>();

/** Fire-and-forget hook for successful long-term memory writes. */
export function scheduleMemoryLinkGenerationForEntry(entry: MemoryEntry): void {
    if (entry.type !== "long_term") return;
    const key = `${entry.characterId}\u0000${entry.id}`;
    if (scheduledGeneration.has(key)) return;
    const task = maybeGenerateMemoryLinksForEntry(entry)
        .catch(() => ({ status: "failed", createdCount: 0, consideredCount: 0 } as MemoryLinkGenerationResult))
        .finally(() => scheduledGeneration.delete(key));
    scheduledGeneration.set(key, task);
}

type BackfillProgress = {
    version: string;
    cursor?: string;
    complete: boolean;
};

function backfillProgressKey(characterId: string): string {
    return `${BACKFILL_PROGRESS_PREFIX}${encodeURIComponent(characterId)}`;
}

function readBackfillProgress(characterId: string): BackfillProgress | undefined {
    if (typeof window === "undefined") return undefined;
    try {
        const raw = window.localStorage.getItem(backfillProgressKey(characterId));
        if (!raw) return undefined;
        const parsed = JSON.parse(raw) as Partial<BackfillProgress>;
        return parsed.version === BACKFILL_VERSION && typeof parsed.complete === "boolean"
            ? { version: BACKFILL_VERSION, cursor: parsed.cursor, complete: parsed.complete }
            : undefined;
    } catch {
        return undefined;
    }
}

function writeBackfillProgress(characterId: string, progress: BackfillProgress): boolean {
    if (typeof window === "undefined") return false;
    try {
        window.localStorage.setItem(backfillProgressKey(characterId), JSON.stringify(progress));
        return true;
    } catch {
        return false;
    }
}

function getBackfillCandidates(entries: readonly MemoryEntry[], index: number): MemoryEntry[] {
    const start = Math.max(0, index - MAX_BACKFILL_NEIGHBORS);
    const end = Math.min(entries.length, index + MAX_BACKFILL_NEIGHBORS + 1);
    return entries.slice(start, end).filter((_, candidateIndex) => start + candidateIndex !== index);
}

/** Process a bounded, cursor-backed, idempotent batch of existing memories. */
export async function runMemoryLinkBackfill(
    characterId: string,
    options: MemoryLinkBackfillOptions = {},
): Promise<MemoryLinkBackfillResult> {
    if (typeof window === "undefined" || !characterId) {
        return { status: "skipped", processedCount: 0, createdCount: 0, complete: false };
    }
    try {
        const config = typeof memoryStorage.loadMemoryConfig === "function"
            ? memoryStorage.loadMemoryConfig()
            : undefined;
        if (config?.memoryLinksEnabled === false) {
            return { status: "skipped", processedCount: 0, createdCount: 0, complete: false };
        }
        if (options.reset) window.localStorage.removeItem(backfillProgressKey(characterId));
        const progress = readBackfillProgress(characterId);
        if (progress?.complete) {
            return { status: "complete", processedCount: 0, createdCount: 0, cursor: progress.cursor, complete: true };
        }
        if (typeof memoryStorage.loadMemoryEntriesByType !== "function") {
            return { status: "failed", processedCount: 0, createdCount: 0, complete: false };
        }
        const loaded = await memoryStorage.loadMemoryEntriesByType(characterId, "long_term");
        const entries = (Array.isArray(loaded) ? loaded : [])
            .filter(entry => entry.characterId === characterId && entry.type === "long_term")
            .sort((left, right) => left.id.localeCompare(right.id));
        if (entries.length === 0) {
            const complete = writeBackfillProgress(characterId, { version: BACKFILL_VERSION, complete: true });
            return complete
                ? { status: "complete", processedCount: 0, createdCount: 0, complete: true }
                : { status: "failed", processedCount: 0, createdCount: 0, complete: false };
        }

        const cursorIndex = progress?.cursor
            ? entries.findIndex(entry => entry.id > progress.cursor!)
            : 0;
        const startIndex = cursorIndex < 0 ? entries.length : cursorIndex;
        const batchSize = Math.min(
            MAX_BACKFILL_BATCH_SIZE,
            Math.max(1, Math.floor(options.batchSize ?? MAX_BACKFILL_BATCH_SIZE)),
        );
        let processedCount = 0;
        let createdCount = 0;
        let cursor = progress?.cursor;
        for (let index = startIndex; index < Math.min(entries.length, startIndex + batchSize); index += 1) {
            const entry = entries[index];
            const result = await maybeGenerateMemoryLinksForEntry(entry, {
                candidateEntries: getBackfillCandidates(entries, index),
            });
            if (result.status === "failed") {
                return { status: "failed", processedCount, createdCount, cursor, complete: false };
            }
            processedCount += 1;
            createdCount += result.createdCount;
            cursor = entry.id;
            if (!writeBackfillProgress(characterId, { version: BACKFILL_VERSION, cursor, complete: false })) {
                return { status: "failed", processedCount, createdCount, cursor: progress?.cursor, complete: false };
            }
        }
        const complete = startIndex + processedCount >= entries.length;
        if (!writeBackfillProgress(characterId, { version: BACKFILL_VERSION, cursor, complete })) {
            return { status: "failed", processedCount, createdCount, cursor: progress?.cursor, complete: false };
        }
        return {
            status: complete ? "complete" : "paused",
            processedCount,
            createdCount,
            cursor,
            complete,
        };
    } catch (error) {
        console.warn("[MemoryLinks] Backfill failed; progress remains resumable", error);
        return { status: "failed", processedCount: 0, createdCount: 0, complete: false };
    }
}

const scheduledBackfills = new Map<string, Promise<MemoryLinkBackfillResult>>();

/** Start one bounded lazy backfill batch without delaying the caller. */
export function scheduleMemoryLinkBackfillForCharacter(characterId: string): void {
    if (!characterId || scheduledBackfills.has(characterId)) return;
    const task = runMemoryLinkBackfill(characterId)
        .catch(() => ({ status: "failed", processedCount: 0, createdCount: 0, complete: false } as MemoryLinkBackfillResult))
        .finally(() => scheduledBackfills.delete(characterId));
    scheduledBackfills.set(characterId, task);
}

function isTraversableMemory(memory: MemoryEntry | undefined): memory is MemoryEntry {
    if (!memory || memory.type !== "long_term") return false;
    if (memory.kind !== "future_intent" && !memory.futureIntent) return true;
    return ["pending", "overdue"].includes(memory.futureIntent?.status ?? "");
}

function pathKey(path: MemoryLinkActivationPath): string {
    return [
        path.seedMemoryIds.join(","),
        path.memoryIds.join(">"),
        path.linkIds.join(">"),
    ].join("|");
}

function compareActivationPaths(left: MemoryLinkActivationPath, right: MemoryLinkActivationPath): number {
    if (right.activation !== left.activation) return right.activation - left.activation;
    if (left.depth !== right.depth) return left.depth - right.depth;
    return pathKey(left).localeCompare(pathKey(right));
}

function safeExpansion(): MemoryLinkExpansion {
    return {
        seedMemoryIds: [],
        candidates: [],
        limits: {
            maxSeeds: MAX_LINK_SEEDS,
            maxDepth: MAX_LINK_DEPTH,
            neighborsPerSeed: MAX_LINK_NEIGHBORS_PER_SEED,
            maxExpanded: MAX_EXPANDED_MEMORY_LINKS,
            maxExpansionNodes: MAX_LINK_EXPANSION_NODES,
            minLinkStrength: MIN_LINK_STRENGTH,
            minActivation: MIN_LINK_ACTIVATION,
            depthDecay: LINK_DEPTH_DECAY,
        },
    };
}

export async function spreadMemoryActivation(
    characterId: string,
    seedMemoryIds: readonly string[],
    memories: readonly MemoryEntry[],
): Promise<MemoryLinkExpansion> {
    const limits = safeExpansion().limits;
    if (typeof characterId !== "string" || characterId.trim().length === 0) return safeExpansion();
    if (!Array.isArray(memories) || !Array.isArray(seedMemoryIds)) return safeExpansion();
    const memoryById = new Map(
        memories
            .filter(memory => memory.characterId === characterId)
            .map(memory => [memory.id, memory]),
    );
    const seeds = [...new Set(seedMemoryIds)]
        .filter(memoryId => isTraversableMemory(memoryById.get(memoryId)))
        .sort()
        .slice(0, limits.maxSeeds);
    if (seeds.length === 0) return { ...safeExpansion(), seedMemoryIds: [] };

    let loadedLinks: unknown[] = [];
    try {
        if (typeof memoryStorage.loadMemoryLinks !== "function") {
            return { ...safeExpansion(), seedMemoryIds: seeds };
        }
        const result = await memoryStorage.loadMemoryLinks(characterId);
        loadedLinks = Array.isArray(result) ? result : [];
    } catch {
        return { ...safeExpansion(), seedMemoryIds: seeds };
    }

    const deduplicatedLinks = new Map<string, MemoryLink>();
    for (const input of loadedLinks) {
        const link = normalizeMemoryLink(input);
        if (!link || link.characterId !== characterId || link.strength < limits.minLinkStrength) continue;
        if (!memoryById.has(link.fromMemoryId) || !isTraversableMemory(memoryById.get(link.toMemoryId))) continue;
        const previous = deduplicatedLinks.get(linkKey(link));
        if (!previous || compareLinkQuality(link, previous) < 0) deduplicatedLinks.set(linkKey(link), link);
    }

    const outgoing = new Map<string, MemoryLink[]>();
    for (const link of deduplicatedLinks.values()) {
        const current = outgoing.get(link.fromMemoryId) ?? [];
        outgoing.set(link.fromMemoryId, [...current, link]);
    }
    for (const [memoryId, links] of outgoing) {
        outgoing.set(memoryId, [...links].sort((left, right) => (
            compareLinkQuality(left, right) || left.toMemoryId.localeCompare(right.toMemoryId)
        )));
    }

    type TraversalState = {
        seedMemoryId: string;
        memoryId: string;
        depth: number;
        activation: number;
        memoryIds: string[];
        linkIds: string[];
    };
    const bestBySeedAndMemory = new Map<string, MemoryLinkActivationPath>();
    const candidatesByMemory = new Map<string, LinkActivationCandidate>();
    const queue: TraversalState[] = seeds.map(seedMemoryId => ({
        seedMemoryId,
        memoryId: seedMemoryId,
        depth: 0,
        activation: 1,
        memoryIds: [seedMemoryId],
        linkIds: [],
    }));
    let expansionNodes = 0;

    while (queue.length > 0 && expansionNodes < limits.maxExpansionNodes) {
        const state = queue.shift();
        if (!state) break;
        expansionNodes += 1;
        if (state.depth >= limits.maxDepth) continue;
        const links = (outgoing.get(state.memoryId) ?? []).slice(0, limits.neighborsPerSeed);
        for (const link of links) {
            const nextDepth = state.depth + 1;
            const decay = limits.depthDecay ** Math.max(0, nextDepth - 1);
            const nextActivation = state.activation * link.strength * decay;
            if (!Number.isFinite(nextActivation) || nextActivation < limits.minActivation) continue;
            if (state.memoryIds.includes(link.toMemoryId)) continue;
            const nextPath: MemoryLinkActivationPath = {
                seedMemoryIds: [state.seedMemoryId],
                seedMemoryId: state.seedMemoryId,
                depth: nextDepth,
                activation: nextActivation,
                memoryIds: [...state.memoryIds, link.toMemoryId],
                linkIds: [...state.linkIds, link.id],
            };
            const pathMapKey = `${state.seedMemoryId}\u0000${link.toMemoryId}`;
            const previousPath = bestBySeedAndMemory.get(pathMapKey);
            if (previousPath && compareActivationPaths(nextPath, previousPath) >= 0) continue;
            bestBySeedAndMemory.set(pathMapKey, nextPath);
            queue.push({
                seedMemoryId: state.seedMemoryId,
                memoryId: link.toMemoryId,
                depth: nextDepth,
                activation: nextActivation,
                memoryIds: nextPath.memoryIds,
                linkIds: nextPath.linkIds,
            });

            const previousCandidate = candidatesByMemory.get(link.toMemoryId);
            const seedMemoryIds = [...new Set([
                ...(previousCandidate?.seedMemoryIds ?? []),
                state.seedMemoryId,
            ])].sort();
            if (!previousCandidate || compareActivationPaths(nextPath, previousCandidate.linkActivationPath) < 0) {
                candidatesByMemory.set(link.toMemoryId, {
                    memoryId: link.toMemoryId,
                    linkActivationScore: nextActivation,
                    linkActivationPath: {
                        ...nextPath,
                        seedMemoryIds: [...seedMemoryIds],
                    },
                    seedMemoryIds,
                });
            } else {
                candidatesByMemory.set(link.toMemoryId, {
                    ...previousCandidate,
                    seedMemoryIds,
                    linkActivationPath: {
                        ...previousCandidate.linkActivationPath,
                        seedMemoryIds: [...seedMemoryIds],
                    },
                });
            }
        }
    }

    const candidates = [...candidatesByMemory.values()]
        .sort((left, right) => (
            right.linkActivationScore - left.linkActivationScore
            || left.linkActivationPath.depth - right.linkActivationPath.depth
            || pathKey(left.linkActivationPath).localeCompare(pathKey(right.linkActivationPath))
            || left.memoryId.localeCompare(right.memoryId)
        ))
        .slice(0, limits.maxExpanded)
        .map(candidate => ({
            ...candidate,
            seedMemoryIds: [...candidate.seedMemoryIds],
            linkActivationPath: {
                ...candidate.linkActivationPath,
                seedMemoryIds: [...candidate.linkActivationPath.seedMemoryIds],
                memoryIds: [...candidate.linkActivationPath.memoryIds],
                linkIds: [...candidate.linkActivationPath.linkIds],
            },
        }));
    return { seedMemoryIds: [...seeds], candidates, limits };
}
