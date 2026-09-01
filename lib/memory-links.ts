import type {
    MemoryEntry,
    MemoryLink,
    MemoryLinkActivationPath,
    MemoryLinkType,
} from "./memory-types";
import * as memoryStorage from "./memory-storage";

export const MAX_LINK_SEEDS = 4;
export const MAX_LINK_DEPTH = 2;
export const MAX_LINK_NEIGHBORS_PER_SEED = 2;
export const MAX_EXPANDED_MEMORY_LINKS = 16;
export const MAX_LINK_EXPANSION_NODES = 32;
export const MAX_LINKS_PER_MEMORY = 8;
export const MIN_LINK_STRENGTH = 0.25;
export const MIN_LINK_ACTIVATION = 0.1;
export const LINK_DEPTH_DECAY = 0.6;

const LINK_TYPES = new Set<MemoryLinkType>([
    "temporal",
    "emotion",
    "person",
    "topic",
    "causal",
    "metaphor",
]);

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
    const type = typeof record.type === "string" && LINK_TYPES.has(record.type as MemoryLinkType)
        ? record.type as MemoryLinkType
        : undefined;
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
