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
context.__testEmbeddingConfig = null;
context.__testEmbeddingModel = null;
context.__embeddingQueries = [];

const mockSources = new Map([
    [resolve(repoRoot, "lib/memory-storage.ts"), `
        export function loadMemoryConfig() { return globalThis.__testConfig; }
        export async function loadMemoryEntriesByType(characterId, type) {
            return globalThis.__testMemories.filter(entry => entry.characterId === characterId && entry.type === type);
        }
        export async function updateMemoryRecallStats(characterId, memoryIds, recalledAt, memoryStabilityEnabled) {
            globalThis.__recallWrites.push({ characterId, memoryIds: [...memoryIds], recalledAt, memoryStabilityEnabled });
        }
    `],
    [resolve(repoRoot, "lib/settings-storage.ts"), `
        export function resolveAuxiliaryApiConfig() { return globalThis.__testEmbeddingConfig; }
    `],
    [resolve(repoRoot, "lib/memory-embedding.ts"), `
        export function resolveEmbeddingModel() { return globalThis.__testEmbeddingModel; }
        export async function generateEmbedding(query) {
            globalThis.__embeddingQueries.push(query);
            return [1, 0];
        }
        export function cosineSimilarity(a, b) {
            if (a.length !== b.length || a.length === 0) return 0;
            let dot = 0;
            let magA = 0;
            let magB = 0;
            for (let index = 0; index < a.length; index += 1) {
                dot += a[index] * b[index];
                magA += a[index] * a[index];
                magB += b[index] * b[index];
            }
            const denominator = Math.sqrt(magA) * Math.sqrt(magB);
            return denominator === 0 ? 0 : dot / denominator;
        }
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

const now = new Date("2026-09-01T12:00:00.000Z");
const config = {
    cognitiveMemoryEnabled: true,
    vectorRecallEnabled: true,
    hybridRecallEnabled: true,
    longTermTokenBudget: 1000,
    maxSelectedLongTermMemories: 3,
    maxProtectedFutureIntents: 2,
};
const multiSource = memory("multi-source", {
    content: "alpha 用户和角色讨论旅行计划。",
    embedding: [1, 0],
    importance: 0.9,
    tags: ["alpha"],
    updatedAt: "2026-09-01T11:00:00.000Z",
});
const protectedIntent = memory("protected-intent", {
    content: "今天提醒用户复诊。",
    kind: "future_intent",
    importance: 0.2,
    futureIntent: {
        type: "promise",
        status: "pending",
        timePrecision: "day",
        targetAt: "2026-09-01T14:00:00.000Z",
    },
});
const clusterA = memory("cluster-a", {
    content: "alpha 同一批次的另一条细节。",
    importance: 0.6,
    metadata: { sourceBatchId: "cluster-1" },
});
const clusterB = memory("cluster-b", {
    content: "alpha 同一批次的第三条细节。",
    importance: 0.4,
    metadata: { sourceBatchId: "cluster-1" },
});
context.__testMemories = [multiSource, protectedIntent, clusterA, clusterB];
context.__testConfig = config;
context.__testEmbeddingConfig = { provider: "OpenAI", defaultModel: "text-embedding-3-small" };
context.__testEmbeddingModel = "text-embedding-3-small";
const memoryStatsBeforeDebug = context.__testMemories.map(entry => ({
    id: entry.id,
    accessCount: entry.accessCount,
    lastAccessedAt: entry.lastAccessedAt,
    stability: entry.stability,
}));

const serviceModule = await loadModule(resolve(repoRoot, "lib/memory-service.ts"));
await serviceModule.evaluate();
const {
    createMemoryRecallCallback,
    createMemoryRetrievalDebugCollector,
    retrieveCoreMemoriesForPrompt,
    selectMemoriesForPrompt,
} = serviceModule.namespace;

const selectionOptions = {
    config,
    now,
    timezone: "Asia/Shanghai",
    vectorTopK: 10,
    keywordTopK: 10,
    recentTopK: 10,
    maxSelected: 3,
    maxPerCluster: 1,
};
const collector = createMemoryRetrievalDebugCollector();
const debugSelection = await selectMemoriesForPrompt("char-1", "alpha", {
    ...selectionOptions,
    debug: true,
    debugCollector: collector,
});
const debug = debugSelection.debug;
assert.equal(debug.characterId, "char-1");
assert.equal(debug.query, "alpha");
assert.equal(debug.timestamp, now.toISOString());
assert.deepEqual(JSON.parse(JSON.stringify(debug.limits)), {
    vectorTopK: 10,
    keywordTopK: 10,
    recentTopK: 10,
    tokenBudget: 1000,
    maxSelected: 3,
    maxProtectedFutureIntents: 2,
    maxPerCluster: 1,
});
assert.ok(debug.channelCounts.vector > 0, "debug should include vector candidates");
assert.ok(debug.channelCounts.keyword > 0, "debug should include keyword candidates");
assert.ok(debug.channelCounts.recent > 0, "debug should include recent candidates");
assert.ok(debug.channelCounts.future_intent > 0, "debug should include Future Intent candidates");
const multiSourceDebug = debug.candidates.find(candidate => candidate.memoryId === "multi-source");
assert.deepEqual([...multiSourceDebug.sources].sort(), ["keyword", "recent", "vector"]);
assert.ok(multiSourceDebug.featureScores.semantic >= 0 && multiSourceDebug.featureScores.semantic <= 1);
assert.equal(typeof multiSourceDebug.finalScore, "number");
assert.equal(multiSourceDebug.selected, true);
const protectedDebug = debug.candidates.find(candidate => candidate.memoryId === "protected-intent");
assert.equal(protectedDebug.protectedReason, "due_today");
const rejectedDebug = debug.candidates.find(candidate => candidate.selected === false);
assert.ok(rejectedDebug?.rejectionReason, "every rejected candidate needs a deterministic reason");
assert.ok(debug.selectedMemoryIds.every(id => debug.candidates.some(candidate => candidate.memoryId === id && candidate.selected)));
assert.deepEqual(Array.from(collector.getSnapshot().injectedMemoryIds), []);
assert.deepEqual(
    context.__testMemories.map(entry => ({
        id: entry.id,
        accessCount: entry.accessCount,
        lastAccessedAt: entry.lastAccessedAt,
        stability: entry.stability,
    })),
    memoryStatsBeforeDebug,
    "debug retrieval must not change recall stats",
);

const baseline = await selectMemoriesForPrompt("char-1", "alpha", selectionOptions);
assert.deepEqual(
    debugSelection.selected.map(entry => entry.id),
    baseline.selected.map(entry => entry.id),
    "debug mode must preserve C7 selected IDs",
);
assert.equal(baseline.debug.candidates, undefined, "candidate trace must be opt-in");
assert.equal(context.__recallWrites.length, 0, "selection/debug must not update recall stats");

const coreMemory = memory("core-memory", {
    type: "core",
    metadata: { active: true, eventDate: "2026-08-31" },
});
context.__testMemories = [coreMemory];
const coreResults = await retrieveCoreMemoriesForPrompt("char-1", config);
assert.deepEqual(Array.from(coreResults, entry => entry.id), ["core-memory"], "C7 core retrieval must remain unchanged");
context.__testMemories = [multiSource, protectedIntent, clusterA, clusterB];

const previewCollector = createMemoryRetrievalDebugCollector();
const previewCallback = createMemoryRecallCallback(
    "char-1",
    debugSelection.selected.map(entry => entry.id),
    { recordRecall: false, debugCollector: previewCollector },
);
previewCallback?.();
await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
assert.equal(context.__recallWrites.length, 0, "preview injection must not write recall stats");
assert.deepEqual(
    Array.from(previewCollector.getSnapshot().injectedMemoryIds),
    [],
    "preview must not claim a production injection",
);
assert.deepEqual(
    context.__testMemories.map(entry => ({
        id: entry.id,
        accessCount: entry.accessCount,
        lastAccessedAt: entry.lastAccessedAt,
        stability: entry.stability,
    })),
    memoryStatsBeforeDebug,
    "prompt preview must not change recall stats",
);

const productionCollector = collector;
const productionIds = debugSelection.selected.slice(0, 2).map(entry => entry.id);
const productionCallback = createMemoryRecallCallback(
    "char-1",
    productionIds,
    { recalledAt: "2026-09-01T12:00:00.000Z", debugCollector: productionCollector },
);
productionCallback?.();
await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
assert.deepEqual(Array.from(productionCollector.getSnapshot().injectedMemoryIds), Array.from(productionIds));
assert.deepEqual(
    Array.from(productionCollector.getSnapshot().retrieval?.injectedMemoryIds ?? []),
    Array.from(productionIds),
);
assert.deepEqual(Array.from(context.__recallWrites.at(-1).memoryIds), Array.from(productionIds));

console.log("memory debug instrumentation tests passed");
