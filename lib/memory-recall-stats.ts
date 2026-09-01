// Pure recall-stat calculations for the cognitive memory layer.

import type { MemoryEntry } from "./memory-types";
import { getInitialStability } from "./memory-compat";

const MIN_STABILITY = 0;
const MAX_STABILITY = 1;

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function normalizeAccessCount(value: number | undefined): number {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.floor(value as number));
}

/** Small, bounded v1 boost; higher access counts have diminishing returns. */
export function getRecallStabilityBoost(accessCount: number): number {
    if (accessCount <= 1) return 0.02;
    if (accessCount <= 3) return 0.03;
    if (accessCount <= 10) return 0.015;
    return 0.005;
}

/** Apply one successful prompt recall without changing memory chronology or lifecycle. */
export function applyRecallStats(memory: MemoryEntry, recalledAt: string): MemoryEntry {
    const accessCount = normalizeAccessCount(memory.accessCount) + 1;
    const currentStability = Number.isFinite(memory.stability)
        ? clamp(memory.stability as number, MIN_STABILITY, MAX_STABILITY)
        : getInitialStability(memory);

    return {
        ...memory,
        accessCount,
        lastAccessedAt: recalledAt,
        stability: clamp(
            currentStability + getRecallStabilityBoost(accessCount),
            MIN_STABILITY,
            MAX_STABILITY,
        ),
    };
}

export type RecallWriteGuard = {
    recordRecall?: boolean;
    enabled?: boolean;
    injected?: boolean;
    dryRun?: boolean;
    debugPreview?: boolean;
    migrationRestore?: boolean;
};

/** Resolve the only IDs allowed to reach the stats write-back layer. */
export function getRecallMemoryIds(
    memoryIds: readonly string[],
    guard: RecallWriteGuard = {},
): string[] {
    if (
        guard.recordRecall === false
        || guard.enabled === false
        || guard.injected === false
        || guard.dryRun === true
        || guard.debugPreview === true
        || guard.migrationRestore === true
    ) {
        return [];
    }

    return [...new Set(memoryIds.filter(id => typeof id === "string" && id.trim().length > 0))];
}
