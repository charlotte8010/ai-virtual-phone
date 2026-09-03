import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";

async function loadTypeScriptModule(relativePath) {
    const source = await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
    const transpiled = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
        },
    });
    const tempDir = await mkdtemp(join(process.cwd(), ".tmp-weixin-cognitive-"));
    const modulePath = join(tempDir, "module.mjs");
    await writeFile(modulePath, transpiled.outputText, "utf8");
    try {
        return await import(`${pathToFileURL(modulePath).href}?${Date.now()}`);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

async function loadCognitiveIngestionWithStubs() {
    const tempDir = await mkdtemp(join(process.cwd(), ".tmp-weixin-cognitive-"));
    const source = await readFile(new URL("../lib/cognitive-memory-ingestion.ts", import.meta.url), "utf8");
    const transpiled = ts.transpileModule(source, {
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
        },
    });
    const output = transpiled.outputText
        .replaceAll("./memory-storage", "./memory-storage.mjs")
        .replaceAll("./chat-db", "./chat-db.mjs")
        .replaceAll("./chat-memory-event", "./chat-memory-event.mjs")
        .replaceAll("./memory-summarizer", "./memory-summarizer.mjs");
    await writeFile(join(tempDir, "module.mjs"), output, "utf8");
    await writeFile(join(tempDir, "memory-storage.mjs"), `
export function incrementEventCounter(characterId, event, options) {
    globalThis.__weixinCognitiveCounters.push({
        mode: options?.persistenceConfirmed ? "persisted" : "direct",
        characterId,
        event,
    });
    if (options?.persistenceConfirmed
        && event.id === "evt-fail"
        && !globalThis.__weixinCognitiveFailures.has(event.id)) {
        globalThis.__weixinCognitiveFailures.add(event.id);
        return 0;
    }
    return globalThis.__weixinCognitiveCounters.length;
}
`, "utf8");
    await writeFile(join(tempDir, "chat-db.mjs"), `
export async function dbWaitForMessagePersistence(id) {
    globalThis.__weixinCognitivePersistenceIds.push(id);
    if (id === "evt-fail" && !globalThis.__weixinCognitiveFailures.has(id)) {
        globalThis.__weixinCognitiveFailures.add(id);
        return false;
    }
    return true;
}
`, "utf8");
    await writeFile(join(tempDir, "chat-memory-event.mjs"), `
export function toFutureIntentEvent(message, sourceDetail) {
    return {
        id: message.id,
        sourceApp: "chat",
        sourceDetail,
        timestamp: message.createdAt,
        content: message.content,
        sessionId: message.sessionId,
    };
}
`, "utf8");
    await writeFile(join(tempDir, "memory-summarizer.mjs"), `
export async function maybeRunSummarization(characterId, characterName) {
    globalThis.__weixinCognitiveSummaries.push({ characterId, characterName });
}
`, "utf8");
    const modulePath = join(tempDir, "module.mjs");
    return {
        module: await import(`${pathToFileURL(modulePath).href}?${Date.now()}`),
        cleanup: () => rm(tempDir, { recursive: true, force: true }),
    };
}

const syncSource = await readFile(new URL("../lib/weixin-cloud-sync.ts", import.meta.url), "utf8");
const chatStorageSource = await readFile(new URL("../lib/chat-storage.ts", import.meta.url), "utf8");

assert.match(syncSource, /WEIXIN_CLOUD_COGNITIVE_CURSOR_PREFIX/);
assert.match(syncSource, /WEIXIN_CLOUD_COGNITIVE_PENDING_PREFIX/);
assert.match(syncSource, /insertedMessages/);
assert.match(syncSource, /replayExisting/);
assert.match(syncSource, /retryImportedChatMessagePersistence/);
assert.match(syncSource, /shouldIngestWeixinImportedMessage/);
assert.match(syncSource, /ingestCognitiveMessageEvent/);
assert.match(syncSource, /direction: stored\.direction/);
assert.match(syncSource, /if \(objectDownloadFailed\) continue/);
assert.match(syncSource, /if \(cognitiveBaseline\) saveWeixinCloudCognitiveCursor/);
assert.match(syncSource, /initialized: true/);
assert.match(syncSource, /if \(!listingComplete\)/);
assert.match(syncSource, /if \(!importFailed && \(cognitiveBaseline \|\| scanFull\)\)/);
assert.match(syncSource, /seedWeixinCloudCognitiveCursor\(seenMessages, target\.botId\)/);
assert.match(syncSource, /a\.externalId\.localeCompare\(b\.externalId\)/);
assert.doesNotMatch(syncSource, /CHAT_MESSAGE_PUSHED_EVENT.*imported/i);
assert.match(chatStorageSource, /ingestCognitiveMessageEvent/);
const ingestionSource = await readFile(new URL("../lib/cognitive-memory-ingestion.ts", import.meta.url), "utf8");
assert.doesNotMatch(ingestionSource, /loadChatMessages\(|getLastVisibleSessionMessage\(/);

const cursor = await loadTypeScriptModule("lib/weixin-cognitive-ingestion.ts");
const { advanceWeixinCloudCognitiveCursor, isRealtimeWeixinCloudMessage, shouldIngestWeixinImportedMessage } = cursor;

const notInitialized = { version: 1, initialized: false };
const firstMessage = {
    direction: "inbound",
    role: "user",
    externalId: "wx-1",
    receivedAt: "2026-09-03T08:00:00.000Z",
};
assert.equal(isRealtimeWeixinCloudMessage(firstMessage, notInitialized), false);

const initialized = advanceWeixinCloudCognitiveCursor(notInitialized, firstMessage);
assert.equal(initialized.initialized, true);
assert.deepEqual(initialized.latest, {
    timestamp: firstMessage.receivedAt,
    externalId: firstMessage.externalId,
});

assert.equal(isRealtimeWeixinCloudMessage({
    ...firstMessage,
    externalId: "wx-2",
    receivedAt: "2026-09-03T08:00:00.001Z",
}, initialized), true);
assert.equal(isRealtimeWeixinCloudMessage({
    ...firstMessage,
    externalId: "wx-0",
    receivedAt: "2026-09-03T07:59:59.999Z",
}, initialized), false);
assert.equal(isRealtimeWeixinCloudMessage({
    ...firstMessage,
    externalId: "wx-0",
}, {
    ...initialized,
    latest: { timestamp: firstMessage.receivedAt, externalId: "wx-1" },
}), false);
assert.equal(isRealtimeWeixinCloudMessage({
    ...firstMessage,
    externalId: "wx-2",
}, {
    ...initialized,
    latest: { timestamp: firstMessage.receivedAt, externalId: "wx-1" },
}), true);
assert.equal(isRealtimeWeixinCloudMessage({
    ...firstMessage,
    direction: "outbound",
    role: "assistant",
    externalId: "wx-out-1",
    receivedAt: "2026-09-03T08:01:00.000Z",
}, initialized), true);
assert.equal(isRealtimeWeixinCloudMessage({
    ...firstMessage,
    direction: "local",
    externalId: "local-1",
    receivedAt: "2026-09-03T08:02:00.000Z",
}, initialized), false);
const afterUnprocessedMessage = {
    ...firstMessage,
    externalId: "wx-3",
    receivedAt: "2026-09-03T08:03:00.000Z",
};
assert.equal(isRealtimeWeixinCloudMessage(afterUnprocessedMessage, initialized), true);
assert.deepEqual(initialized.latest, {
    timestamp: firstMessage.receivedAt,
    externalId: firstMessage.externalId,
});

const exactInboundMessage = {
    id: "wxcloud_bot_wx-2",
    role: "user",
    content: "明天下午三点去医院复查。",
    createdAt: "2026-09-03T08:00:00.001Z",
    cloudSync: { source: "weixin-cloud", direction: "inbound" },
};
assert.equal(shouldIngestWeixinImportedMessage({ message: exactInboundMessage, inserted: true }, true), true);
assert.equal(shouldIngestWeixinImportedMessage({ message: exactInboundMessage, inserted: false }, true), false);
assert.equal(shouldIngestWeixinImportedMessage({ message: exactInboundMessage, inserted: true }, false), false);
assert.equal(shouldIngestWeixinImportedMessage({
    message: { ...exactInboundMessage, cloudSync: { source: "weixin-cloud", direction: "local" } },
    inserted: true,
}, true), false);
assert.equal(shouldIngestWeixinImportedMessage({
    message: { ...exactInboundMessage, role: "system" },
    inserted: true,
}, true), false);
assert.equal(shouldIngestWeixinImportedMessage({
    message: { ...exactInboundMessage, role: "assistant", cloudSync: { source: "weixin-cloud", direction: "outbound" } },
    inserted: true,
}, true), true);

globalThis.window = {};
globalThis.__weixinCognitiveCounters = [];
globalThis.__weixinCognitiveSummaries = [];
globalThis.__weixinCognitiveFailures = new Set();
globalThis.__weixinCognitivePersistenceIds = [];
const loadedIngestion = await loadCognitiveIngestionWithStubs();
try {
    const { ingestCognitiveMessageEvent } = loadedIngestion.module;
    const userMessage = {
        id: "evt-user",
        sessionId: "session-exact",
        role: "user",
        content: "下周三一起复诊。",
        createdAt: "2026-09-03T08:10:00.123Z",
    };
    assert.equal(await ingestCognitiveMessageEvent({
        characterId: "character-exact",
        characterName: "角色甲",
        message: userMessage,
    }), true);
    assert.deepEqual(globalThis.__weixinCognitiveCounters[0], {
        mode: "direct",
        characterId: "character-exact",
        event: {
            id: userMessage.id,
            sourceApp: "chat",
            sourceDetail: "direct",
            timestamp: userMessage.createdAt,
            content: userMessage.content,
            sessionId: userMessage.sessionId,
        },
    });

    const assistantMessage = {
        id: "evt-assistant",
        sessionId: "session-exact",
        role: "assistant",
        content: "好，我记住了。",
        createdAt: "2026-09-03T08:10:01.123Z",
    };
    assert.equal(await ingestCognitiveMessageEvent({
        characterId: "character-exact",
        characterName: "角色甲",
        message: assistantMessage,
    }), true);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(globalThis.__weixinCognitiveSummaries, [{
        characterId: "character-exact",
        characterName: "角色甲",
    }]);

    const fifoFirst = {
        id: "evt-fifo-1",
        sessionId: "session-fifo",
        role: "assistant",
        content: "第一段",
        createdAt: "2026-09-03T08:11:00.000Z",
    };
    const fifoSecond = {
        id: "evt-fifo-2",
        sessionId: "session-fifo",
        role: "user",
        content: "第二段",
        createdAt: "2026-09-03T08:11:01.000Z",
    };
    const fifoFirstRun = ingestCognitiveMessageEvent({
        characterId: "character-fifo",
        characterName: "角色乙",
        message: fifoFirst,
    }, { persistenceConfirmed: true });
    const fifoSecondRun = ingestCognitiveMessageEvent({
        characterId: "character-fifo",
        characterName: "角色乙",
        message: fifoSecond,
    }, { persistenceConfirmed: true });
    assert.equal(await fifoFirstRun, true);
    assert.equal(await fifoSecondRun, true);
    assert.deepEqual(globalThis.__weixinCognitiveCounters.slice(-2).map(item => item.event.id), ["evt-fifo-1", "evt-fifo-2"]);

    const duplicateMessage = {
        id: "evt-duplicate",
        sessionId: "session-duplicate",
        role: "user",
        content: "只计一次。",
        createdAt: "2026-09-03T08:12:00.000Z",
    };
    const duplicateFirst = ingestCognitiveMessageEvent({
        characterId: "character-duplicate",
        characterName: "角色丙",
        message: duplicateMessage,
    }, { persistenceConfirmed: true });
    const duplicateSecond = ingestCognitiveMessageEvent({
        characterId: "character-duplicate",
        characterName: "角色丙",
        message: duplicateMessage,
    }, { persistenceConfirmed: true });
    assert.equal(duplicateFirst, duplicateSecond);
    assert.equal(await duplicateFirst, true);
    assert.equal(globalThis.__weixinCognitiveCounters.filter(item => item.event.id === duplicateMessage.id).length, 1);

    const failedMessage = {
        id: "evt-fail",
        sessionId: "session-failure",
        role: "user",
        content: "写入失败后可重试。",
        createdAt: "2026-09-03T08:13:00.000Z",
    };
    assert.equal(await ingestCognitiveMessageEvent({
        characterId: "character-failure",
        characterName: "角色丁",
        message: failedMessage,
    }, { persistenceConfirmed: true }), false);
    assert.equal(await ingestCognitiveMessageEvent({
        characterId: "character-failure",
        characterName: "角色丁",
        message: failedMessage,
    }, { persistenceConfirmed: true }), true);
    assert.deepEqual(globalThis.__weixinCognitivePersistenceIds, [
        "evt-fifo-1",
        "evt-fifo-2",
        "evt-duplicate",
        "evt-fail",
        "evt-fail",
    ]);
} finally {
    await loadedIngestion.cleanup();
    delete globalThis.window;
    delete globalThis.__weixinCognitiveCounters;
    delete globalThis.__weixinCognitiveSummaries;
    delete globalThis.__weixinCognitiveFailures;
    delete globalThis.__weixinCognitivePersistenceIds;
}

console.log("weixin cognitive ingestion tests passed");
