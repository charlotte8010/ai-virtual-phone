import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { createContext, SourceTextModule } from "node:vm";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localStorageState = new Map();
const context = createContext({ console });
context.window = {
    localStorage: {
        getItem(key) { return localStorageState.get(key) ?? null; },
        setItem(key, value) { localStorageState.set(key, String(value)); },
        removeItem(key) { localStorageState.delete(key); },
    },
};
context.__testMemories = [];
context.__testLinks = [];
context.__testConfig = { memoryLinksEnabled: true };
context.__linkWriteFailure = false;
context.__linkLoadFailure = false;
context.__recallWrites = [];

const mockSources = new Map([
    [resolve(repoRoot, "lib/memory-storage.ts"), `
        export function loadMemoryConfig() { return globalThis.__testConfig; }
        export async function loadMemoryEntriesByType(characterId, type) {
            return globalThis.__testMemories.filter(entry => entry.characterId === characterId && entry.type === type);
        }
        export async function loadMemoryLinks(characterId) {
            if (globalThis.__linkLoadFailure) throw new Error("simulated link load failure");
            return globalThis.__testLinks.filter(link => link.characterId === characterId);
        }
        export async function saveMemoryLinks(links) {
            if (globalThis.__linkWriteFailure) throw new Error("simulated link write failure");
            globalThis.__testLinks = [
                ...globalThis.__testLinks.filter(existing => !links.some(link => link.id === existing.id)),
                ...links,
            ];
        }
        export async function saveMemoryLink(link) {
            return saveMemoryLinks([link]);
        }
        export async function deleteMemoryLinks(ids) {
            globalThis.__testLinks = globalThis.__testLinks.filter(link => !ids.includes(link.id));
        }
    `],
    [resolve(repoRoot, "lib/settings-storage.ts"), `
        export function resolveAuxiliaryApiConfig() { return { provider: "OpenAI", defaultModel: "text-embedding-3-small" }; }
    `],
    [resolve(repoRoot, "lib/memory-embedding.ts"), `
        export function resolveEmbeddingModel() { return "text-embedding-3-small"; }
        export async function generateEmbedding() { return [1, 0]; }
        export function cosineSimilarity(a, b) {
            if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return 0;
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
    const source = mockSources.get(normalizedPath) ?? await readFile(normalizedPath, "utf8");
    const code = mockSources.has(normalizedPath)
        ? source
        : ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.ESNext,
                moduleResolution: ts.ModuleResolutionKind.Bundler,
            },
        }).outputText;
    const module = new SourceTextModule(code, { context, identifier: normalizedPath });
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
        embedding: [1, 0],
        createdAt: `2026-08-${String(Number(id.replace(/\D/g, "")) || 20).padStart(2, "0")}T12:00:00.000Z`,
        updatedAt: "2026-08-20T12:00:00.000Z",
        ...overrides,
    };
}

const linksModule = await loadModule(resolve(repoRoot, "lib/memory-links.ts"));
await linksModule.evaluate();
const {
    MAX_LINK_GENERATION_CANDIDATES,
    MAX_GENERATED_LINKS_PER_MEMORY,
    maybeGenerateMemoryLinksForEntry,
    normalizeMemoryLink,
    runMemoryLinkBackfill,
    spreadMemoryActivation,
} = linksModule.namespace;

const legacyEmotional = normalizeMemoryLink({
    id: "legacy-emotional",
    characterId: "char-1",
    fromMemoryId: "a",
    toMemoryId: "b",
    type: "emotional",
    strength: 0.8,
});
assert.equal(legacyEmotional.type, "emotion");
assert.equal(normalizeMemoryLink({
    id: "legacy-temporal",
    characterId: "char-1",
    fromMemoryId: "a",
    toMemoryId: "b",
    type: "temporal",
    strength: 0.8,
}).type, "temporal");
assert.equal(normalizeMemoryLink({
    id: "future-type",
    characterId: "char-1",
    fromMemoryId: "a",
    toMemoryId: "b",
    type: "future_custom_relation",
    strength: 0.8,
}).type, "future_custom_relation");

const seed = memory("seed-20", { embedding: [1, 0] });
const related = memory("related-21", { embedding: [0.99, 0.01] });
const unrelated = memory("unrelated-22", { embedding: [0, 1] });
const extraMemories = Array.from({ length: 30 }, (_, index) => memory(`extra-${index}`));
context.__testMemories = [seed, related, unrelated, ...extraMemories];
context.__testLinks = [
    { ...legacyEmotional, fromMemoryId: "seed-20", toMemoryId: "related-21" },
    { ...legacyEmotional, id: "future-relation", type: "future_custom_relation", fromMemoryId: "seed-20", toMemoryId: "unrelated-22" },
];
const legacyExpansion = await spreadMemoryActivation("char-1", ["seed-20"], context.__testMemories);
assert.equal(legacyExpansion.candidates.some(candidate => candidate.memoryId === "related-21"), true);
assert.equal(legacyExpansion.candidates.some(candidate => candidate.memoryId === "unrelated-22"), true);

context.__testLinks = [];
const generated = await maybeGenerateMemoryLinksForEntry(seed, {
    candidateEntries: [related, unrelated, ...extraMemories],
});
assert.equal(generated.status, "created");
assert.ok(generated.createdCount > 0, "a new long-term memory should form semantic links");
assert.ok(context.__testLinks.length <= MAX_GENERATED_LINKS_PER_MEMORY * 2, "generation must remain bounded");
assert.ok(generated.consideredCount <= MAX_LINK_GENERATION_CANDIDATES, "generation must use a bounded candidate pool");
const linkIdsAfterFirstGeneration = Array.from(context.__testLinks, link => link.id).sort();
const generatedAgain = await maybeGenerateMemoryLinksForEntry(seed, {
    candidateEntries: [related, unrelated, ...extraMemories],
});
assert.ok(["created", "unchanged", "skipped"].includes(generatedAgain.status));
assert.deepEqual(Array.from(context.__testLinks, link => link.id).sort(), linkIdsAfterFirstGeneration);
assert.ok(MAX_LINK_GENERATION_CANDIDATES <= 16, "generation candidate pool must have a hard bound");

context.__linkWriteFailure = true;
await assert.doesNotReject(
    maybeGenerateMemoryLinksForEntry(seed, { candidateEntries: [related] }),
    "link generation failure must not reject the memory save path",
);
context.__linkWriteFailure = false;

localStorageState.clear();
const backfillMemories = Array.from({ length: 4 }, (_, index) => memory(`backfill-${20 + index}`, {
    content: `相似主题 ${index}`,
    embedding: [1, 0],
    accessCount: 3,
    lastAccessedAt: "2026-08-20T13:00:00.000Z",
    stability: 0.7,
}));
context.__testLinks = [{
    id: "preserved-link",
    characterId: "char-1",
    fromMemoryId: "backfill-20",
    toMemoryId: "backfill-21",
    type: "temporal",
    strength: 0.95,
    createdAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
}];
context.__testMemories = backfillMemories;
const statsBeforeBackfill = backfillMemories.map(entry => ({
    id: entry.id,
    accessCount: entry.accessCount,
    lastAccessedAt: entry.lastAccessedAt,
    stability: entry.stability,
}));
const firstBackfill = await runMemoryLinkBackfill("char-1", { batchSize: 2 });
assert.equal(firstBackfill.status, "paused");
assert.ok(firstBackfill.processedCount > 0);
assert.ok(context.__testLinks.length > 0, "first backfill pass should create valid links");
assert.ok(context.__testLinks.some(link => link.id === "preserved-link"), "backfill must preserve existing valid links");
const secondBackfill = await runMemoryLinkBackfill("char-1", { batchSize: 2 });
assert.equal(secondBackfill.status, "complete");
const linkIdsAfterBackfill = Array.from(context.__testLinks, link => link.id).sort();
const thirdBackfill = await runMemoryLinkBackfill("char-1", { batchSize: 2 });
assert.equal(thirdBackfill.processedCount, 0, "completed backfill should be resumable and idempotent");
assert.deepEqual(Array.from(context.__testLinks, link => link.id).sort(), linkIdsAfterBackfill);
assert.deepEqual(backfillMemories.map(entry => ({
    id: entry.id,
    accessCount: entry.accessCount,
    lastAccessedAt: entry.lastAccessedAt,
    stability: entry.stability,
})), statsBeforeBackfill, "backfill must not update recall stats");

localStorageState.clear();
context.__testLinks = [];
context.__linkWriteFailure = true;
const failedBackfill = await runMemoryLinkBackfill("char-1", { batchSize: 1 });
assert.equal(failedBackfill.status, "failed");
assert.equal(failedBackfill.processedCount, 0, "failed batch must not advance the cursor");
context.__linkWriteFailure = false;
const resumedBackfill = await runMemoryLinkBackfill("char-1", { batchSize: 4 });
assert.equal(resumedBackfill.status, "complete");

console.log("memory link lifecycle tests passed");
