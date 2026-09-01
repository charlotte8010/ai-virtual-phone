import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { createContext, SourceTextModule } from "node:vm";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const context = createContext({ console, setTimeout });
context.__testMemories = [];
context.__testConfig = null;
context.__recallWrites = [];
context.__failRecallWrites = false;

const mockSources = new Map([
    [resolve(repoRoot, "lib/memory-storage.ts"), `
        export function loadMemoryConfig() { return globalThis.__testConfig; }
        export async function loadMemoryEntriesByType(characterId, type) {
            return globalThis.__testMemories.filter(entry => entry.characterId === characterId && entry.type === type);
        }
        export async function updateMemoryRecallStats(characterId, memoryIds, recalledAt, memoryStabilityEnabled) {
            globalThis.__recallWrites.push({ characterId, memoryIds: [...memoryIds], recalledAt, memoryStabilityEnabled });
            if (globalThis.__failRecallWrites) throw new Error("simulated IndexedDB failure");
        }
    `],
    [resolve(repoRoot, "lib/settings-storage.ts"), `
        export function resolveAuxiliaryApiConfig() { return null; }
    `],
    [resolve(repoRoot, "lib/memory-embedding.ts"), `
        export function resolveEmbeddingModel() { return null; }
        export async function generateEmbedding() { return null; }
        export function cosineSimilarity() { return 0; }
    `],
]);

const moduleCache = new Map();

function sourceModulePath(specifier, referencingModule) {
    const basePath = resolve(dirname(referencingModule.identifier), specifier);
    if (extname(basePath)) return basePath;
    return `${basePath}.ts`;
}

async function loadModule(modulePath) {
    const normalizedPath = resolve(modulePath);
    const cached = moduleCache.get(normalizedPath);
    if (cached) return cached;

    const source = mockSources.get(normalizedPath)
        ?? await readFile(normalizedPath, "utf8");
    const code = mockSources.has(normalizedPath)
        ? source
        : ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.ESNext,
                moduleResolution: ts.ModuleResolutionKind.Bundler,
            },
        }).outputText;
    const module = new SourceTextModule(code, {
        context,
        identifier: normalizedPath,
    });
    moduleCache.set(normalizedPath, module);
    await module.link((specifier, referencingModule) => loadModule(
        sourceModulePath(specifier, referencingModule),
    ));
    return module;
}

function memory(id, overrides = {}) {
    return {
        id,
        characterId: "char-1",
        sourceApp: "chat",
        type: "long_term",
        content: `记忆 ${id}`,
        importance: 0.5,
        createdAt: "2026-08-20T12:00:00.000Z",
        updatedAt: "2026-08-20T12:00:00.000Z",
        ...overrides,
    };
}

const config = {
    cognitiveMemoryEnabled: true,
    vectorRecallEnabled: false,
    hybridRecallEnabled: true,
    longTermTokenBudget: 1000,
    maxSelectedLongTermMemories: 10,
    maxProtectedFutureIntents: 3,
};
context.__testConfig = config;

const statsModule = await loadModule(resolve(repoRoot, "lib/memory-recall-stats.ts"));
await statsModule.evaluate();
const {
    applyRecallStats,
    getRecallMemoryIds,
} = statsModule.namespace;

const serviceModule = await loadModule(resolve(repoRoot, "lib/memory-service.ts"));
await serviceModule.evaluate();
const {
    commitMemoryRecall,
    createMemoryRecallCallback,
    selectMemoriesForPrompt,
} = serviceModule.namespace;

const selected = memory("selected", {
    content: "alpha selected",
    importance: 0.95,
});
const candidate = memory("candidate", {
    content: "alpha candidate",
    importance: 0.1,
});
context.__testMemories = [selected, candidate];

const selection = await selectMemoriesForPrompt("char-1", "alpha", {
    config,
    recentTopK: 0,
    maxSelected: 1,
});
assert.deepEqual(Array.from(selection.selected, entry => entry.id), ["selected"]);
assert.equal(selected.accessCount, undefined, "selection must not self-update recall stats");
assert.equal(candidate.accessCount, undefined, "candidate must remain untouched");

await commitMemoryRecall("char-1", selection.selected.map(entry => entry.id), { recalledAt: "2026-09-01T12:00:00.000Z" });
assert.deepEqual(JSON.parse(JSON.stringify(context.__recallWrites)), [{
    characterId: "char-1",
    memoryIds: ["selected"],
    recalledAt: "2026-09-01T12:00:00.000Z",
}]);
const selectedAfterRecall = applyRecallStats(selected, "2026-09-01T12:00:00.000Z");
assert.equal(selectedAfterRecall.accessCount, 1);
assert.equal(selectedAfterRecall.lastAccessedAt, "2026-09-01T12:00:00.000Z");
assert.ok(selectedAfterRecall.stability > 0);

context.__testConfig = { ...config, memoryStabilityEnabled: false };
await commitMemoryRecall("char-1", ["selected"], { recalledAt: "2026-09-01T12:00:00.000Z" });
assert.equal(context.__recallWrites.at(-1).memoryStabilityEnabled, false, "the config flag must reach recall stats persistence");
context.__testConfig = config;

const legacyAfterRecall = applyRecallStats(memory("legacy", { importance: 0.5 }), "2026-09-01T12:00:00.000Z");
assert.equal(legacyAfterRecall.accessCount, 1, "legacy accessCount defaults to zero before increment");
assert.equal(legacyAfterRecall.lastAccessedAt, "2026-09-01T12:00:00.000Z");
assert.ok(Math.abs(legacyAfterRecall.stability - 0.57) < 1e-9, "legacy stability uses the existing default plus the v1 boost");
assert.equal(legacyAfterRecall.createdAt, "2026-08-20T12:00:00.000Z");
assert.equal(legacyAfterRecall.updatedAt, "2026-08-20T12:00:00.000Z");

const existingStatsAfterRecall = applyRecallStats(memory("existing", {
    accessCount: 3,
    stability: 0.4,
}), "2026-09-01T12:00:00.000Z");
assert.equal(existingStatsAfterRecall.accessCount, 4);
assert.ok(Math.abs(existingStatsAfterRecall.stability - 0.415) < 1e-9);
const stabilityDisabledAfterRecall = applyRecallStats(memory("stability-disabled", {
    accessCount: 3,
    stability: 0.4,
}), "2026-09-01T12:00:00.000Z", { memoryStabilityEnabled: false });
assert.equal(stabilityDisabledAfterRecall.accessCount, 4);
assert.equal(stabilityDisabledAfterRecall.lastAccessedAt, "2026-09-01T12:00:00.000Z");
assert.equal(stabilityDisabledAfterRecall.stability, 0.4, "disabled stability must not receive a reinforcement boost");
assert.equal(applyRecallStats(memory("bounded", { accessCount: 99, stability: 0.999 }), "now").stability, 1);

const futureIntent = memory("intent", {
    kind: "future_intent",
    futureIntent: {
        type: "promise",
        status: "pending",
        targetAt: "2026-09-03T12:00:00.000Z",
    },
});
const lifecycleBefore = structuredClone(futureIntent.futureIntent);
const futureIntentAfterRecall = applyRecallStats(futureIntent, "2026-09-01T12:00:00.000Z");
assert.deepEqual(futureIntentAfterRecall.futureIntent, lifecycleBefore, "recall stats must not advance Future Intent lifecycle");

const oversized = memory("oversized", { content: "alpha oversized" });
context.__testMemories = [oversized];
const oversizedSelection = await selectMemoriesForPrompt("char-1", "alpha", {
    config,
    recentTopK: 0,
    tokenBudget: 1,
});
assert.equal(oversizedSelection.selected.length, 0);
await commitMemoryRecall("char-1", oversizedSelection.selected.map(entry => entry.id), { recalledAt: "2026-09-01T12:00:00.000Z" });

const clusterA = memory("cluster-a", { content: "cluster alpha one", importance: 0.9, metadata: { sourceBatchId: "cluster-1" } });
const clusterB = memory("cluster-b", { content: "cluster alpha two", importance: 0.8, metadata: { sourceBatchId: "cluster-1" } });
context.__testMemories = [clusterA, clusterB];
const diversitySelection = await selectMemoriesForPrompt("char-1", "cluster alpha", {
    config,
    recentTopK: 0,
    maxSelected: 2,
    maxPerCluster: 1,
});
assert.equal(diversitySelection.selected.length, 1);
await commitMemoryRecall("char-1", diversitySelection.selected.map(entry => entry.id), { recalledAt: "2026-09-01T12:00:00.000Z" });
assert.equal(context.__recallWrites.filter(write => write.memoryIds.includes("cluster-b")).length, 0);

const callsBeforeFailure = context.__recallWrites.length;
context.__failRecallWrites = true;
await assert.doesNotReject(() => commitMemoryRecall("char-1", ["cluster-a"], { recalledAt: "2026-09-01T12:00:00.000Z" }));
context.__failRecallWrites = false;
assert.equal(context.__recallWrites.length, callsBeforeFailure + 1, "write failure must not block the prompt path");

const callback = createMemoryRecallCallback("char-1", ["callback-memory"]);
assert.equal(typeof callback, "function");
callback();
await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
assert.ok(context.__recallWrites.some(write => write.memoryIds.includes("callback-memory")));

const writesBeforeGuards = context.__recallWrites.length;
await commitMemoryRecall("char-1", ["guarded"], { recordRecall: false });
await commitMemoryRecall("char-1", ["dry-run"], { dryRun: true });
await commitMemoryRecall("char-1", ["debug"], { debugPreview: true });
await commitMemoryRecall("char-1", ["migration"], { migrationRestore: true });
assert.equal(context.__recallWrites.length, writesBeforeGuards, "guarded paths must not write stats");
assert.equal(getRecallMemoryIds(["selected", "selected", ""], { injected: false }).length, 0);
assert.deepEqual(Array.from(getRecallMemoryIds(["selected", "selected", ""], { injected: true })), ["selected"]);
assert.equal(createMemoryRecallCallback("char-1", ["preview"], { recordRecall: false }), undefined);
assert.equal(createMemoryRecallCallback("char-1", ["not-injected"], { injected: false }), undefined);

console.log("memory recall stats tests passed");
