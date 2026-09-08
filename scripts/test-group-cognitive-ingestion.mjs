import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";

async function loadGroupIngestionWithStubs() {
    const tempDir = await mkdtemp(join(process.cwd(), ".tmp-group-cognitive-"));
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
    globalThis.__groupCognitiveCounters.push({ characterId, event, options });
    return globalThis.__groupCognitiveCounters.length;
}
`, "utf8");
    await writeFile(join(tempDir, "chat-db.mjs"), `
export async function dbWaitForMessagePersistence(id) {
    globalThis.__groupCognitivePersistenceChecks.push(id);
    return globalThis.__groupCognitivePersistedIds.has(id);
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
export async function maybeRunSummarization() {}
`, "utf8");
    const modulePath = join(tempDir, "module.mjs");
    return {
        module: await import(`${pathToFileURL(modulePath).href}?${Date.now()}`),
        cleanup: () => rm(tempDir, { recursive: true, force: true }),
    };
}

const groupEngineSource = await readFile(new URL("../lib/group-chat-engine.ts", import.meta.url), "utf8");
const chatStorageSource = await readFile(new URL("../lib/chat-storage.ts", import.meta.url), "utf8");
const chatMemoryEventSource = await readFile(new URL("../lib/chat-memory-event.ts", import.meta.url), "utf8");

// Group ingestion must use the actual pushChatMessage persistence boundary,
// never a pre-persistence history slice guessed from replyCount.
assert.doesNotMatch(groupEngineSource, /scheduleGroupMemorySummarization/);
assert.doesNotMatch(groupEngineSource, /replyCount/);
assert.doesNotMatch(groupEngineSource, /history\.slice\(-totalNewEvents\)/);
assert.doesNotMatch(groupEngineSource, /incrementEventCounter/);
assert.match(chatStorageSource, /persistedSession\.isGroup/);
assert.match(chatStorageSource, /sourceDetail:\s*["']group["']/);
assert.match(chatStorageSource, /persistenceConfirmed:\s*true/);
assert.match(chatStorageSource, /participantIds/);
assert.match(chatMemoryEventSource, /sourceDetail:\s*["']direct["']\s*\|\s*["']group["']/);

globalThis.window = {};
globalThis.__groupCognitiveCounters = [];
globalThis.__groupCognitivePersistedIds = new Set();
globalThis.__groupCognitivePersistenceChecks = [];
const loaded = await loadGroupIngestionWithStubs();
try {
    const { ingestCognitiveMessageEvent } = loaded.module;
    const oldMessage = {
        id: "group-old-message",
        sessionId: "group-session",
        role: "assistant",
        content: "旧历史，不应被本轮重新处理。",
        createdAt: "2026-09-08T08:00:00.000Z",
    };
    const userMessage = {
        id: "group-user-message",
        sessionId: "group-session",
        role: "user",
        content: "明晚八点一起看电影。",
        createdAt: "2026-09-08T08:01:00.000Z",
    };
    const firstReply = {
        id: "group-reply-a",
        sessionId: "group-session",
        role: "assistant",
        content: "好，我来订票。",
        createdAt: "2026-09-08T08:01:01.000Z",
    };
    const secondReply = {
        id: "group-reply-b",
        sessionId: "group-session",
        role: "assistant",
        content: "我负责准备零食。",
        createdAt: "2026-09-08T08:01:02.000Z",
    };

    // A failed persistence check must not advance the counter or lifecycle.
    assert.equal(await ingestCognitiveMessageEvent({
        characterId: "char-a",
        characterName: "角色甲",
        message: oldMessage,
        sourceDetail: "group",
    }, { persistenceConfirmed: true }), false);
    assert.equal(globalThis.__groupCognitiveCounters.length, 0);

    // These are the three real messages persisted in this round; the old message
    // is deliberately not passed as a synthetic/reconstructed event.
    for (const message of [userMessage, firstReply, secondReply]) {
        globalThis.__groupCognitivePersistedIds.add(message.id);
        for (const [characterId, characterName] of [["char-a", "角色甲"], ["char-b", "角色乙"]]) {
            assert.equal(await ingestCognitiveMessageEvent({
                characterId,
                characterName,
                message,
                sourceDetail: "group",
            }, { persistenceConfirmed: true }), true);
        }
    }

    const realEvents = globalThis.__groupCognitiveCounters.filter(item => item.event.id !== oldMessage.id);
    assert.equal(realEvents.length, 6);
    assert.deepEqual(realEvents.map(item => item.event.id), [
        "group-user-message", "group-user-message",
        "group-reply-a", "group-reply-a",
        "group-reply-b", "group-reply-b",
    ]);
    assert.deepEqual(realEvents.map(item => item.event.sourceDetail), Array(6).fill("group"));
    assert.deepEqual(realEvents.filter(item => item.event.id === "group-reply-b").map(item => ({
        characterId: item.characterId,
        id: item.event.id,
        content: item.event.content,
    })), [
        { characterId: "char-a", id: "group-reply-b", content: "我负责准备零食。" },
        { characterId: "char-b", id: "group-reply-b", content: "我负责准备零食。" },
    ]);

    // Repeated persistence callbacks for the same stable message ids are idempotent.
    for (const message of [userMessage, firstReply, secondReply]) {
        for (const [characterId, characterName] of [["char-a", "角色甲"], ["char-b", "角色乙"]]) {
            assert.equal(await ingestCognitiveMessageEvent({
                characterId,
                characterName,
                message,
                sourceDetail: "group",
            }, { persistenceConfirmed: true }), true);
        }
    }
    assert.equal(globalThis.__groupCognitiveCounters.length, 6);

    // Preview/debug code must remain side-effect free by construction.
    const previewStart = groupEngineSource.indexOf("export async function previewGroupChatCompletion");
    assert.notEqual(previewStart, -1);
    const previewSource = groupEngineSource.slice(previewStart);
    assert.doesNotMatch(previewSource, /ingestCognitiveMessageEvent|incrementEventCounter|scheduleGroupMemorySummarization/);
} finally {
    await loaded.cleanup();
    delete globalThis.window;
    delete globalThis.__groupCognitiveCounters;
    delete globalThis.__groupCognitivePersistedIds;
    delete globalThis.__groupCognitivePersistenceChecks;
}

console.log("group cognitive ingestion regression tests passed");
