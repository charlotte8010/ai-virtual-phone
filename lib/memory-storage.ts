// lib/memory-storage.ts
// IndexedDB persistence for long-term memory entries + short-term events + localStorage config.

import type { CoreCompactionSnapshot, MemoryEntry, MemoryConfig, MemoryLink } from "./memory-types";
import { DEFAULT_MEMORY_CONFIG } from "./memory-types";
import { kvGet, kvSet, registerKvMigration, registerDynamicPrefix } from "./kv-db";
import { openIndexedDbAtLeast } from "./idb-open";
import { normalizeMemoryEntry } from "./memory-compat";
import { applyRecallStats } from "./memory-recall-stats";
import type { FutureIntentEvent } from "./future-intent-detector";
import { dbWaitForMessagePersistence } from "./chat-db";

// ── Long-term memory DB (unchanged from v1) ──

const DB_NAME = "ai_phone_memory_db_v1";
const DB_VERSION = 5;
const STORE_NAME = "memories";
const LINK_STORE_NAME = "memory_links";
const CORE_COMPACTION_SNAPSHOT_STORE_NAME = "core_compaction_snapshots";

const CONFIG_KEY = "ai_phone_memory_config_v1";

export interface MemoryPersistenceOptions {
    /** Skip all post-save Cognitive Memory link work for imports/restores. */
    suppressMemoryLinkLifecycle?: boolean;
    /** Require the browser to flush a maintenance/import transaction before it reports success. */
    strictDurability?: boolean;
}

export interface CoreMemoryReplacementRequest {
    characterId: string;
    snapshot: CoreCompactionSnapshot;
    originalEntries: MemoryEntry[];
    newEntries: MemoryEntry[];
}

function hasBrowserApi(): boolean {
    return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

function hasObjectStore(db: IDBDatabase, name: string): boolean {
    // The fallback also keeps lightweight non-browser test doubles compatible;
    // real IndexedDB connections always expose objectStoreNames.contains().
    return typeof db.objectStoreNames?.contains === "function"
        ? db.objectStoreNames.contains(name)
        : true;
}

function ensureMemoryIndexes(store: IDBObjectStore): void {
    if (!store.indexNames.contains("by_character")) {
        store.createIndex("by_character", "characterId", { unique: false });
    }
    if (!store.indexNames.contains("by_character_type")) {
        store.createIndex("by_character_type", ["characterId", "type"], { unique: false });
    }
    if (!store.indexNames.contains("by_character_created")) {
        store.createIndex("by_character_created", ["characterId", "createdAt"], { unique: false });
    }
}

function ensureMemoryLinkIndexes(store: IDBObjectStore): void {
    if (!store.indexNames.contains("by_character")) {
        store.createIndex("by_character", "characterId", { unique: false });
    }
    if (!store.indexNames.contains("by_from_memory")) {
        store.createIndex("by_from_memory", ["characterId", "fromMemoryId"], { unique: false });
    }
    if (!store.indexNames.contains("by_to_memory")) {
        store.createIndex("by_to_memory", ["characterId", "toMemoryId"], { unique: false });
    }
    if (!store.indexNames.contains("by_character_type")) {
        store.createIndex("by_character_type", ["characterId", "type"], { unique: false });
    }
}

function ensureCoreCompactionSnapshotIndexes(store: IDBObjectStore): void {
    if (!store.indexNames.contains("by_character")) {
        store.createIndex("by_character", "characterId", { unique: false });
    }
    if (!store.indexNames.contains("by_character_compacted_at")) {
        store.createIndex("by_character_compacted_at", ["characterId", "compactedAt"], { unique: false });
    }
}

function upgradeMemorySchema(db: IDBDatabase, _oldVersion: number, tx: IDBTransaction | null): void {
    let store: IDBObjectStore;
    if (!db.objectStoreNames.contains(STORE_NAME)) {
        store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
    } else {
        store = tx!.objectStore(STORE_NAME);
    }
    ensureMemoryIndexes(store);

    let linkStore: IDBObjectStore;
    if (!db.objectStoreNames.contains(LINK_STORE_NAME)) {
        linkStore = db.createObjectStore(LINK_STORE_NAME, { keyPath: "id" });
    } else {
        linkStore = tx!.objectStore(LINK_STORE_NAME);
    }
    ensureMemoryLinkIndexes(linkStore);

    let snapshotStore: IDBObjectStore;
    if (!db.objectStoreNames.contains(CORE_COMPACTION_SNAPSHOT_STORE_NAME)) {
        snapshotStore = db.createObjectStore(CORE_COMPACTION_SNAPSHOT_STORE_NAME, { keyPath: "runId" });
    } else {
        snapshotStore = tx!.objectStore(CORE_COMPACTION_SNAPSHOT_STORE_NAME);
    }
    ensureCoreCompactionSnapshotIndexes(snapshotStore);
}

async function openDb(): Promise<IDBDatabase | null> {
    if (!hasBrowserApi()) return null;
    // Open at >= DB_VERSION: a backup restore may have bumped the stored version
    // higher, and opening at a fixed lower version would throw a VersionError.
    let db = await openIndexedDbAtLeast(DB_NAME, DB_VERSION, upgradeMemorySchema).catch(() => null);
    // Data restore can leave the database at a version above this module's
    // constant. If that restored schema predates the snapshot store, perform
    // one additional upgrade so Apply/Restore can remain one transaction.
    if (db && !hasObjectStore(db, CORE_COMPACTION_SNAPSHOT_STORE_NAME)) {
        const nextVersion = db.version + 1;
        db.close();
        db = await openIndexedDbAtLeast(DB_NAME, nextVersion, upgradeMemorySchema).catch(() => null);
    }
    return db;
}

function runRequest<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function scheduleMemoryLinkLifecycle(
    entries: readonly MemoryEntry[],
    options: MemoryPersistenceOptions = {},
): void {
    if (options.suppressMemoryLinkLifecycle) return;
    const longTermEntries = entries.filter(entry => entry.type === "long_term");
    if (longTermEntries.length === 0) return;

    void import("./memory-links")
        .then(({ scheduleMemoryLinkBackfillForCharacter, scheduleMemoryLinkGenerationForEntry }) => {
            for (const entry of longTermEntries) {
                try {
                    scheduleMemoryLinkGenerationForEntry(entry);
                } catch (error) {
                    console.warn("[MemoryLinks] Post-save generation scheduling failed:", error);
                }
            }

            const characterIds = new Set(longTermEntries.map(entry => entry.characterId));
            for (const characterId of characterIds) {
                try {
                    scheduleMemoryLinkBackfillForCharacter(characterId);
                } catch (error) {
                    console.warn("[MemoryLinks] Post-save backfill scheduling failed:", error);
                }
            }
        })
        .catch(error => console.warn("[MemoryLinks] Post-save generation unavailable:", error));
}

// ── Long-term Entry CRUD ──

export async function saveMemoryEntry(
    entry: MemoryEntry,
    options: MemoryPersistenceOptions = {},
): Promise<void> {
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).put(entry);
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    } finally {
        db.close();
    }
    scheduleMemoryLinkLifecycle([entry], options);
}

export async function loadMemoryEntries(characterId: string): Promise<MemoryEntry[]> {
    const db = await openDb();
    if (!db) return [];
    try {
        let entries: MemoryEntry[];
        try {
            const tx = db.transaction(STORE_NAME, "readonly");
            const store = tx.objectStore(STORE_NAME);
            const idx = store.index("by_character");
            entries = await runRequest(idx.getAll(characterId));
        } catch {
            const tx = db.transaction(STORE_NAME, "readonly");
            const allEntries: MemoryEntry[] = await runRequest(tx.objectStore(STORE_NAME).getAll());
            entries = allEntries.filter(entry => entry.characterId === characterId);
        }
        entries = entries.map(normalizeMemoryEntry);
        entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        return entries;
    } finally {
        db.close();
    }
}

export async function loadMemoryEntriesByType(
    characterId: string,
    type: MemoryEntry["type"],
): Promise<MemoryEntry[]> {
    const entries = await loadMemoryEntries(characterId);
    return entries.filter(entry => entry.type === type);
}

/** Maintenance-only raw Core loader; unlike ordinary reads it never normalizes legacy fields. */
export async function loadRawCoreMemoryEntries(characterId: string): Promise<MemoryEntry[]> {
    const db = await openDb();
    if (!db) return [];
    try {
        let entries: MemoryEntry[];
        try {
            const tx = db.transaction(STORE_NAME, "readonly");
            entries = await runRequest(
                tx.objectStore(STORE_NAME).index("by_character_type").getAll([characterId, "core"]),
            );
        } catch {
            const tx = db.transaction(STORE_NAME, "readonly");
            const allEntries: MemoryEntry[] = await runRequest(tx.objectStore(STORE_NAME).getAll());
            entries = allEntries.filter(entry => entry.characterId === characterId && entry.type === "core");
        }
        return entries
            .filter(entry => entry.characterId === characterId && entry.type === "core")
            .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    } finally {
        db.close();
    }
}

function exactRecordsFingerprint(entries: readonly MemoryEntry[]): string {
    return JSON.stringify(entries);
}

/** Replace one character's Core set and persist its exact rollback snapshot atomically. */
export async function replaceCoreMemoriesWithSnapshot(
    request: CoreMemoryReplacementRequest,
): Promise<void> {
    if (request.originalEntries.length === 0 || request.newEntries.length === 0) {
        throw new Error("核心记忆整理需要同时存在原始记录和候选记录");
    }
    if (request.snapshot.characterId !== request.characterId) {
        throw new Error("核心记忆整理快照角色不一致");
    }
    const db = await openDb();
    if (!db) throw new Error("记忆数据库不可用");
    try {
        if (!hasObjectStore(db, CORE_COMPACTION_SNAPSHOT_STORE_NAME)) {
            throw new Error("核心记忆整理快照仓库不可用");
        }
        const tx = db.transaction([STORE_NAME, CORE_COMPACTION_SNAPSHOT_STORE_NAME], "readwrite");
        const memoryStore = tx.objectStore(STORE_NAME);
        const snapshotStore = tx.objectStore(CORE_COMPACTION_SNAPSHOT_STORE_NAME);
        const completed = transactionDone(tx);
        let operationError: Error | null = null;
        const rawRequest = memoryStore.getAll();
        rawRequest.onsuccess = () => {
            try {
                const rawOriginalEntries = (rawRequest.result as MemoryEntry[])
                    .filter(entry => entry.characterId === request.characterId && entry.type === "core")
                    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
                if (exactRecordsFingerprint(rawOriginalEntries) !== exactRecordsFingerprint(request.originalEntries)) {
                    throw new Error("核心记忆在原子替换前发生变化，请重新预览");
                }

                const exactSnapshot: CoreCompactionSnapshot = {
                    ...request.snapshot,
                    originalEntries: rawOriginalEntries,
                };
                for (const entry of rawOriginalEntries) memoryStore.delete(entry.id);
                // add(), rather than put(), makes an unexpected deterministic ID
                // collision abort this transaction without overwriting existing data.
                for (const entry of request.newEntries) memoryStore.add(entry);
                snapshotStore.add(exactSnapshot);
            } catch (error) {
                operationError = error instanceof Error ? error : new Error(String(error));
                try {
                    tx.abort();
                } catch {
                    // The transaction may already have aborted itself.
                }
            }
        };
        rawRequest.onerror = () => {
            operationError = rawRequest.error ?? new Error("核心记忆原始记录读取失败");
            try {
                tx.abort();
            } catch {
                // The transaction may already have aborted itself.
            }
        };
        try {
            await completed;
        } catch (error) {
            throw operationError ?? error;
        }
    } finally {
        db.close();
    }
}

async function loadCoreCompactionSnapshotByRunId(runId: string): Promise<CoreCompactionSnapshot | null> {
    const db = await openDb();
    if (!db || !hasObjectStore(db, CORE_COMPACTION_SNAPSHOT_STORE_NAME)) {
        db?.close();
        return null;
    }
    try {
        const tx = db.transaction(CORE_COMPACTION_SNAPSHOT_STORE_NAME, "readonly");
        return await runRequest(tx.objectStore(CORE_COMPACTION_SNAPSHOT_STORE_NAME).get(runId)) ?? null;
    } finally {
        db.close();
    }
}

export async function loadLatestCoreCompactionSnapshot(
    characterId: string,
): Promise<CoreCompactionSnapshot | null> {
    const db = await openDb();
    if (!db || !hasObjectStore(db, CORE_COMPACTION_SNAPSHOT_STORE_NAME)) {
        db?.close();
        return null;
    }
    try {
        const tx = db.transaction(CORE_COMPACTION_SNAPSHOT_STORE_NAME, "readonly");
        let snapshots: CoreCompactionSnapshot[];
        try {
            snapshots = await runRequest(
                tx.objectStore(CORE_COMPACTION_SNAPSHOT_STORE_NAME)
                    .index("by_character_compacted_at")
                    .getAll(IDBKeyRange.bound([characterId, ""], [characterId, "\uffff"])),
            );
        } catch {
            snapshots = (await runRequest(
                tx.objectStore(CORE_COMPACTION_SNAPSHOT_STORE_NAME).getAll(),
            )).filter(snapshot => snapshot.characterId === characterId);
        }
        return snapshots
            .filter(snapshot => !snapshot.restoredAt)
            .sort((left, right) => right.compactedAt.localeCompare(left.compactedAt))[0] ?? null;
    } finally {
        db.close();
    }
}

/** Restore one snapshot without touching links, long-term memory, Chat, or Story data. */
export async function restoreCoreCompactionSnapshot(
    characterId: string,
    runId?: string,
): Promise<CoreCompactionSnapshot> {
    const snapshot = runId
        ? await loadCoreCompactionSnapshotByRunId(runId)
        : await loadLatestCoreCompactionSnapshot(characterId);
    if (!snapshot || snapshot.characterId !== characterId || snapshot.restoredAt) {
        throw new Error("没有可恢复的核心记忆整理快照");
    }

    const db = await openDb();
    if (!db) throw new Error("记忆数据库不可用");
    try {
        const tx = db.transaction([STORE_NAME, CORE_COMPACTION_SNAPSHOT_STORE_NAME], "readwrite");
        const memoryStore = tx.objectStore(STORE_NAME);
        const snapshotStore = tx.objectStore(CORE_COMPACTION_SNAPSHOT_STORE_NAME);
        for (const id of snapshot.createdMemoryIds) memoryStore.delete(id);
        // add() protects any unrelated record that happens to reuse an old ID.
        for (const entry of snapshot.originalEntries) memoryStore.add(entry);
        const restoredSnapshot: CoreCompactionSnapshot = {
            ...snapshot,
            originalEntries: snapshot.originalEntries.map(entry => ({ ...entry })),
            createdMemoryIds: [...snapshot.createdMemoryIds],
            restoredAt: new Date().toISOString(),
        };
        snapshotStore.put(restoredSnapshot);
        await transactionDone(tx);
        return restoredSnapshot;
    } finally {
        db.close();
    }
}

// ── Memory Link CRUD ──

export async function saveMemoryLink(link: MemoryLink): Promise<void> {
    await saveMemoryLinks([link]);
}

export async function saveMemoryLinks(
    links: MemoryLink[],
    options: Pick<MemoryPersistenceOptions, "strictDurability"> = {},
): Promise<void> {
    if (links.length === 0) return;
    const db = await openDb();
    if (!db) {
        if (hasBrowserApi()) throw new Error("Memory database is unavailable");
        return;
    }
    try {
        const tx = db.transaction(
            LINK_STORE_NAME,
            "readwrite",
            options.strictDurability ? { durability: "strict" } : undefined,
        );
        const store = tx.objectStore(LINK_STORE_NAME);
        for (const link of links) store.put(link);
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("Memory link batch write failed"));
            tx.onabort = () => reject(tx.error ?? new Error("Memory link batch write aborted"));
        });
    } finally {
        db.close();
    }
}

export async function loadMemoryLinks(characterId: string): Promise<MemoryLink[]> {
    const db = await openDb();
    if (!db) return [];
    try {
        let links: MemoryLink[];
        try {
            const tx = db.transaction(LINK_STORE_NAME, "readonly");
            links = await runRequest(tx.objectStore(LINK_STORE_NAME).index("by_character").getAll(characterId));
        } catch {
            const tx = db.transaction(LINK_STORE_NAME, "readonly");
            const allLinks: MemoryLink[] = await runRequest(tx.objectStore(LINK_STORE_NAME).getAll());
            links = allLinks.filter(link => link.characterId === characterId);
        }
        return links.sort((left, right) => (
            left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id)
        ));
    } finally {
        db.close();
    }
}

export async function deleteMemoryLinks(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(LINK_STORE_NAME, "readwrite");
        const store = tx.objectStore(LINK_STORE_NAME);
        for (const id of ids) store.delete(id);
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("Memory link delete failed"));
            tx.onabort = () => reject(tx.error ?? new Error("Memory link delete aborted"));
        });
    } finally {
        db.close();
    }
}

/** Best-effort orphan cleanup; callers keep it off the primary write path. */
export async function deleteMemoryLinksForMemoryIds(memoryIds: readonly string[]): Promise<void> {
    const ids = new Set(memoryIds.filter(id => typeof id === "string" && id.length > 0));
    if (ids.size === 0) return;
    const db = await openDb();
    if (!db) return;
    try {
        const readTx = db.transaction(LINK_STORE_NAME, "readonly");
        const links: MemoryLink[] = await runRequest(readTx.objectStore(LINK_STORE_NAME).getAll());
        const orphanLinkIds = links
            .filter(link => ids.has(link.fromMemoryId) || ids.has(link.toMemoryId))
            .map(link => link.id);
        if (orphanLinkIds.length === 0) return;
        const writeTx = db.transaction(LINK_STORE_NAME, "readwrite");
        const store = writeTx.objectStore(LINK_STORE_NAME);
        for (const id of orphanLinkIds) store.delete(id);
        await new Promise<void>((resolve, reject) => {
            writeTx.oncomplete = () => resolve();
            writeTx.onerror = () => reject(writeTx.error ?? new Error("Memory link orphan cleanup failed"));
            writeTx.onabort = () => reject(writeTx.error ?? new Error("Memory link orphan cleanup aborted"));
        });
    } finally {
        db.close();
    }
}

/** Persist lifecycle changes, including old/new replacement pairs, atomically. */
export async function saveMemoryEntries(
    entries: MemoryEntry[],
    options: MemoryPersistenceOptions = {},
): Promise<void> {
    if (entries.length === 0) return;
    const db = await openDb();
    if (!db) {
        if (hasBrowserApi()) throw new Error("Memory database is unavailable");
        return;
    }
    try {
        const tx = db.transaction(
            STORE_NAME,
            "readwrite",
            options.strictDurability ? { durability: "strict" } : undefined,
        );
        const store = tx.objectStore(STORE_NAME);
        for (const entry of entries) store.put(entry);
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("Memory batch write failed"));
            tx.onabort = () => reject(tx.error ?? new Error("Memory batch write aborted"));
        });
    } finally {
        db.close();
    }
    scheduleMemoryLinkLifecycle(entries, options);
}

/** Update selected long-term memories atomically after they were injected into a prompt. */
export async function updateMemoryRecallStats(
    characterId: string,
    memoryIds: readonly string[],
    recalledAt: string,
    memoryStabilityEnabled?: boolean,
): Promise<void> {
    const selectedIds = new Set(memoryIds);
    if (selectedIds.size === 0) return;

    const db = await openDb();
    if (!db) {
        if (hasBrowserApi()) throw new Error("Memory database is unavailable");
        return;
    }
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        const entries = await runRequest(
            store.index("by_character_type").getAll([characterId, "long_term"]),
        ) as MemoryEntry[];
        for (const entry of entries) {
            if (entry.characterId !== characterId || entry.type !== "long_term" || !selectedIds.has(entry.id)) {
                continue;
            }
            store.put(applyRecallStats(normalizeMemoryEntry(entry), recalledAt, { memoryStabilityEnabled }));
        }
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("Memory recall stats transaction failed"));
            tx.onabort = () => reject(tx.error ?? new Error("Memory recall stats transaction aborted"));
        });
    } finally {
        db.close();
    }
}

export async function deleteMemoryEntry(id: string): Promise<void> {
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).delete(id);
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    } finally {
        db.close();
    }
    void deleteMemoryLinksForMemoryIds([id])
        .catch(error => console.warn("[MemoryLinks] Orphan cleanup failed after memory delete:", error));
}

export async function deleteMemoryEntries(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        for (const id of ids) {
            store.delete(id);
        }
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
    } finally {
        db.close();
    }
    void deleteMemoryLinksForMemoryIds(ids)
        .catch(error => console.warn("[MemoryLinks] Orphan cleanup failed after memory delete:", error));
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error ?? new Error("Memory transaction failed"));
        transaction.onabort = () => reject(transaction.error ?? new Error("Memory transaction aborted"));
    });
}

/** Delete entries without touching links owned by another lifecycle or migration. */
export async function deleteMemoryEntriesWithoutLinkCleanup(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await openDb();
    if (!db) return;
    try {
        const tx = db.transaction(STORE_NAME, "readwrite");
        const store = tx.objectStore(STORE_NAME);
        for (const id of ids) store.delete(id);
        await new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("Memory migration delete failed"));
            tx.onabort = () => reject(tx.error ?? new Error("Memory migration delete aborted"));
        });
    } finally {
        db.close();
    }
}

export async function deleteCharacterMemories(characterId: string): Promise<void> {
    const entries = await loadMemoryEntries(characterId);
    await deleteMemoryEntries(entries.map(e => e.id));
}

export async function deleteCharacterMemoriesByType(
    characterId: string,
    type: MemoryEntry["type"],
): Promise<void> {
    const entries = await loadMemoryEntriesByType(characterId, type);
    await deleteMemoryEntries(entries.map(e => e.id));
}

export async function getAllCharacterIdsWithMemories(): Promise<string[]> {
    const db = await openDb();
    if (!db) return [];
    try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const entries: MemoryEntry[] = await runRequest(tx.objectStore(STORE_NAME).getAll());
        const ids = new Set<string>();
        for (const e of entries) ids.add(e.characterId);
        return Array.from(ids);
    } finally {
        db.close();
    }
}

export async function getMemoryCount(characterId: string): Promise<number> {
    const entries = await loadMemoryEntries(characterId);
    return entries.length;
}

export async function getMemoryCountByType(
    characterId: string,
    type: MemoryEntry["type"],
): Promise<number> {
    const entries = await loadMemoryEntriesByType(characterId, type);
    return entries.length;
}

// ── Config (localStorage for fast sync access) ──

export function loadMemoryConfig(): MemoryConfig {
    if (typeof window === "undefined") return { ...DEFAULT_MEMORY_CONFIG };
    try {
        const raw = kvGet(CONFIG_KEY);
        if (!raw) return { ...DEFAULT_MEMORY_CONFIG };
        return { ...DEFAULT_MEMORY_CONFIG, ...JSON.parse(raw) };
    } catch {
        return { ...DEFAULT_MEMORY_CONFIG };
    }
}

export function saveMemoryConfig(config: MemoryConfig): void {
    if (typeof window === "undefined") return;
    kvSet(CONFIG_KEY, JSON.stringify(config));
}

// ── Per-character event counter (localStorage) ──

const EVENT_COUNTER_PREFIX = "ai_phone_mem_evt_count_";
const LAST_SUMMARY_TS_PREFIX = "ai_phone_mem_last_sum_";
const CORE_COUNTER_PREFIX = "ai_phone_mem_core_count_";
const LAST_CORE_SUMMARY_TS_PREFIX = "ai_phone_mem_last_core_sum_";
registerKvMigration(CONFIG_KEY);
registerDynamicPrefix(EVENT_COUNTER_PREFIX);
registerDynamicPrefix(LAST_SUMMARY_TS_PREFIX);
registerDynamicPrefix(CORE_COUNTER_PREFIX);
registerDynamicPrefix(LAST_CORE_SUMMARY_TS_PREFIX);

export function getEventCounter(characterId: string): number {
    if (typeof window === "undefined") return 0;
    const val = kvGet(EVENT_COUNTER_PREFIX + characterId);
    return val ? parseInt(val, 10) || 0 : 0;
}

function incrementEventCounterNow(characterId: string, event: FutureIntentEvent): number {
    const next = getEventCounter(characterId) + 1;
    if (typeof window !== "undefined") {
        kvSet(EVENT_COUNTER_PREFIX + characterId, String(next));
        void (async () => {
            let lifecycleResult: { status?: string } | undefined;
            try {
                const { maybeRunFutureIntentLifecycle } = await import("./future-intent-lifecycle");
                lifecycleResult = await maybeRunFutureIntentLifecycle(characterId, event);
            } catch (error) {
                console.warn("[FutureIntentLifecycle] Event evaluation failed; continuing with creation detection", error);
            }
            if (lifecycleResult?.status === "replaced") return;
            try {
                const { maybeRunFutureIntentDetection } = await import("./future-intent-detector");
                await maybeRunFutureIntentDetection(characterId, event);
            } catch (error) {
                console.warn("[FutureIntent] Immediate detection failed:", error);
            }
        })()
            .catch(error => console.warn("[FutureIntent] Immediate detection failed:", error));
    }
    return next;
}

export function incrementEventCounter(characterId: string, event: FutureIntentEvent): number {
    if (
        typeof window !== "undefined"
        && event.sourceApp === "chat"
        && event.sourceDetail === "direct"
        && event.sessionId
    ) {
        const predictedNext = getEventCounter(characterId) + 1;
        void (async () => {
            // Chat must use the exact persisted message, never a guessed latest assistant.
            if (!await dbWaitForMessagePersistence(event.id)) return;

            const [{ loadChatSessions, loadChatContacts }, { loadCharacters }] = await Promise.all([
                import("./chat-storage"),
                import("./character-storage"),
            ]);
            const session = loadChatSessions().find(item => item.id === event.sessionId);
            if (!session || session.isGroup) return;
            const contact = loadChatContacts().find(item => item.id === session.contactId);
            const resolvedCharacterId = contact?.characterId
                || loadCharacters().find(item => item.id === session.contactId)?.id;
            if (!resolvedCharacterId) return;

            incrementEventCounterNow(resolvedCharacterId, event);
        })()
            .catch(error => console.warn("[FutureIntent] Persisted chat event detection failed:", error));
        return predictedNext;
    }

    return incrementEventCounterNow(characterId, event);
}

export function resetEventCounter(characterId: string): void {
    if (typeof window === "undefined") return;
    kvSet(EVENT_COUNTER_PREFIX + characterId, "0");
}

export function getLastSummarizedTimestamp(characterId: string): string | null {
    if (typeof window === "undefined") return null;
    return kvGet(LAST_SUMMARY_TS_PREFIX + characterId) || null;
}

export function setLastSummarizedTimestamp(characterId: string, ts: string): void {
    if (typeof window === "undefined") return;
    kvSet(LAST_SUMMARY_TS_PREFIX + characterId, ts);
}

export function getCoreMemoryCounter(characterId: string): number {
    if (typeof window === "undefined") return 0;
    const val = kvGet(CORE_COUNTER_PREFIX + characterId);
    return val ? parseInt(val, 10) || 0 : 0;
}

export function incrementCoreMemoryCounter(characterId: string): number {
    const next = getCoreMemoryCounter(characterId) + 1;
    if (typeof window !== "undefined") {
        kvSet(CORE_COUNTER_PREFIX + characterId, String(next));
    }
    return next;
}

export function resetCoreMemoryCounter(characterId: string): void {
    if (typeof window === "undefined") return;
    kvSet(CORE_COUNTER_PREFIX + characterId, "0");
}

export function getLastCoreSummarizedTimestamp(characterId: string): string | null {
    if (typeof window === "undefined") return null;
    return kvGet(LAST_CORE_SUMMARY_TS_PREFIX + characterId) || null;
}

export function setLastCoreSummarizedTimestamp(characterId: string, ts: string): void {
    if (typeof window === "undefined") return;
    kvSet(LAST_CORE_SUMMARY_TS_PREFIX + characterId, ts);
}
