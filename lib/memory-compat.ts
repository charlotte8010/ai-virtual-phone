// lib/memory-compat.ts
// Read-time normalization for legacy and partially populated memory records.
// This module is intentionally pure so it can be used by storage and tests.

import type { MemoryEntry } from "./memory-types";

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

export function getInitialStability(memory: Pick<MemoryEntry, "type" | "importance">): number {
    if (memory.type === "core") return 0.95;

    return clamp(0.35 + memory.importance * 0.4, 0, 1);
}

export function normalizeMemoryEntry(memory: MemoryEntry): MemoryEntry {
    return {
        ...memory,
        tags: Array.isArray(memory.tags) ? [...memory.tags] : [],
        kind: memory.kind ?? "event",
        accessCount: Number.isFinite(memory.accessCount) ? memory.accessCount : 0,
        stability: Number.isFinite(memory.stability)
            ? memory.stability
            : getInitialStability(memory),
    };
}
