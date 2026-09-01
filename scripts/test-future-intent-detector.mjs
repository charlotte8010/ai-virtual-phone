import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";

async function loadTypeScriptModule(relativePath) {
    const tempDir = await mkdtemp(join(process.cwd(), ".tmp-future-intent-"));
    const relativeModules = relativePath === "lib/future-intent-detector.ts"
        ? [relativePath, "lib/memory-extraction.ts"]
        : [relativePath];
    const moduleNames = new Map(relativeModules.map(item => [item, `${basename(item, ".ts")}.mjs`]));
    const modulePath = join(tempDir, moduleNames.get(relativePath));
    for (const dependencyPath of relativeModules) {
        const sourceUrl = new URL(`../${dependencyPath}`, import.meta.url);
        const source = await readFile(sourceUrl, "utf8");
        const transpiled = ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.ESNext,
                moduleResolution: ts.ModuleResolutionKind.Bundler,
            },
        });
        let output = transpiled.outputText;
        for (const [dependency, outputName] of moduleNames) {
            output = output.replaceAll(`./${basename(dependency, ".ts")}`, `./${outputName}`);
        }
        await writeFile(join(tempDir, moduleNames.get(dependencyPath)), output, "utf8");
    }
    try {
        return await import(`${pathToFileURL(modulePath).href}?${Date.now()}`);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

const detector = await loadTypeScriptModule("lib/future-intent-detector.ts");
const memoryTypes = await loadTypeScriptModule("lib/memory-types.ts");
const sourcePolicy = await loadTypeScriptModule("lib/memory-source-policy.ts");
const chatMemoryEvent = await loadTypeScriptModule("lib/chat-memory-event.ts");

assert.equal(memoryTypes.DEFAULT_MEMORY_CONFIG.futureIntentEnabled, true);
assert.equal(detector.hasFutureIntentSignal("明晚八点一起看电影"), true);
assert.equal(detector.hasFutureIntentSignal("我答应周五陪你去医院"), true);
assert.equal(detector.hasFutureIntentSignal("明早八点叫我"), true);
assert.equal(detector.hasFutureIntentSignal("今晚提醒我"), true);
assert.equal(detector.hasFutureIntentSignal("我会在项目结束后搬家"), true, "broad future modality must reach semantic detection");
assert.equal(detector.hasFutureIntentSignal("刚才一起看了电影"), false);
assert.equal(detector.hasFutureIntentSignal("明天的天气不错"), false);
for (const text of [
    "下次一起去吧",
    "改天带你去",
    "有空一起吃",
    "等你回来一起看",
    "等我忙完陪你",
    "毕业以后去旅行",
    "回来以后找你",
    "哪天一起去",
]) {
    assert.equal(detector.hasFutureIntentSignal(text), true, text);
}
assert.equal(detector.hasFutureIntentSignal("我想知道这个是什么意思"), false);

const persistedAssistant = {
    id: "chat_assistant_new",
    sessionId: "session_1",
    role: "assistant",
    content: "明早八点我叫你。",
    createdAt: "2026-08-31T15:00:00.000Z",
};
assert.deepEqual(chatMemoryEvent.toFutureIntentEvent(persistedAssistant), {
    id: persistedAssistant.id,
    sourceApp: "chat",
    sourceDetail: "direct",
    timestamp: persistedAssistant.createdAt,
    content: persistedAssistant.content,
    sessionId: persistedAssistant.sessionId,
});

const chatDbSource = await readFile(new URL("../lib/chat-db.ts", import.meta.url), "utf8");
const chatStorageSource = await readFile(new URL("../lib/chat-storage.ts", import.meta.url), "utf8");
const chatEngineSource = await readFile(new URL("../lib/chat-engine.ts", import.meta.url), "utf8");
const memoryStorageSource = await readFile(new URL("../lib/memory-storage.ts", import.meta.url), "utf8");
const detectorSource = await readFile(new URL("../lib/future-intent-detector.ts", import.meta.url), "utf8");
assert.match(chatStorageSource, /incrementEventCounter\(persistedSession\.contactId, toFutureIntentEvent\(newMsg\)\)/);
assert.match(chatDbSource, /dbWaitForMessagePersistence/);
assert.match(memoryStorageSource, /await dbWaitForMessagePersistence\(event\.id\)/);
assert.match(memoryStorageSource, /const resolvedCharacterId = contact\?\.characterId/);
assert.match(memoryStorageSource, /incrementEventCounterNow\(resolvedCharacterId, event\)/);
assert.doesNotMatch(chatEngineSource, /incrementEventCounter/);
assert.match(detectorSource, /isMemorySourceAllowed\(event\.sourceApp, event\.sourceDetail, config\.shortTermAllowedSources\)/);

assert.equal(sourcePolicy.isMemorySourceAllowed("xiaohongshu", undefined, { xiaohongshu: false }), false);
assert.equal(sourcePolicy.isMemorySourceAllowed("xiaohongshu", undefined, { xiaohongshu: true }), true);
assert.equal(sourcePolicy.isMemorySourceAllowed("chat", "group", { group_chat: false }), false);
assert.equal(sourcePolicy.isMemorySourceAllowed("chat", "direct", { chat: false }), false);

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
const eventTimeContext = detector.resolveFutureIntentTimeContext(
    event,
    "Asia/Shanghai",
    new Date("2030-01-01T00:00:00.000Z"),
);
assert.equal(eventTimeContext.now.toISOString(), event.timestamp);

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
assert.equal(normalizedInvalidRange?.futureIntent?.targetEndAt, undefined);
const normalizedMissingRangeStart = detector.normalizeFutureIntentCandidate({
    ...vagueInput,
    futureIntent: {
        type: "plan",
        timePrecision: "range",
        targetEndAt: "2026-09-05T20:00:00+08:00",
    },
}, timeContext);
assert.equal(normalizedMissingRangeStart?.futureIntent?.timePrecision, "unknown");
assert.equal(normalizedMissingRangeStart?.futureIntent?.targetAt, undefined);
assert.equal(normalizedMissingRangeStart?.futureIntent?.targetEndAt, undefined);
const normalizedMalformedRangeEnd = detector.normalizeFutureIntentCandidate({
    ...vagueInput,
    futureIntent: {
        type: "plan",
        timePrecision: "range",
        targetAt: "2026-09-04T20:00:00+08:00",
        targetEndAt: "not-a-date",
    },
}, timeContext);
assert.equal(normalizedMalformedRangeEnd?.futureIntent?.timePrecision, "unknown");
assert.equal(normalizedMalformedRangeEnd?.futureIntent?.targetAt, undefined);
assert.equal(normalizedMalformedRangeEnd?.futureIntent?.targetEndAt, undefined);
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
const directC3Creation = detector.buildFutureIntentMemoryEntry("char_1", event, {
    ...parsed[0],
    futureIntent: {
        ...parsed[0].futureIntent,
        status: "fulfilled",
        fulfilledAt: "2026-09-01T21:00:00.000Z",
        replacedByMemoryId: "should-not-survive-creation",
    },
}, new Date("2026-08-31T14:01:00.000Z"));
assert.equal(directC3Creation.futureIntent.status, "pending");
assert.equal(directC3Creation.futureIntent.fulfilledAt, undefined);
assert.equal(directC3Creation.futureIntent.replacedByMemoryId, undefined);

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
assert.equal(detector.isFutureIntentDuplicate(enrichedEntry, entry), false);
const sameTimeEntry = detector.buildFutureIntentMemoryEntry("char_1", {
    ...event,
    id: "chat_future_same_time",
    content: "明晚八点和你看一部电影",
}, {
    ...parsed[0],
    content: "用户和角色明晚八点一起看电影。",
}, new Date("2026-08-31T14:01:00.000Z"));
assert.equal(detector.isFutureIntentDuplicate(sameTimeEntry, entry), true);
const merged = detector.mergeFutureIntentMemory(entry, sameTimeEntry);
assert.equal(merged.content, entry.content);
assert.equal(merged.futureIntent?.targetAt, "2026-09-01T20:00:00+08:00");
assert.deepEqual(merged.sourceMessageIds, [event.id, "chat_future_same_time"]);
const dayEntry = detector.buildFutureIntentMemoryEntry("char_1", {
    ...event,
    id: "chat_future_day",
}, {
    ...parsed[0],
    futureIntent: {
        ...parsed[0].futureIntent,
        timePrecision: "day",
        targetAt: "2026-09-03T00:00:00+08:00",
    },
}, new Date("2026-08-31T14:01:00.000Z"));
const sameDayEntry = {
    ...dayEntry,
    id: "existing_same_day",
    futureIntent: { ...dayEntry.futureIntent, targetAt: "2026-09-03T20:00:00+08:00" },
    metadata: { ...dayEntry.metadata, sourceEventSignatures: ["char_1:chat:existing_same_day"] },
};
const differentDayEntry = {
    ...dayEntry,
    id: "existing_different_day",
    futureIntent: { ...dayEntry.futureIntent, targetAt: "2026-09-04T20:00:00+08:00" },
    metadata: { ...dayEntry.metadata, sourceEventSignatures: ["char_1:chat:existing_different_day"] },
};
assert.equal(detector.isFutureIntentDuplicate(dayEntry, sameDayEntry), true);
assert.equal(detector.isFutureIntentDuplicate(dayEntry, differentDayEntry), false);
const rangeEntry = detector.buildFutureIntentMemoryEntry("char_1", {
    ...event,
    id: "chat_future_range",
}, {
    ...parsed[0],
    futureIntent: {
        ...parsed[0].futureIntent,
        timePrecision: "range",
        targetAt: "2026-09-02T00:00:00+08:00",
        targetEndAt: "2026-09-04T00:00:00+08:00",
    },
}, new Date("2026-08-31T14:01:00.000Z"));
assert.equal(detector.isFutureIntentDuplicate(rangeEntry, dayEntry), true);
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
const repeatedPendingPromise = queue.enqueue("char_queue", eventB);
assert.strictEqual(repeatedPendingPromise, secondPromise);
assert.deepEqual(calls, ["event_a"]);
releaseFirst();
await Promise.all([firstPromise, secondPromise]);
assert.deepEqual(calls, ["event_a", "event_b"]);
assert.deepEqual(await queue.enqueue("char_queue", eventB), {
    status: "skipped",
    reason: "event_already_scanned",
});
assert.deepEqual(calls, ["event_a", "event_b"]);

const midnightContexts = [];
let releaseMidnightBlocker;
const midnightBlocker = new Promise((resolve) => {
    releaseMidnightBlocker = resolve;
});
const midnightQueue = detector.createFutureIntentDetectionQueue(async (_characterId, queuedEvent) => {
    if (queuedEvent.id === "midnight_blocker") await midnightBlocker;
    midnightContexts.push(detector.resolveFutureIntentTimeContext(
        queuedEvent,
        "Asia/Shanghai",
        new Date("2026-09-01T16:05:00.000Z"),
    ).now.toISOString());
    return { status: "no_candidate" };
});
const midnightBlockerEvent = {
    ...event,
    id: "midnight_blocker",
    timestamp: "2026-09-01T15:58:00.000Z",
    content: "普通聊天",
};
const queuedBeforeMidnight = {
    ...event,
    id: "midnight_tomorrow",
    timestamp: "2026-09-01T15:59:50.000Z",
    content: "明天一起吃饭",
};
const midnightFirst = midnightQueue.enqueue("char_midnight", midnightBlockerEvent);
await Promise.resolve();
const midnightSecond = midnightQueue.enqueue("char_midnight", queuedBeforeMidnight);
releaseMidnightBlocker();
await Promise.all([midnightFirst, midnightSecond]);
assert.equal(midnightContexts[1], queuedBeforeMidnight.timestamp);

console.log("future intent detector tests passed");
