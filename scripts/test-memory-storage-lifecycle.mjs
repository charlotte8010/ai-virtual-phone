import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { createContext, SourceTextModule } from "node:vm";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const context = createContext({ console });
context.window = {
    localStorage: {
        getItem() { return null; },
        setItem() {},
        removeItem() {},
    },
};
context.indexedDB = {};
context.__memoryRecords = new Map();
context.__memoryLinks = new Map();
context.__lifecycle = {
    dynamicImports: 0,
    generation: [],
    backfill: [],
    generationFailure: false,
    embeddingCalls: 0,
    recallStatsWrites: 0,
};

function createMemoryTransaction(storeName) {
    const transaction = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore() {
            return {
                put(entry) {
                    if (storeName === "memories") context.__memoryRecords.set(entry.id, { ...entry });
                    if (storeName === "memory_links") context.__memoryLinks.set(entry.id, { ...entry });
                },
                delete(id) {
                    if (storeName === "memories") context.__memoryRecords.delete(id);
                    if (storeName === "memory_links") context.__memoryLinks.delete(id);
                },
            };
        },
    };
    Promise.resolve().then(() => transaction.oncomplete?.());
    return transaction;
}

context.__memoryDb = {
    transaction(storeName) {
        return createMemoryTransaction(storeName);
    },
    close() {},
};

const mockSources = new Map([
    [resolve(repoRoot, "lib/kv-db.ts"), `
        export function kvGet() { return null; }
        export function kvSet() {}
        export function registerKvMigration() {}
        export function registerDynamicPrefix() {}
    `],
    [resolve(repoRoot, "lib/idb-open.ts"), `
        export async function openIndexedDbAtLeast() { return globalThis.__memoryDb; }
    `],
    [resolve(repoRoot, "lib/memory-compat.ts"), `
        export function normalizeMemoryEntry(entry) { return { ...entry }; }
    `],
    [resolve(repoRoot, "lib/memory-recall-stats.ts"), `
        export function applyRecallStats(entry) {
            globalThis.__lifecycle.recallStatsWrites += 1;
            return { ...entry };
        }
    `],
    [resolve(repoRoot, "lib/chat-db.ts"), `
        export async function dbWaitForMessagePersistence() { return true; }
    `],
    [resolve(repoRoot, "lib/memory-links.ts"), `
        export function scheduleMemoryLinkGenerationForEntry(entry) {
            globalThis.__lifecycle.generation.push(entry.id);
            if (globalThis.__lifecycle.generationFailure) throw new Error("simulated lifecycle failure");
        }
        export function scheduleMemoryLinkBackfillForCharacter(characterId) {
            globalThis.__lifecycle.backfill.push(characterId);
        }
        export function noteEmbeddingCall() { globalThis.__lifecycle.embeddingCalls += 1; }
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
    const module = new SourceTextModule(code, {
        context,
        identifier: normalizedPath,
        importModuleDynamically: async (specifier, referencingModule) => {
            context.__lifecycle.dynamicImports += 1;
            const dependency = await loadModule(sourceModulePath(specifier, referencingModule));
            if (dependency.status !== "evaluated") await dependency.evaluate();
            return dependency;
        },
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

const storageModule = await loadModule(resolve(repoRoot, "lib/memory-storage.ts"));
await storageModule.evaluate();
const { saveMemoryEntry, saveMemoryEntries, saveMemoryLinks, deleteMemoryLinks, deleteMemoryEntriesWithoutLinkCleanup } = storageModule.namespace;

const suppressedSingle = memory("suppressed-single");
await saveMemoryEntry(suppressedSingle, { suppressMemoryLinkLifecycle: true });
await Promise.resolve();
assert.deepEqual(context.__memoryRecords.get(suppressedSingle.id), suppressedSingle);
assert.equal(context.__lifecycle.dynamicImports, 0, "suppressed single write must not load lifecycle");
assert.deepEqual(context.__lifecycle.generation, []);
assert.deepEqual(context.__lifecycle.backfill, []);
assert.equal(context.__lifecycle.embeddingCalls, 0, "suppressed single write must not reach embedding");
assert.equal(context.__lifecycle.recallStatsWrites, 0, "memory persistence must not write recall stats");

const normalSingle = memory("normal-single");
await saveMemoryEntry(normalSingle);
await Promise.resolve();
await Promise.resolve();
await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
assert.deepEqual(context.__memoryRecords.get(normalSingle.id), normalSingle);
assert.equal(context.__lifecycle.dynamicImports, 1);
assert.deepEqual(context.__lifecycle.generation, [normalSingle.id]);
assert.deepEqual(context.__lifecycle.backfill, [normalSingle.characterId]);

const normalBatch = [
    memory("batch-long-term"),
    memory("batch-replacement"),
    memory("batch-core", { type: "core" }),
];
await saveMemoryEntries(normalBatch);
await Promise.resolve();
await Promise.resolve();
await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
assert.deepEqual(
    normalBatch.map(entry => context.__memoryRecords.get(entry.id)),
    normalBatch,
    "normal batch must persist all entries before lifecycle runs",
);
assert.deepEqual(context.__lifecycle.generation.slice(-2), ["batch-long-term", "batch-replacement"]);
assert.deepEqual(context.__lifecycle.backfill.slice(-1), ["char-1"]);

const suppressedBatch = [
    memory("suppressed-batch-long-term"),
    memory("suppressed-batch-core", { type: "core" }),
];
const generationCountBeforeSuppressedBatch = context.__lifecycle.generation.length;
const backfillCountBeforeSuppressedBatch = context.__lifecycle.backfill.length;
await saveMemoryEntries(suppressedBatch, { suppressMemoryLinkLifecycle: true });
await Promise.resolve();
assert.deepEqual(
    suppressedBatch.map(entry => context.__memoryRecords.get(entry.id)),
    suppressedBatch,
    "suppressed batch must still persist the memory transaction",
);
assert.equal(context.__lifecycle.generation.length, generationCountBeforeSuppressedBatch);
assert.equal(context.__lifecycle.backfill.length, backfillCountBeforeSuppressedBatch);
assert.equal(context.__lifecycle.embeddingCalls, 0);
assert.equal(context.__lifecycle.recallStatsWrites, 0);

const failureEntry = memory("lifecycle-failure");
context.__lifecycle.generationFailure = true;
await assert.doesNotReject(
    saveMemoryEntry(failureEntry),
    "post-save lifecycle failure must not roll back a successful memory write",
);
await Promise.resolve();
await Promise.resolve();
context.__lifecycle.generationFailure = false;
assert.deepEqual(context.__memoryRecords.get(failureEntry.id), failureEntry);

const migrationCreatedMemory = memory("migration-created-memory");
const preExistingLink = {
    id: "pre-existing-link",
    characterId: migrationCreatedMemory.characterId,
    fromMemoryId: migrationCreatedMemory.id,
    toMemoryId: "unrelated-memory",
    type: "temporal",
    strength: 0.5,
    createdAt: migrationCreatedMemory.createdAt,
    updatedAt: migrationCreatedMemory.updatedAt,
};
const migrationCreatedLink = { ...preExistingLink, id: "migration-created-link", toMemoryId: "another-memory" };
await saveMemoryEntries([migrationCreatedMemory], { suppressMemoryLinkLifecycle: true });
await saveMemoryLinks([preExistingLink, migrationCreatedLink]);
await deleteMemoryLinks([migrationCreatedLink.id]);
await deleteMemoryEntriesWithoutLinkCleanup([migrationCreatedMemory.id]);
assert.equal(context.__memoryRecords.has(migrationCreatedMemory.id), false);
assert.equal(context.__memoryLinks.has(preExistingLink.id), true, "rollback must preserve pre-existing links");
assert.equal(context.__memoryLinks.has(migrationCreatedLink.id), false, "rollback must delete created links");

console.log("memory storage lifecycle tests passed");
