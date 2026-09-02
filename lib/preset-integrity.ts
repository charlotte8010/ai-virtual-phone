import type { PresetConfig, Prompt, PromptOrderEntry } from "./settings-types";

export type PresetPromptIntegrityStats = {
    droppedExactPromptDuplicates: number;
    renamedPromptIdentifiers: number;
    removedDuplicateOrderEntries: number;
    removedStaleOrderEntries: number;
    appendedMissingOrderEntries: number;
};

export type PresetPromptIntegrityResult = {
    preset: PresetConfig;
    changed: boolean;
    stats: PresetPromptIntegrityStats;
};

export type PresetCollectionIntegrityResult = {
    presets: PresetConfig[];
    changed: boolean;
    repairedPresetCount: number;
    stats: PresetPromptIntegrityStats;
};

function emptyStats(): PresetPromptIntegrityStats {
    return {
        droppedExactPromptDuplicates: 0,
        renamedPromptIdentifiers: 0,
        removedDuplicateOrderEntries: 0,
        removedStaleOrderEntries: 0,
        appendedMissingOrderEntries: 0,
    };
}

function mergeStats(target: PresetPromptIntegrityStats, source: PresetPromptIntegrityStats): void {
    target.droppedExactPromptDuplicates += source.droppedExactPromptDuplicates;
    target.renamedPromptIdentifiers += source.renamedPromptIdentifiers;
    target.removedDuplicateOrderEntries += source.removedDuplicateOrderEntries;
    target.removedStaleOrderEntries += source.removedStaleOrderEntries;
    target.appendedMissingOrderEntries += source.appendedMissingOrderEntries;
}

function stableJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableJsonValue);
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
        Object.keys(record)
            .sort()
            .map(key => [key, stableJsonValue(record[key])]),
    );
}

function promptFingerprint(prompt: Prompt): string {
    const { identifier: _identifier, ...rest } = prompt;
    return JSON.stringify(stableJsonValue(rest));
}

function normalizeIdentifier(value: unknown, index: number): string {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed || `prompt_${index + 1}`;
}

function allocateUniqueIdentifier(base: string, used: Set<string>, reserved: Set<string>): string {
    if (!used.has(base)) return base;
    let suffix = 2;
    let candidate = `${base}__${suffix}`;
    while (used.has(candidate) || reserved.has(candidate)) {
        suffix += 1;
        candidate = `${base}__${suffix}`;
    }
    return candidate;
}

/**
 * Repairs preset prompt identity without throwing away distinct user content.
 *
 * Rules:
 * - exact duplicate prompts with the same original identifier collapse to one;
 * - distinct prompts that share an identifier are preserved and later copies are renamed;
 * - original identifiers that already exist elsewhere are reserved before duplicate renaming;
 * - duplicate/stale prompt_order entries are removed;
 * - prompt_order is completed so every surviving prompt appears exactly once.
 *
 * This is deliberately deterministic so opening the editor a second time is idempotent.
 */
export function repairPresetPromptIntegrity(input: PresetConfig): PresetPromptIntegrityResult {
    const stats = emptyStats();
    const sourcePrompts = Array.isArray(input.prompts) ? input.prompts : [];
    const reservedOriginalIdentifiers = new Set(
        sourcePrompts.map((prompt, index) => normalizeIdentifier(prompt.identifier, index)),
    );
    const usedIdentifiers = new Set<string>();
    const aliasesByOriginal = new Map<string, string[]>();
    const fingerprintIdsByOriginal = new Map<string, Map<string, string>>();
    const prompts: Prompt[] = [];

    sourcePrompts.forEach((sourcePrompt, index) => {
        const originalIdentifier = normalizeIdentifier(sourcePrompt.identifier, index);
        const fingerprint = promptFingerprint(sourcePrompt);
        let fingerprints = fingerprintIdsByOriginal.get(originalIdentifier);
        if (!fingerprints) {
            fingerprints = new Map<string, string>();
            fingerprintIdsByOriginal.set(originalIdentifier, fingerprints);
        }

        const exactExistingId = fingerprints.get(fingerprint);
        if (exactExistingId) {
            stats.droppedExactPromptDuplicates += 1;
            return;
        }

        const identifier = allocateUniqueIdentifier(
            originalIdentifier,
            usedIdentifiers,
            reservedOriginalIdentifiers,
        );
        if (identifier !== originalIdentifier) stats.renamedPromptIdentifiers += 1;
        usedIdentifiers.add(identifier);
        fingerprints.set(fingerprint, identifier);

        const aliases = aliasesByOriginal.get(originalIdentifier) ?? [];
        aliases.push(identifier);
        aliasesByOriginal.set(originalIdentifier, aliases);
        prompts.push({ ...sourcePrompt, identifier });
    });

    const promptById = new Map(prompts.map(prompt => [prompt.identifier, prompt]));
    const order: PromptOrderEntry[] = [];
    const orderedIds = new Set<string>();
    const aliasCursor = new Map<string, number>();

    for (const sourceEntry of input.prompt_order ?? []) {
        const originalIdentifier = typeof sourceEntry?.identifier === "string"
            ? sourceEntry.identifier.trim()
            : "";
        const aliases = aliasesByOriginal.get(originalIdentifier);
        if (!aliases || aliases.length === 0) {
            stats.removedStaleOrderEntries += 1;
            continue;
        }

        const cursor = aliasCursor.get(originalIdentifier) ?? 0;
        const resolvedIdentifier = aliases[Math.min(cursor, aliases.length - 1)];
        aliasCursor.set(originalIdentifier, cursor + 1);

        if (orderedIds.has(resolvedIdentifier)) {
            stats.removedDuplicateOrderEntries += 1;
            continue;
        }
        orderedIds.add(resolvedIdentifier);
        order.push({
            identifier: resolvedIdentifier,
            enabled: sourceEntry.enabled !== false,
        });
    }

    for (const prompt of prompts) {
        if (orderedIds.has(prompt.identifier)) continue;
        orderedIds.add(prompt.identifier);
        stats.appendedMissingOrderEntries += 1;
        order.push({
            identifier: prompt.identifier,
            enabled: promptById.get(prompt.identifier)?.enabled !== false,
        });
    }

    const preset: PresetConfig = {
        ...input,
        prompts,
        prompt_order: order,
    };
    const changed = JSON.stringify(input.prompts ?? []) !== JSON.stringify(prompts)
        || JSON.stringify(input.prompt_order ?? []) !== JSON.stringify(order);

    return { preset, changed, stats };
}

export function repairPresetCollectionIntegrity(inputs: PresetConfig[]): PresetCollectionIntegrityResult {
    const stats = emptyStats();
    let changed = false;
    let repairedPresetCount = 0;
    const presets = inputs.map(input => {
        const result = repairPresetPromptIntegrity(input);
        mergeStats(stats, result.stats);
        if (result.changed) {
            changed = true;
            repairedPresetCount += 1;
        }
        return result.preset;
    });

    return { presets, changed, repairedPresetCount, stats };
}
