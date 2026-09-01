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
    const tempDir = await mkdtemp(join(process.cwd(), ".tmp-memory-extraction-"));
    const modulePath = join(tempDir, "module.mjs");
    await writeFile(modulePath, transpiled.outputText, "utf8");
    try {
        return await import(`${pathToFileURL(modulePath).href}?${Date.now()}`);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

const extraction = await loadTypeScriptModule("lib/memory-extraction.ts");
const dedupe = await loadTypeScriptModule("lib/memory-dedupe.ts");
const provenance = await loadTypeScriptModule("lib/memory-provenance.ts");
const summarizerSource = await readFile(new URL("../lib/memory-summarizer.ts", import.meta.url), "utf8");

const timelineEntries = [
    {
        id: "chat_1",
        sourceApp: "chat",
        timestamp: "2026-08-31T22:00:00.000Z",
        content: "用户说今晚想看电影。",
    },
    {
        id: "xhs_1",
        sourceApp: "xiaohongshu",
        timestamp: "2026-08-31T22:10:00.000Z",
        content: "角色发布了旅行笔记。",
    },
];
const formattedEvent = provenance.formatMemoryExtractionTimelineEntry(timelineEntries[1], timelineEntries[1].content);
assert.match(formattedEvent, /^\[event_ref=xhs_1\]/);
assert.match(formattedEvent, /\[source_app=xiaohongshu\]/);
assert.match(formattedEvent, /\[event_time=2026-08-31T22:10:00\.000Z\]/);
assert.equal(provenance.resolveMemorySourceApp(["xhs_1"], timelineEntries, "chat"), "xiaohongshu");
assert.equal(provenance.resolveMemorySourceApp(undefined, timelineEntries, "chat"), "chat");
assert.equal(provenance.resolveMemorySourceApp(["unknown"], timelineEntries, "chat"), "chat");

const memoryTypes = await loadTypeScriptModule("lib/memory-types.ts");
assert.notEqual(memoryTypes.DEFAULT_SUMMARIZATION_PROMPT, memoryTypes.LEGACY_SUMMARIZATION_PROMPT);
assert.match(memoryTypes.DEFAULT_SUMMARIZATION_PROMPT, /sourceEventRefs/);

const structured = extraction.extractMemoriesFromModelOutput(JSON.stringify({
    memories: [
        {
            content: "用户和宋瑾约好9月5日晚一起看电影。",
            tags: ["宋瑾", "电影", "约定"],
            importance: 0.86,
            mood: "tender",
            kind: "future_intent",
            sourceEventRefs: ["xhs_1"],
            futureIntent: {
                type: "plan",
                status: "pending",
                timePrecision: "exact",
            },
        },
        {
            content: "用户最近很喜欢某部作品。",
            tags: ["用户偏好", "作品"],
            importance: 0.68,
            kind: "user_fact",
        },
    ],
}));
assert.equal(structured.mode, "structured");
assert.equal(structured.memories.length, 2);
assert.equal(structured.memories[0].importance, 0.86);
assert.equal(structured.memories[0].kind, "future_intent");
assert.equal(structured.memories[0].futureIntent?.type, "plan");
assert.deepEqual(structured.memories[0].sourceEventRefs, ["xhs_1"]);
assert.deepEqual(structured.memories[1].tags, ["用户偏好", "作品"]);

const repaired = extraction.extractMemoriesFromModelOutput(
    "模型说明：\\n```json\\n{ memories: [{ content: '用户喜欢雨天散步。', importance: 1.4, kind: 'user_fact', tags: ['偏好', '偏好', ''] }] }\\n```",
);
assert.equal(repaired.mode, "structured");
assert.equal(repaired.memories.length, 1);
assert.equal(repaired.memories[0].importance, 1);
assert.deepEqual(repaired.memories[0].tags, ["偏好"]);

const sanitized = extraction.extractMemoriesFromModelOutput(JSON.stringify({
    memories: [
        {
            content: "  未来要一起旅行。 ",
            kind: "future_intent",
            importance: -2,
            tags: [" a ", "a", "b", "c", "d", "e", "f", "g"],
            mood: "not-a-mood",
        },
        {
            content: "非未来事实",
            kind: "user_fact",
            futureIntent: { type: "plan", status: "pending" },
        },
        {
            content: "未知类型仍应安全降级",
            kind: "not-a-kind",
        },
    ],
}));
assert.equal(sanitized.memories[0].importance, 0);
assert.deepEqual(sanitized.memories[0].tags, ["a", "b", "c", "d", "e", "f"]);
assert.equal(sanitized.memories[0].mood, undefined);
assert.equal(sanitized.memories[0].futureIntent?.type, "expectation");
assert.equal(sanitized.memories[1].futureIntent, undefined);
assert.equal(sanitized.memories[2].kind, "event");

const empty = extraction.extractMemoriesFromModelOutput('{"memories":[]}');
assert.equal(empty.mode, "structured");
assert.deepEqual(empty.memories, []);

const invalidStructured = extraction.extractMemoriesFromModelOutput('{"memories":[{"kind":"event"}]}');
assert.equal(invalidStructured.mode, "invalid_structured");
assert.equal(invalidStructured.memories.length, 0);

const malformedStructured = extraction.extractMemoriesFromModelOutput("```json\n{ memories: [{ kind: 'event' }\n```");
assert.equal(malformedStructured.mode, "invalid_structured");

const capped = extraction.extractMemoriesFromModelOutput(JSON.stringify({
    memories: Array.from({ length: 10 }, (_, index) => ({
        content: `长期记忆 ${index}`,
        kind: "event",
        importance: index / 10,
    })),
}));
assert.equal(capped.memories.length, 8);

const fallback = extraction.extractMemoriesFromModelOutput("用户说自己喜欢海边，也答应下周联系。");
assert.equal(fallback.mode, "plain_text_fallback");
assert.equal(fallback.memories.length, 1);
assert.equal(fallback.memories[0].importance, 0.8);
assert.equal(fallback.memories[0].kind, "event");

const creationCandidate = extraction.normalizeFutureIntentCreationCandidate({
    content: "明天一起看电影",
    tags: ["电影"],
    importance: 0.8,
    kind: "future_intent",
    futureIntent: {
        type: "plan",
        status: "fulfilled",
        timePrecision: "exact",
        targetAt: "2026-09-02T12:00:00.000Z",
        fulfilledAt: "2026-09-02T13:00:00.000Z",
        replacedByMemoryId: "secret-replacement",
    },
});
assert.equal(creationCandidate.futureIntent.status, "pending");
assert.equal(creationCandidate.futureIntent.fulfilledAt, undefined);
assert.equal(creationCandidate.futureIntent.replacedByMemoryId, undefined);
assert.match(summarizerSource, /normalizeFutureIntentCreationCandidate\(candidate\)/);
assert.match(summarizerSource, /status 初始只能是 pending/);

const existing = {
    id: "mem-1",
    characterId: "char-1",
    sourceApp: "chat",
    type: "long_term",
    content: "用户喜欢雨天散步。",
    importance: 0.6,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    kind: "user_fact",
};
assert.equal(dedupe.normalizeMemoryContent("用户喜欢雨天散步！"), dedupe.normalizeMemoryContent(existing.content));
assert.equal(dedupe.findDuplicateMemory({ ...existing, content: "用户喜欢雨天散步！" }, [existing])?.id, "mem-1");
assert.equal(dedupe.findDuplicateMemory({
    ...existing,
    id: "new",
    content: "同义但无向量的内容",
    metadata: { sourceEventSignatures: ["char-1:chat:event-7"] },
}, [{
    ...existing,
    metadata: { sourceEventSignatures: ["char-1:chat:event-7"] },
}])?.id, "mem-1");
assert.equal(dedupe.findDuplicateMemory({
    ...existing,
    id: "semantic-new",
    content: "语义相近但措辞不同",
    embedding: [1, 0],
    createdAt: "2026-08-02T00:00:00.000Z",
    metadata: { sourceEventTimestamps: ["2026-08-02T00:00:00.000Z"] },
}, [{
    ...existing,
    embedding: [0.99, 0.1],
    metadata: { sourceEventTimestamps: ["2026-08-02T00:00:00.000Z"] },
}])?.id, "mem-1");
assert.equal(dedupe.findDuplicateMemory({
    ...existing,
    id: "semantic-different-time",
    content: "语义相近但发生在另一个时间",
    embedding: [1, 0],
    createdAt: "2026-08-20T00:00:00.000Z",
    metadata: { sourceEventTimestamps: ["2026-08-20T00:00:00.000Z"] },
}, [{
    ...existing,
    embedding: [0.99, 0.1],
    metadata: { sourceEventTimestamps: ["2026-08-02T00:00:00.000Z"] },
}]), null);

console.log("memory extraction and dedupe tests passed");
