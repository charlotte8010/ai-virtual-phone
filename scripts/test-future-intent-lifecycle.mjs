import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";

async function loadTypeScriptModule(relativePath) {
    const sourceUrl = new URL(`../${relativePath}`, import.meta.url);
    const source = await readFile(sourceUrl, "utf8");
    const transpiled = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
        },
    });
    const tempDir = await mkdtemp(join(process.cwd(), ".tmp-future-intent-lifecycle-"));
    const modulePath = join(tempDir, "module.mjs");
    await writeFile(modulePath, transpiled.outputText, "utf8");
    try {
        return await import(`${pathToFileURL(modulePath).href}?${Date.now()}`);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

const lifecycle = await loadTypeScriptModule("lib/future-intent-lifecycle.ts");

function memory(id, futureIntent, overrides = {}) {
    return {
        id,
        characterId: "char-1",
        sourceApp: "chat",
        type: "long_term",
        content: "明晚八点一起看电影",
        importance: 0.8,
        createdAt: "2026-09-01T12:00:00.000Z",
        updatedAt: "2026-09-01T12:00:00.000Z",
        kind: "future_intent",
        futureIntent,
        metadata: { sourceEventSignatures: [`char-1:chat:${id}-source`] },
        ...overrides,
    };
}

function event(id, content, timestamp = "2026-09-05T12:00:00.000Z", sessionId) {
    return { id, sourceApp: "chat", sourceDetail: "direct", timestamp, content, ...(sessionId ? { sessionId } : {}) };
}

const exactOverdue = memory("exact-overdue", {
    type: "plan", status: "pending", timePrecision: "exact", targetAt: "2026-09-05T11:59:00.000Z",
});
assert.equal(lifecycle.decideFutureIntentTimeTransition(exactOverdue, new Date("2026-09-05T12:00:00.000Z"), "Asia/Shanghai").action, "overdue");

const rangePending = memory("range-pending", {
    type: "plan", status: "pending", timePrecision: "range",
    targetAt: "2026-09-04T00:00:00.000Z", targetEndAt: "2026-09-06T00:00:00.000Z",
});
assert.equal(lifecycle.decideFutureIntentTimeTransition(rangePending, new Date("2026-09-05T12:00:00.000Z"), "Asia/Shanghai").action, "none");

const rangeOverdue = memory("range-overdue", {
    type: "plan", status: "pending", timePrecision: "range",
    targetAt: "2026-09-04T00:00:00.000Z", targetEndAt: "2026-09-05T11:59:00.000Z",
});
assert.equal(lifecycle.decideFutureIntentTimeTransition(rangeOverdue, new Date("2026-09-05T12:00:00.000Z"), "Asia/Shanghai").action, "overdue");

for (const precision of ["vague", "unknown"]) {
    const vague = memory(`vague-${precision}`, {
        type: "wish", status: "pending", timePrecision: precision, targetAt: "2020-01-01T00:00:00.000Z",
    });
    assert.equal(lifecycle.decideFutureIntentTimeTransition(vague, new Date("2026-09-05T12:00:00.000Z"), "Asia/Shanghai").action, "none");
}

const invalidTarget = memory("invalid-target", {
    type: "plan", status: "pending", timePrecision: "exact", targetAt: "not-a-date",
});
assert.equal(lifecycle.decideFutureIntentTimeTransition(invalidTarget, new Date("2026-09-05T12:00:00.000Z"), "Asia/Shanghai").action, "none");

const dayIntent = memory("day-boundary", {
    type: "plan", status: "pending", timePrecision: "day", targetAt: "2026-09-02T00:00:00+08:00", timezone: "Asia/Shanghai",
});
assert.equal(lifecycle.decideFutureIntentTimeTransition(dayIntent, new Date("2026-09-02T15:59:59.000Z"), "Asia/Shanghai").action, "none");
assert.equal(lifecycle.decideFutureIntentTimeTransition(dayIntent, new Date("2026-09-02T16:00:00.000Z"), "Asia/Shanghai").action, "overdue");

const targetPast = memory("target-past", {
    type: "plan", status: "pending", timePrecision: "exact", targetAt: "2026-09-01T12:00:00.000Z",
});
const ordinary = lifecycle.decideFutureIntentTransition(targetPast, event("ordinary", "今天午饭吃了什么？"), { timezone: "Asia/Shanghai" });
assert.equal(ordinary.action, "overdue");
assert.notEqual(ordinary.action, "fulfilled");

const fulfilled = lifecycle.decideFutureIntentTransition(
    memory("fulfill", { type: "plan", status: "pending", timePrecision: "exact", targetAt: "2026-09-06T12:00:00.000Z" }),
    event("fulfilled-event", "电影看完了，已经完成了"),
    { timezone: "Asia/Shanghai" },
);
assert.equal(fulfilled.action, "fulfilled");
assert.equal(fulfilled.nextEntry.futureIntent.status, "fulfilled");
assert.equal(fulfilled.nextEntry.futureIntent.fulfilledAt, "2026-09-05T12:00:00.000Z");
assert.equal(fulfilled.nextEntry.metadata.futureIntentLifecycle.eventId, "fulfilled-event");

const cancelled = lifecycle.decideFutureIntentTransition(
    memory("cancel", { type: "plan", status: "pending", timePrecision: "exact", targetAt: "2026-09-06T12:00:00.000Z" }, { content: "明天一起去约会" }),
    event("cancel-event", "明天那个约会取消了"),
    { timezone: "Asia/Shanghai" },
);
assert.equal(cancelled.action, "cancelled");
assert.equal(cancelled.nextEntry.futureIntent.status, "cancelled");
assert.equal(cancelled.nextEntry.futureIntent.cancelledAt, "2026-09-05T12:00:00.000Z");

const unrelated = lifecycle.decideFutureIntentTransition(
    memory("unrelated", { type: "plan", status: "pending", timePrecision: "exact", targetAt: "2026-09-06T12:00:00.000Z" }),
    event("unrelated-event", "今天下雨了"),
    { timezone: "Asia/Shanghai" },
);
assert.equal(unrelated.action, "none");

const replacement = lifecycle.decideFutureIntentTransition(
    memory("replace", { type: "plan", status: "pending", timePrecision: "exact", targetAt: "2026-09-06T12:00:00.000Z" }, { content: "明天一起看电影" }),
    event("reschedule-event", "电影改到 2026-09-10 20:00"),
    { timezone: "Asia/Shanghai" },
);
assert.equal(replacement.action, "replaced");
assert.equal(replacement.nextEntry.futureIntent.status, "cancelled");
assert.equal(replacement.nextEntry.futureIntent.replacedByMemoryId, replacement.replacementEntry.id);
assert.equal(replacement.replacementEntry.futureIntent.status, "pending");
assert.equal(replacement.replacementEntry.futureIntent.targetAt, "2026-09-10T12:00:00.000Z");
assert.equal(replacement.replacementEntry.futureIntent.originalTimeExpression, "2026-09-10 20:00");
assert.deepEqual(replacement.replacementEntry.sourceMessageIds, ["reschedule-event"]);

const repeated = lifecycle.decideFutureIntentTransition(
    fulfilled.nextEntry,
    event("fulfilled-event", "电影看完了，已经完成了"),
    { timezone: "Asia/Shanghai" },
);
assert.equal(repeated.action, "none");
assert.equal(lifecycle.decideFutureIntentTransition(fulfilled.nextEntry, event("later", "电影取消了"), { timezone: "Asia/Shanghai" }).action, "none");
assert.equal(lifecycle.decideFutureIntentTransition(cancelled.nextEntry, event("later-2", "电影看完了"), { timezone: "Asia/Shanghai" }).action, "none");

const replacementStoreEntries = [memory("stored-replace", { type: "plan", status: "pending", timePrecision: "exact", targetAt: "2026-09-06T12:00:00.000Z" }, { content: "明天一起看电影" })];
let replacementWrites = [];
const replacementStore = {
    async loadMemoryEntriesByType() { return replacementStoreEntries; },
    async saveMemoryEntries(entries) { replacementWrites.push(entries); replacementStoreEntries.splice(0, replacementStoreEntries.length, ...entries); },
};
const replacementRun = await lifecycle.runFutureIntentLifecycle("char-1", event("run-replace", "电影改到 2026-09-10 20:00"), {
    store: replacementStore,
    timezone: "Asia/Shanghai",
});
assert.equal(replacementRun.status, "replaced");
assert.equal(replacementWrites.length, 1);
assert.equal(replacementStoreEntries.filter(entry => entry.futureIntent.status === "pending").length, 1);
assert.equal(replacementStoreEntries.find(entry => entry.id === "stored-replace").futureIntent.replacedByMemoryId !== undefined, true);
const repeatedRun = await lifecycle.runFutureIntentLifecycle("char-1", event("run-replace", "电影改到 2026-09-10 20:00"), {
    store: replacementStore,
    timezone: "Asia/Shanghai",
});
assert.equal(repeatedRun.status, "no_change");
assert.equal(replacementWrites.length, 1);

const sharedSessionEntries = [
    memory("shared-session-one", { type: "plan", status: "pending", timePrecision: "exact", targetAt: "2026-09-10T12:00:00.000Z" }, {
        content: "明天一起看电影",
        metadata: { sourceSessionIds: ["session-shared"] },
    }),
    memory("shared-session-two", { type: "plan", status: "pending", timePrecision: "exact", targetAt: "2026-09-10T12:00:00.000Z" }, {
        content: "明天一起去约会",
        metadata: { sourceSessionIds: ["session-shared"] },
    }),
];
let sharedSessionWrites = [];
const sharedSessionStore = {
    async loadMemoryEntriesByType() { return sharedSessionEntries; },
    async saveMemoryEntries(entries) { sharedSessionWrites.push(entries); },
};
const sharedCancelEvent = event("shared-cancel", "算了不去看电影", "2026-09-05T12:00:00.000Z", "session-shared");
assert.equal(lifecycle.decideFutureIntentTransition(sharedSessionEntries[0], sharedCancelEvent, { timezone: "Asia/Shanghai" }).action, "cancelled");
const sharedSessionRun = await lifecycle.runFutureIntentLifecycle("char-1", sharedCancelEvent, {
    store: sharedSessionStore,
    timezone: "Asia/Shanghai",
});
assert.equal(sharedSessionRun.status, "cancelled");
assert.equal(sharedSessionWrites[0].filter(entry => entry.futureIntent.status === "cancelled").length, 1);

let failureWrites = 0;
const failingStore = {
    async loadMemoryEntriesByType() { return [targetPast]; },
    async saveMemoryEntries() { failureWrites += 1; throw new Error("simulated lifecycle write failure"); },
};
const failedRun = await lifecycle.runFutureIntentLifecycle("char-1", event("maintenance-event", "普通聊天"), {
    store: failingStore,
    timezone: "Asia/Shanghai",
});
assert.equal(failedRun.status, "write_failed");
assert.equal(failureWrites, 1);

const maintenanceEntries = [targetPast];
let maintenanceWrites = [];
const maintenanceStore = {
    async loadMemoryEntriesByType() { return maintenanceEntries; },
    async saveMemoryEntries(entries) { maintenanceWrites.push(entries); maintenanceEntries.splice(0, maintenanceEntries.length, ...entries); },
};
const maintenanceRun = await lifecycle.maintainFutureIntentLifecycle("char-1", new Date("2026-09-05T12:00:00.000Z"), {
    store: maintenanceStore,
    timezone: "Asia/Shanghai",
});
assert.equal(maintenanceRun.status, "overdue");
assert.equal(maintenanceEntries[0].futureIntent.status, "overdue");
assert.equal(maintenanceWrites.length, 1);

const memoryServiceSource = await readFile(new URL("../lib/memory-service.ts", import.meta.url), "utf8");
const promptAssemblerSource = await readFile(new URL("../lib/llm-prompt-assembler.ts", import.meta.url), "utf8");
const migrationSource = await readFile(new URL("../lib/data-management/idb.ts", import.meta.url), "utf8");
const memoryStorageSource = await readFile(new URL("../lib/memory-storage.ts", import.meta.url), "utf8");
const chatStorageSource = await readFile(new URL("../lib/chat-storage.ts", import.meta.url), "utf8");
const groupChatSource = await readFile(new URL("../lib/group-chat-engine.ts", import.meta.url), "utf8");
assert.doesNotMatch(memoryServiceSource, /runFutureIntentLifecycle|saveMemoryEntries/);
assert.doesNotMatch(promptAssemblerSource, /runFutureIntentLifecycle|saveMemoryEntries/);
assert.doesNotMatch(migrationSource, /runFutureIntentLifecycle|saveMemoryEntries/);
assert.match(memoryStorageSource, /maybeRunFutureIntentLifecycle/);
assert.match(memoryStorageSource, /lifecycleResult\?\.status === "replaced"/);
assert.match(chatStorageSource, /incrementEventCounter\(persistedSession\.contactId, toFutureIntentEvent\(newMsg\)\)/);
assert.match(groupChatSource, /incrementEventCounter\(characterId, \{/);

console.log("future intent lifecycle tests passed");
