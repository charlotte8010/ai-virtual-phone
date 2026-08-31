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

const structured = extraction.extractMemoriesFromModelOutput(JSON.stringify({
    memories: [
        {
            content: "用户和宋瑾约好9月5日晚一起看电影。",
            tags: ["宋瑾", "电影", "约定"],
            importance: 0.86,
            mood: "tender",
            kind: "future_intent",
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

console.log("memory extraction and dedupe tests passed");
