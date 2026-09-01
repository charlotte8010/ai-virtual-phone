import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { createContext, SourceTextModule } from "node:vm";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const context = createContext({ console, setTimeout });
context.window = { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } };
context.indexedDB = {};
context.IDBKeyRange = { bound: () => ({}) };
context.__memoryRecords = new Map();
context.__memoryLinks = new Map();
context.__snapshots = new Map();

function clone(value) {
    return typeof structuredClone === "function"
        ? structuredClone(value)
        : JSON.parse(JSON.stringify(value));
}

function request(result) {
    const req = { result, onsuccess: null, onerror: null };
    Promise.resolve().then(() => req.onsuccess?.());
    return req;
}

function createTransaction(storeNames) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const memoryWork = new Map([...context.__memoryRecords].map(([id, value]) => [id, clone(value)]));
    const linkWork = new Map([...context.__memoryLinks].map(([id, value]) => [id, clone(value)]));
    const snapshotWork = new Map([...context.__snapshots].map(([id, value]) => [id, clone(value)]));
    let aborted = false;
    let transactionError = null;
    const transaction = {
        error: null,
        oncomplete: null,
        onerror: null,
        onabort: null,
        objectStore(name) {
            if (!names.includes(name)) throw new Error("Store " + name + " is outside this transaction");
            const records = name === "memories"
                ? memoryWork
                : name === "memory_links"
                    ? linkWork
                    : snapshotWork;
            return {
                indexNames: { contains: () => true },
                put(value) {
                    records.set(value.id ?? value.runId, clone(value));
                    return request(undefined);
                },
                add(value) {
                    const id = value.id ?? value.runId;
                    if (records.has(id)) {
                        aborted = true;
                        transactionError = new Error("ConstraintError: duplicate " + id);
                        return request(undefined);
                    }
                    records.set(id, clone(value));
                    return request(undefined);
                },
                delete(id) {
                    records.delete(id);
                    return request(undefined);
                },
                get(id) {
                    return request(clone(records.get(id)));
                },
                getAll(query) {
                    const values = [...records.values()].map(clone);
                    if (name === "memories" && typeof query === "string") {
                        return request(values.filter(entry => entry.characterId === query));
                    }
                    return request(values);
                },
                index(indexName) {
                    return {
                        getAll(query) {
                            const values = [...records.values()].map(clone);
                            if (name === "memories" && indexName === "by_character_type" && Array.isArray(query)) {
                                return request(values.filter(entry => entry.characterId === query[0] && entry.type === query[1]));
                            }
                            if (name === "memory_links" && indexName === "by_character" && typeof query === "string") {
                                return request(values.filter(link => link.characterId === query));
                            }
                            if (name === "core_compaction_snapshots" && indexName === "by_character_compacted_at" && Array.isArray(query)) {
                                return request(values.filter(snapshot => snapshot.characterId === query[0]));
                            }
                            return request(values);
                        },
                    };
                },
            };
        },
    };
    Promise.resolve().then(() => {
        if (aborted) {
            transaction.error = transactionError;
            transaction.onerror?.();
            transaction.onabort?.();
            return;
        }
        if (names.includes("memories")) context.__memoryRecords = memoryWork;
        if (names.includes("memory_links")) context.__memoryLinks = linkWork;
        if (names.includes("core_compaction_snapshots")) context.__snapshots = snapshotWork;
        transaction.oncomplete?.();
    });
    return transaction;
}

context.__memoryDb = {
    version: 5,
    objectStoreNames: { contains: (name) => ["memories", "memory_links", "core_compaction_snapshots"].includes(name) },
    transaction: createTransaction,
    close() {},
};

const mockSources = new Map([
    [resolve(repoRoot, "lib/kv-db.ts"), "export function kvGet() { return null; } export function kvSet() {} export function registerKvMigration() {} export function registerDynamicPrefix() {}"],
    [resolve(repoRoot, "lib/idb-open.ts"), "export async function openIndexedDbAtLeast() { return globalThis.__memoryDb; }"],
    [resolve(repoRoot, "lib/memory-compat.ts"), "export function normalizeMemoryEntry(entry) { return { ...entry }; }"],
    [resolve(repoRoot, "lib/memory-recall-stats.ts"), "export function applyRecallStats(entry) { return { ...entry }; }"],
    [resolve(repoRoot, "lib/chat-db.ts"), "export async function dbWaitForMessagePersistence() { return true; }"],
]);

const moduleCache = new Map();

function sourceModulePath(specifier, referencingModule) {
    const basePath = resolve(dirname(referencingModule.identifier), specifier);
    return extname(basePath) ? basePath : basePath + ".ts";
}

async function loadModule(modulePath) {
    const normalizedPath = resolve(modulePath);
    if (moduleCache.has(normalizedPath)) return moduleCache.get(normalizedPath);
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

function memory(id, characterId, type = "core", overrides = {}) {
    return {
        id,
        characterId,
        sourceApp: "chat",
        type,
        content: id + " original",
        importance: 0.95,
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-01T00:00:00.000Z",
        tags: ["tag"],
        metadata: { keep: true },
        ...overrides,
    };
}

const storage = await loadModule(resolve(repoRoot, "lib/memory-storage.ts"));
await storage.evaluate();
const {
    saveMemoryEntries,
    saveMemoryLinks,
    loadRawCoreMemoryEntries,
    replaceCoreMemoriesWithSnapshot,
    loadLatestCoreCompactionSnapshot,
    restoreCoreCompactionSnapshot,
} = storage.namespace;

const legacyCore = memory("c1-a", "char-1");
delete legacyCore.tags;
delete legacyCore.kind;
delete legacyCore.accessCount;
delete legacyCore.stability;
const c1 = [legacyCore, memory("c1-b", "char-1", "core", { mood: "tender" })];
const c2 = [memory("c2-a", "char-2")];
const longTerm = memory("lt-1", "char-1", "long_term");
const preExistingLink = {
    id: "link-before-compaction",
    characterId: "char-1",
    fromMemoryId: "c1-a",
    toMemoryId: "lt-1",
    type: "temporal",
    strength: 0.7,
    createdAt: c1[0].createdAt,
    updatedAt: c1[0].updatedAt,
};
await saveMemoryEntries([...c1, ...c2, longTerm], { suppressMemoryLinkLifecycle: true });
await saveMemoryLinks([preExistingLink]);
const rawBeforeApply = await loadRawCoreMemoryEntries("char-1");
assert.deepEqual(rawBeforeApply, c1, "maintenance raw loader preserves legacy field absence");
assert.equal("tags" in rawBeforeApply[0], false);
assert.equal("kind" in rawBeforeApply[0], false);
assert.equal("accessCount" in rawBeforeApply[0], false);
assert.equal("stability" in rawBeforeApply[0], false);

const created = [
    memory("new-1", "char-1", "core", { content: "短事实一", createdAt: "2026-09-02T00:00:00.000Z" }),
    memory("new-2", "char-1", "core", { content: "短事实二", createdAt: "2026-09-02T00:00:00.000Z" }),
];
const snapshot = {
    runId: "run-1",
    characterId: "char-1",
    createdAt: "2026-09-02T00:00:00.000Z",
    compactedAt: "2026-09-02T00:00:00.000Z",
    originalEntries: clone(c1),
    createdMemoryIds: created.map(entry => entry.id),
};
await replaceCoreMemoriesWithSnapshot({ characterId: "char-1", snapshot, originalEntries: c1, newEntries: created });
assert.deepEqual([...context.__memoryRecords.values()].filter(entry => entry.characterId === "char-1" && entry.type === "core"), created);
assert.deepEqual(context.__memoryRecords.get("c2-a"), c2[0], "another character is untouched");
assert.deepEqual(context.__memoryRecords.get("lt-1"), longTerm, "long-term memories are untouched");
assert.deepEqual(context.__memoryLinks.get(preExistingLink.id), preExistingLink, "links are untouched");
assert.deepEqual(await loadLatestCoreCompactionSnapshot("char-1"), snapshot, "snapshot stores exact raw originals");
assert.deepEqual(
    (await loadLatestCoreCompactionSnapshot("char-1")).originalEntries,
    rawBeforeApply,
    "snapshot.originalEntries has no normalized fields",
);

const conflictRequest = {
    snapshot: { ...snapshot, runId: "run-conflict" },
    characterId: "char-1",
    originalEntries: created,
    newEntries: [memory("c2-a", "char-1", "core", { content: "must not overwrite c2" })],
};
await assert.rejects(
    replaceCoreMemoriesWithSnapshot(conflictRequest),
    /duplicate c2-a/,
    "deterministic ID conflict must abort the transaction",
);
assert.deepEqual(context.__memoryRecords.get("new-1"), created[0]);
assert.deepEqual(context.__memoryRecords.get("new-2"), created[1]);
assert.deepEqual(context.__memoryRecords.get("c2-a"), c2[0]);
assert.equal(context.__snapshots.has("run-conflict"), false);

const restored = await restoreCoreCompactionSnapshot("char-1", "run-1");
assert.ok(restored.restoredAt, "restore records that the snapshot is no longer active");
assert.deepEqual(context.__memoryRecords.get("c1-a"), c1[0]);
assert.deepEqual(context.__memoryRecords.get("c1-b"), c1[1]);
assert.deepEqual(await loadRawCoreMemoryEntries("char-1"), c1, "restore writes back exact raw records");
for (const field of ["tags", "kind", "accessCount", "stability"]) {
    assert.equal(field in context.__memoryRecords.get("c1-a"), false, `restore keeps legacy ${field} absent`);
}
assert.equal(context.__memoryRecords.has("new-1"), false);
assert.equal(context.__memoryRecords.has("new-2"), false);
assert.deepEqual(context.__memoryLinks.get(preExistingLink.id), preExistingLink, "Restore does not delete memory links");
assert.equal(await loadLatestCoreCompactionSnapshot("char-1"), null);

console.log("core memory compaction storage tests passed");
