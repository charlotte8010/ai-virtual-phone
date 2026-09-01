import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { createContext, SourceTextModule } from "node:vm";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const context = createContext({ console });
context.__testMemories = [];
context.__testLinks = [];
context.__testConfig = null;
context.__recallWrites = [];

const mockSources = new Map([
    [resolve(repoRoot, "lib/memory-storage.ts"), `
        export function loadMemoryConfig() { return globalThis.__testConfig; }
        export async function loadMemoryEntriesByType(characterId, type) {
            return globalThis.__testMemories.filter(entry => entry.characterId === characterId && entry.type === type);
        }
        export async function updateMemoryRecallStats(characterId, memoryIds, recalledAt, memoryStabilityEnabled) {
            globalThis.__recallWrites.push({ characterId, memoryIds: [...memoryIds], recalledAt, memoryStabilityEnabled });
        }
        export async function loadMemoryLinks(characterId) {
            return globalThis.__testLinks.filter(link => link.characterId === characterId);
        }
        export async function saveMemoryLink(link) {
            globalThis.__testLinks = [...globalThis.__testLinks.filter(item => item.id !== link.id), link];
        }
        export async function saveMemoryLinks(links) {
            for (const link of links) await saveMemoryLink(link);
        }
        export async function deleteMemoryLinks(ids) {
            globalThis.__testLinks = globalThis.__testLinks.filter(link => !ids.includes(link.id));
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

function link(id, fromMemoryId, toMemoryId, strength, overrides = {}) {
    return {
        id,
        characterId: "char-1",
        fromMemoryId,
        toMemoryId,
        type: "topic",
        strength,
        createdAt: "2026-08-20T12:00:00.000Z",
        updatedAt: "2026-08-20T12:00:00.000Z",
        ...overrides,
    };
}

const linksModule = await loadModule(resolve(repoRoot, "lib/memory-links.ts"));
await linksModule.evaluate();
const {
    MAX_EXPANDED_MEMORY_LINKS,
    MAX_LINK_DEPTH,
    MAX_LINK_NEIGHBORS_PER_SEED,
    MAX_LINK_SEEDS,
    createMemoryLink,
    normalizeMemoryLink,
    pruneMemoryLinks,
    spreadMemoryActivation,
} = linksModule.namespace;

assert.equal(normalizeMemoryLink({
    id: "normalized",
    characterId: "char-1",
    fromMemoryId: "a",
    toMemoryId: "b",
    type: "topic",
    strength: 2,
    createdAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
}).strength, 1);
assert.equal(normalizeMemoryLink({
    id: "self",
    characterId: "char-1",
    fromMemoryId: "same",
    toMemoryId: "same",
    type: "topic",
    strength: 0.5,
}), null, "self-links must be ignored");
assert.equal(normalizeMemoryLink({
    id: "invalid",
    characterId: "char-1",
    fromMemoryId: "a",
    toMemoryId: "b",
    type: "unknown",
    strength: 0.5,
}), null);
assert.equal(normalizeMemoryLink({
    id: "malformed-strength",
    characterId: "char-1",
    fromMemoryId: "a",
    toMemoryId: "b",
    type: "topic",
    strength: "NaN",
}), null);

const pruned = pruneMemoryLinks(
    Array.from({ length: 10 }, (_, index) => link(`link-${index}`, "a", `target-${index}`, index / 10)),
    8,
);
assert.equal(pruned.length, 8);
assert.deepEqual(Array.from(pruned, item => item.id), [
    "link-9", "link-8", "link-7", "link-6", "link-5", "link-4", "link-3", "link-2",
]);

const graphMemories = [
    memory("seed", { content: "alpha seed memory", importance: 0.9 }),
    memory("neighbor-a", { content: "beta related memory", importance: 0.7 }),
    memory("neighbor-b", { content: "gamma related memory", importance: 0.6 }),
    memory("neighbor-c", { content: "delta related memory", importance: 0.5 }),
    memory("terminal-intent", {
        kind: "future_intent",
        content: "已经完成的计划",
        futureIntent: { type: "plan", status: "fulfilled", timePrecision: "day", targetAt: "2026-08-20T12:00:00.000Z" },
    }),
];
context.__testMemories = graphMemories;
context.__testLinks = [
    link("seed-a", "seed", "neighbor-a", 0.9),
    link("seed-b", "seed", "neighbor-b", 0.8),
    link("seed-c", "seed", "neighbor-c", 0.1),
    link("a-c", "neighbor-a", "neighbor-c", 0.8),
    link("cycle", "neighbor-a", "seed", 0.95),
    link("terminal", "seed", "terminal-intent", 0.95),
    link("orphan", "seed", "missing", 0.95),
    link("cross-character", "seed", "other-character", 0.95, { characterId: "char-2" }),
    link("duplicate-low", "seed", "neighbor-b", 0.4),
    link("duplicate-high", "seed", "neighbor-b", 0.75),
];
const expansion = await spreadMemoryActivation("char-1", ["seed"], graphMemories);
assert.deepEqual(Array.from(expansion.seedMemoryIds), ["seed"]);
assert.deepEqual(Array.from(expansion.candidates, candidate => candidate.memoryId), [
    "neighbor-a", "neighbor-b", "neighbor-c",
]);
assert.equal(expansion.candidates.find(candidate => candidate.memoryId === "neighbor-b").linkActivationScore, 0.75);
assert.ok(expansion.candidates.find(candidate => candidate.memoryId === "neighbor-c").linkActivationScore < 0.75);
assert.equal(expansion.candidates.some(candidate => candidate.memoryId === "seed"), false, "cycles must not revisit a seed");
assert.equal(expansion.candidates.some(candidate => candidate.memoryId === "terminal-intent"), false, "terminal Future Intent must stay inactive");
assert.equal(expansion.limits.maxSeeds, MAX_LINK_SEEDS);
assert.equal(expansion.limits.maxDepth, MAX_LINK_DEPTH);
assert.equal(expansion.limits.neighborsPerSeed, MAX_LINK_NEIGHBORS_PER_SEED);
assert.equal(expansion.limits.maxExpanded, MAX_EXPANDED_MEMORY_LINKS);

const denseMemories = [memory("dense-seed"), ...Array.from({ length: 20 }, (_, index) => memory(`dense-${index}`))];
context.__testMemories = denseMemories;
context.__testLinks = Array.from({ length: 20 }, (_, index) => link(`dense-link-${index}`, "dense-seed", `dense-${index}`, 0.9));
const denseExpansion = await spreadMemoryActivation("char-1", ["dense-seed"], denseMemories);
assert.ok(denseExpansion.candidates.length <= MAX_EXPANDED_MEMORY_LINKS, "dense graph must obey global cap");

context.__testLinks = [link("existing", "seed", "neighbor-a", 0.99)];
const created = await createMemoryLink({
    characterId: "char-1",
    fromMemoryId: "seed",
    toMemoryId: "neighbor-c",
    type: "topic",
    strength: 0.95,
});
assert.equal(created?.strength, 0.95);
assert.ok(context.__testLinks.some(item => item.id === created.id));

const serviceModule = await loadModule(resolve(repoRoot, "lib/memory-service.ts"));
await serviceModule.evaluate();
const {
    createMemoryRecallCallback,
    retrieveCoreMemoriesForPrompt,
    selectMemoriesForPrompt,
} = serviceModule.namespace;
const serviceMemories = [
    memory("seed", { content: "alpha seed memory", importance: 0.9 }),
    memory("neighbor-a", { content: "beta related memory", importance: 0.7 }),
    memory("neighbor-b", { content: "gamma unrelated memory", importance: 0.2 }),
    memory("protected-fi", {
        content: "今天答应提醒用户复诊。",
        kind: "future_intent",
        futureIntent: {
            type: "promise",
            status: "pending",
            timePrecision: "day",
            targetAt: "2026-09-01T14:00:00.000Z",
        },
    }),
    memory("core-memory", { type: "core", metadata: { active: true } }),
];
context.__testMemories = serviceMemories;
context.__testLinks = [
    link("service-link", "seed", "neighbor-a", 0.9),
    link("service-fi-link", "seed", "protected-fi", 0.95),
];
const config = {
    cognitiveMemoryEnabled: true,
    vectorRecallEnabled: false,
    hybridRecallEnabled: true,
    memoryLinksEnabled: true,
    longTermTokenBudget: 1000,
    maxSelectedLongTermMemories: 3,
    maxProtectedFutureIntents: 2,
};
context.__testConfig = config;
const linkedSelection = await selectMemoriesForPrompt("char-1", "alpha", {
    config,
    now: new Date("2026-09-01T12:00:00.000Z"),
    recentTopK: 0,
    maxSelected: 3,
    debug: true,
});
assert.ok(linkedSelection.selected.some(entry => entry.id === "neighbor-a"));
assert.ok(linkedSelection.selected.some(entry => entry.id === "protected-fi"));
assert.ok(linkedSelection.debug.channelCounts.link > 0);
const linkDebug = linkedSelection.debug.candidates.find(candidate => candidate.memoryId === "neighbor-a");
assert.ok(linkDebug.sources.includes("link"));
assert.ok(linkDebug.linkActivation);
assert.deepEqual(Array.from(linkDebug.linkActivation.seedMemoryIds), ["seed"]);
assert.equal(linkDebug.linkActivation.depth, 1);
assert.ok(linkDebug.featureScores.linkActivation > 0);
const protectedDebug = linkedSelection.debug.candidates.find(candidate => candidate.memoryId === "protected-fi");
assert.equal(protectedDebug.protectedReason, "due_today");
assert.equal(protectedDebug.selected, true);
assert.ok(linkedSelection.debug.linkExpansion.expandedMemoryIds.includes("neighbor-a"));

const baselineSelection = await selectMemoriesForPrompt("char-1", "alpha", {
    config: { ...config, memoryLinksEnabled: false },
    now: new Date("2026-09-01T12:00:00.000Z"),
    recentTopK: 0,
    maxSelected: 3,
    debug: false,
});
const selectionOptions = {
    now: new Date("2026-09-01T12:00:00.000Z"),
    recentTopK: 0,
    maxSelected: 3,
};
assert.equal(baselineSelection.debug.channelCounts.link, 0);
assert.equal(baselineSelection.selected.some(entry => entry.id === "neighbor-a"), false);
assert.deepEqual(
    Array.from(await selectMemoriesForPrompt("char-1", "alpha", {
        ...selectionOptions,
        config,
        debug: false,
    }), entry => entry.id),
    Array.from(linkedSelection.selected, entry => entry.id),
    "debug on/off must preserve C9 selected IDs",
);
assert.equal(context.__recallWrites.length, 0, "retrieval and spreading preview must not write recall stats");

const coreResults = await retrieveCoreMemoriesForPrompt("char-1", config);
assert.deepEqual(Array.from(coreResults, entry => entry.id), ["core-memory"]);

const previewCallback = createMemoryRecallCallback(
    "char-1",
    linkedSelection.selected.map(entry => entry.id),
    { recordRecall: false },
);
previewCallback?.();
await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
assert.equal(context.__recallWrites.length, 0, "preview recall must remain side-effect-free");
const productionCallback = createMemoryRecallCallback(
    "char-1",
    linkedSelection.selected.map(entry => entry.id),
    { recalledAt: "2026-09-01T12:00:00.000Z" },
);
productionCallback?.();
await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
assert.deepEqual(Array.from(context.__recallWrites.at(-1).memoryIds), Array.from(linkedSelection.selected, entry => entry.id));

console.log("memory links tests passed");
