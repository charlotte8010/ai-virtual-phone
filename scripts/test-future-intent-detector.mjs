import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
    const tempDir = await mkdtemp(join(process.cwd(), ".tmp-future-intent-"));
    const modulePath = join(tempDir, "module.mjs");
    await writeFile(modulePath, transpiled.outputText, "utf8");
    try {
        return await import(`${pathToFileURL(modulePath).href}?${Date.now()}`);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

const detector = await loadTypeScriptModule("lib/future-intent-detector.ts");
const memoryTypes = await loadTypeScriptModule("lib/memory-types.ts");

assert.equal(memoryTypes.DEFAULT_MEMORY_CONFIG.futureIntentEnabled, true);
assert.equal(detector.hasFutureIntentSignal("明晚八点一起看电影"), true);
assert.equal(detector.hasFutureIntentSignal("我答应周五陪你去医院"), true);
assert.equal(detector.hasFutureIntentSignal("明早八点叫我"), true);
assert.equal(detector.hasFutureIntentSignal("今晚提醒我"), true);
assert.equal(detector.hasFutureIntentSignal("刚才一起看了电影"), false);
assert.equal(detector.hasFutureIntentSignal("明天的天气不错"), false);

const event = {
    id: "chat_future_1",
    sourceApp: "chat",
    timestamp: "2026-08-31T14:00:00.000Z",
    content: "明晚八点一起看电影",
};
const timeContext = {
    now: new Date("2026-08-31T14:00:00.000Z"),
    timezone: "Asia/Shanghai",
};
const prompt = detector.buildFutureIntentPrompt(event, timeContext);
assert.match(prompt, /\[event_ref=chat_future_1\]/);
assert.match(prompt, /Asia\/Shanghai/);
assert.match(prompt, /memories/);

const vagueInput = {
    content: "以后想和你去北海道",
    tags: ["旅行"],
    importance: 0.7,
    kind: "future_intent",
    futureIntent: {
        type: "wish",
        status: "pending",
        timePrecision: "vague",
        targetAt: "2026-09-05T20:00:00+08:00",
        originalTimeExpression: "以后",
    },
};
const normalizedVague = detector.normalizeFutureIntentCandidate(vagueInput, timeContext);
assert.equal(normalizedVague?.futureIntent?.targetAt, undefined);
assert.equal(normalizedVague?.futureIntent?.originalTimeExpression, "以后");
assert.equal(vagueInput.futureIntent.targetAt, "2026-09-05T20:00:00+08:00");

const normalizedExact = detector.normalizeFutureIntentCandidate({
    ...vagueInput,
    content: "明晚八点一起看电影",
    futureIntent: {
        type: "plan",
        status: "pending",
        timePrecision: "exact",
        targetAt: "2026-09-01T20:00:00+08:00",
    },
}, timeContext);
assert.equal(normalizedExact?.futureIntent?.targetAt, "2026-09-01T20:00:00+08:00");
const normalizedInvalidExact = detector.normalizeFutureIntentCandidate({
    ...vagueInput,
    futureIntent: {
        type: "plan",
        status: "fulfilled",
        timePrecision: "exact",
        targetAt: "not-a-date",
    },
}, timeContext);
assert.equal(normalizedInvalidExact?.futureIntent?.status, "pending");
assert.equal(normalizedInvalidExact?.futureIntent?.timePrecision, "unknown");
assert.equal(normalizedInvalidExact?.futureIntent?.targetAt, undefined);
const normalizedInvalidRange = detector.normalizeFutureIntentCandidate({
    ...vagueInput,
    futureIntent: {
        type: "plan",
        timePrecision: "range",
        targetAt: "2026-09-05T20:00:00+08:00",
        targetEndAt: "2026-09-04T20:00:00+08:00",
    },
}, timeContext);
assert.equal(normalizedInvalidRange?.futureIntent?.timePrecision, "unknown");
assert.equal(normalizedInvalidRange?.futureIntent?.targetAt, undefined);
assert.equal(detector.normalizeFutureIntentCandidate({ ...vagueInput, kind: "event" }, timeContext), null);

const parsed = detector.parseFutureIntentModelOutput(JSON.stringify({
    memories: [{
        content: "用户和角色明晚八点一起看电影。",
        tags: ["电影", "约定"],
        importance: 0.9,
        kind: "future_intent",
        futureIntent: {
            type: "plan",
            status: "pending",
            targetAt: "2026-09-01T20:00:00+08:00",
            timezone: "Asia/Shanghai",
            timePrecision: "exact",
        },
    }],
}), event, timeContext);
assert.equal(parsed.length, 1);
assert.deepEqual(parsed[0].sourceEventRefs, [event.id]);
assert.equal(parsed[0].futureIntent?.timePrecision, "exact");
assert.deepEqual(detector.parseFutureIntentModelOutput("明晚八点一起看电影。", event, timeContext), []);

const entry = detector.buildFutureIntentMemoryEntry("char_1", event, parsed[0], new Date("2026-08-31T14:01:00.000Z"));
assert.equal(entry.type, "long_term");
assert.equal(entry.kind, "future_intent");
assert.equal(entry.sourceApp, "chat");
assert.deepEqual(entry.sourceMessageIds, [event.id]);
assert.equal(entry.metadata?.extractionMode, "immediate_future_intent");
assert.equal(entry.futureIntent?.status, "pending");

const sameEvent = { ...entry, id: "existing_1" };
assert.equal(detector.isFutureIntentDuplicate(entry, sameEvent), true);
const enrichedEntry = detector.buildFutureIntentMemoryEntry("char_1", {
    ...event,
    id: "chat_future_2",
    content: "周六晚上八点一起看电影",
    timestamp: "2026-09-01T14:00:00.000Z",
}, {
    ...parsed[0],
    content: "用户和角色周六晚上八点一起看电影。",
    futureIntent: {
        ...parsed[0].futureIntent,
        targetAt: "2026-09-05T20:00:00+08:00",
    },
}, new Date("2026-09-01T14:01:00.000Z"));
assert.equal(detector.isFutureIntentDuplicate(enrichedEntry, entry), true);
const merged = detector.mergeFutureIntentMemory(entry, enrichedEntry);
assert.equal(merged.content, enrichedEntry.content);
assert.equal(merged.futureIntent?.targetAt, "2026-09-05T20:00:00+08:00");
assert.deepEqual(merged.sourceMessageIds, [event.id, "chat_future_2"]);
const fulfilledCandidate = detector.buildFutureIntentMemoryEntry("char_1", {
    ...event,
    id: "chat_future_3",
}, {
    ...parsed[0],
    futureIntent: {
        ...parsed[0].futureIntent,
        status: "pending",
    },
}, new Date("2026-09-01T14:01:00.000Z"));
const lifecycleSafeMerge = detector.mergeFutureIntentMemory(entry, {
    ...fulfilledCandidate,
    futureIntent: { ...fulfilledCandidate.futureIntent, status: "fulfilled" },
});
assert.equal(lifecycleSafeMerge.futureIntent?.status, "pending");

const calls = [];
let releaseFirst;
const firstStarted = new Promise((resolve) => {
    releaseFirst = resolve;
});
const queue = detector.createFutureIntentDetectionQueue(async (characterId, queuedEvent) => {
    assert.equal(characterId, "char_queue");
    calls.push(queuedEvent.id);
    if (queuedEvent.id === "event_a") await firstStarted;
    return { status: "no_candidate" };
});
const eventA = { ...event, id: "event_a", content: "普通聊天" };
const eventB = { ...event, id: "event_b", content: "明晚八点一起看电影" };
const firstPromise = queue.enqueue("char_queue", eventA);
await Promise.resolve();
const secondPromise = queue.enqueue("char_queue", eventB);
assert.deepEqual(calls, ["event_a"]);
releaseFirst();
await Promise.all([firstPromise, secondPromise]);
assert.deepEqual(calls, ["event_a", "event_b"]);

console.log("future intent detector tests passed");
