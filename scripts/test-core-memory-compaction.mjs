import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { createContext, SourceTextModule } from "node:vm";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const context = createContext({ console, setTimeout, structuredClone });
context.__cores = [];
context.__snapshots = [];
context.__llmResponses = [];
context.__llmCalls = [];
context.__replaceCalls = [];
context.__restoreCalls = [];
context.__sideEffects = {
    embeddings: 0,
    links: 0,
    recallStats: 0,
    longTermWrites: 0,
    chatWrites: 0,
    storyWrites: 0,
};

const mockSources = new Map([
    [resolve(repoRoot, "lib/memory-storage.ts"), `
        export async function loadMemoryEntriesByType(characterId, type) {
            return globalThis.__cores
                .filter(entry => entry.characterId === characterId && entry.type === type)
                .map(entry => structuredClone(entry));
        }
        export async function replaceCoreMemoriesWithSnapshot(request) {
            globalThis.__replaceCalls.push(structuredClone(request));
            if (globalThis.__failReplacement) throw new Error("simulated atomic failure");
            const ids = new Set(request.originalEntries.map(entry => entry.id));
            globalThis.__cores = globalThis.__cores.filter(entry => !ids.has(entry.id));
            globalThis.__cores.push(...request.newEntries.map(entry => structuredClone(entry)));
            globalThis.__snapshots.push(structuredClone(request.snapshot));
        }
        export async function loadLatestCoreCompactionSnapshot(characterId) {
            return globalThis.__snapshots
                .filter(snapshot => snapshot.characterId === characterId && !snapshot.restoredAt)
                .sort((left, right) => right.compactedAt.localeCompare(left.compactedAt))[0] ?? null;
        }
        export async function restoreCoreCompactionSnapshot(characterId, runId) {
            globalThis.__restoreCalls.push({ characterId, runId });
            const snapshot = globalThis.__snapshots.find(item =>
                item.characterId === characterId && (!runId || item.runId === runId) && !item.restoredAt,
            );
            if (!snapshot) throw new Error("没有可恢复的核心记忆整理快照");
            const createdIds = new Set(snapshot.createdMemoryIds);
            globalThis.__cores = globalThis.__cores.filter(entry => !createdIds.has(entry.id));
            globalThis.__cores.push(...snapshot.originalEntries.map(entry => structuredClone(entry)));
            snapshot.restoredAt = "2026-09-02T12:30:00.000Z";
            return structuredClone(snapshot);
        }
    `],
    [resolve(repoRoot, "lib/settings-storage.ts"), `
        export function resolveAuxiliaryApiConfig() { return { id: "memory-summary" }; }
    `],
    [resolve(repoRoot, "lib/api-helpers.ts"), `
        export async function simpleLLMCall(_config, messages) {
            globalThis.__llmCalls.push(messages[0].content);
            return globalThis.__llmResponses.shift() ?? { content: null, error: "no response" };
        }
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
    const module = new SourceTextModule(code, { context, identifier: normalizedPath });
    moduleCache.set(normalizedPath, module);
    await module.link((specifier, referencingModule) => loadModule(
        sourceModulePath(specifier, referencingModule),
    ));
    return module;
}

function memory(id, characterId = "char-1", overrides = {}) {
    return {
        id,
        characterId,
        sourceApp: "chat",
        type: "core",
        content: `原始核心事实 ${id}`,
        importance: 0.95,
        createdAt: `2026-08-${id === "c1-a" ? "01" : "02"}T12:00:00.000Z`,
        updatedAt: `2026-08-${id === "c1-a" ? "01" : "02"}T12:00:00.000Z`,
        tags: ["原始"],
        kind: "relationship",
        accessCount: 4,
        stability: 0.97,
        metadata: { preserved: true },
        ...overrides,
    };
}

const compactionSource = await readFile(resolve(repoRoot, "lib/core-memory-compaction.ts"), "utf8");
assert.doesNotMatch(compactionSource, /DEFAULT_CORE_MEMORY_PROMPT/);

const compaction = await loadModule(resolve(repoRoot, "lib/core-memory-compaction.ts"));
await compaction.evaluate();

const originalC1 = [
    memory("c1-a"),
    memory("c1-b", "char-1", { content: "用户与角色已经确认恋爱关系。", sourceApp: "story" }),
];
const originalC2 = [memory("c2-a", "char-2", { content: "第二角色的独立事实。" })];
context.__cores = [...originalC1, ...originalC2];
context.__snapshots = [];
context.__llmCalls = [];
context.__replaceCalls = [];
context.__sideEffects = { embeddings: 0, links: 0, recallStats: 0, longTermWrites: 0, chatWrites: 0, storyWrites: 0 };
context.__llmResponses = [{
    content: JSON.stringify({
        memories: [
            { content: "用户与角色已经确认恋爱关系。", tags: ["关系"], kind: "relationship" },
            { content: "用户与角色已经确认恋爱关系。", tags: ["重复"], kind: "relationship" },
            { content: "双方保持稳定的长期亲密关系。", tags: ["关系"], kind: "relationship" },
            { content: "角色计划下个月与用户旅行。", tags: ["未来"], kind: "future_intent" },
        ],
    }),
}];

const previewResult = await compaction.namespace.previewCoreMemoryCompaction("char-1", "角色一");
assert.equal(previewResult.success, false, "future-intent output must not become an applicable Core plan");
assert.match(previewResult.error, /未来|future|结构/);
assert.equal(context.__llmCalls.length, 1, "Preview calls the bound summary API exactly once");
assert.equal(context.__replaceCalls.length, 0, "Preview must not persist replacement data");
assert.deepEqual(context.__cores, [...originalC1, ...originalC2], "Preview must not mutate any memory");
assert.doesNotMatch(context.__llmCalls[0], /第二角色的独立事实/);
assert.doesNotMatch(context.__llmCalls[0], /用户自定义 core prompt/);
assert.match(context.__llmCalls[0], /created_at=2026-08-01T12:00:00.000Z/);

context.__llmResponses = [{
    content: JSON.stringify({
        memories: [
            { content: "用户与角色已经确认恋爱关系。", tags: ["关系"], kind: "relationship" },
            { content: "用户与角色已经确认恋爱关系。", tags: ["重复"], kind: "relationship" },
            { content: "双方保持稳定的长期亲密关系。", tags: ["关系"], kind: "relationship" },
        ],
    }),
}];
const validPreviewResult = await compaction.namespace.previewCoreMemoryCompaction("char-1", "角色一", {
    now: () => "2026-09-02T12:00:00.000Z",
    createRunId: () => "run-char-1",
    createMemoryId: (_runId, index) => `compacted-${index}`,
});
assert.equal(validPreviewResult.success, true);
assert.equal(validPreviewResult.preview.originalCount, 2);
assert.equal(validPreviewResult.preview.candidateCount, 2, "duplicate candidates are deduped");
assert.deepEqual(context.__cores, [...originalC1, ...originalC2]);

const applyResult = await compaction.namespace.applyCoreMemoryCompaction(validPreviewResult.preview, {
    now: () => "2026-09-02T12:00:00.000Z",
    createRunId: () => "run-char-1",
    createMemoryId: (_runId, index) => `compacted-${index}`,
});
assert.equal(applyResult.success, true);
assert.equal(context.__cores.filter(entry => entry.characterId === "char-1").length, 2);
assert.equal(context.__cores.filter(entry => entry.characterId === "char-2").length, 1, "character isolation is preserved");
assert.deepEqual(
    context.__cores.filter(entry => entry.characterId === "char-1").map(entry => entry.content),
    ["用户与角色已经确认恋爱关系。", "双方保持稳定的长期亲密关系。"],
);
for (const entry of context.__cores.filter(item => item.characterId === "char-1")) {
    assert.equal(entry.importance, 0.95);
    assert.equal(entry.embedding, undefined);
    assert.equal(entry.sourceMessageIds, undefined);
    assert.equal(entry.metadata.compactionRunId, "run-char-1");
    assert.equal(entry.metadata.compactedAt, "2026-09-02T12:00:00.000Z");
    assert.deepEqual(entry.metadata.compactedFromCoreIds, ["c1-a", "c1-b"]);
    assert.equal(entry.metadata.eventDate, undefined);
}
assert.deepEqual(context.__replaceCalls[0].snapshot.originalEntries, originalC1, "snapshot preserves every original field");
assert.deepEqual(context.__replaceCalls[0].snapshot.originalEntries.map(entry => entry.createdAt), originalC1.map(entry => entry.createdAt));
assert.equal(context.__replaceCalls[0].snapshot.characterId, "char-1");
assert.equal(context.__replaceCalls[0].snapshot.runId, "run-char-1");
assert.deepEqual(context.__replaceCalls[0].snapshot.createdMemoryIds, ["compacted-0", "compacted-1"]);
assert.deepEqual(context.__sideEffects, { embeddings: 0, links: 0, recallStats: 0, longTermWrites: 0, chatWrites: 0, storyWrites: 0 });

const secondApply = await compaction.namespace.applyCoreMemoryCompaction(validPreviewResult.preview, {
    now: () => "2026-09-02T12:01:00.000Z",
    createRunId: () => "run-char-1-second",
    createMemoryId: (_runId, index) => `compacted-second-${index}`,
});
assert.equal(secondApply.success, false, "stale Preview cannot be applied twice");
assert.equal(context.__replaceCalls.length, 1);

context.__failReplacement = true;
context.__llmResponses = [{
    content: JSON.stringify({ memories: [{ content: "一次独立事实。", kind: "event" }] }),
}];
const failurePreviewResult = await compaction.namespace.previewCoreMemoryCompaction("char-2", "角色二", {
    now: () => "2026-09-02T12:10:00.000Z",
    createRunId: () => "run-char-2",
    createMemoryId: (_runId, index) => `compacted-char-2-${index}`,
});
assert.equal(failurePreviewResult.success, true);
const beforeFailedApply = structuredClone(context.__cores);
const failedApply = await compaction.namespace.applyCoreMemoryCompaction(failurePreviewResult.preview, {
    now: () => "2026-09-02T12:10:00.000Z",
    createRunId: () => "run-char-2",
    createMemoryId: (_runId, index) => `compacted-char-2-${index}`,
});
assert.equal(failedApply.success, false);
assert.deepEqual(context.__cores, beforeFailedApply, "failed transaction leaves the original Core set intact");
context.__failReplacement = false;

for (const badContent of ["", "plain text instead of JSON", "{\"memories\":[]}", "{\"memories\":[{\"kind\":\"event\"}]}"]) {
    context.__llmResponses = [{ content: badContent }];
    const badResult = await compaction.namespace.previewCoreMemoryCompaction("char-2", "角色二");
    assert.equal(badResult.success, false, `malformed/empty output must reject: ${badContent}`);
}

const latestSnapshot = await compaction.namespace.loadLatestCoreMemoryCompactionSnapshot("char-1");
assert.equal(latestSnapshot.characterId, "char-1");
assert.equal(await compaction.namespace.loadLatestCoreMemoryCompactionSnapshot("char-2"), null);
const restored = await compaction.namespace.restoreCoreMemoryCompaction("char-1", "run-char-1");
assert.equal(restored.success, true);
assert.deepEqual(
    context.__cores.filter(entry => entry.characterId === "char-1"),
    originalC1,
    "Restore exactly recovers the original Core records",
);
assert.deepEqual(context.__cores.filter(entry => entry.characterId === "char-2"), beforeFailedApply.filter(entry => entry.characterId === "char-2"));
assert.equal(await compaction.namespace.loadLatestCoreMemoryCompactionSnapshot("char-1"), null, "restored snapshot is no longer offered as active");

const uiSource = await readFile(resolve(repoRoot, "components/memory/memory-bank-page.tsx"), "utf8");
assert.match(uiSource, /预览整理/);
assert.match(uiSource, /应用整理结果/);
assert.match(uiSource, /恢复整理前核心记忆/);
assert.match(uiSource, /不会修改长期记忆、聊天、剧情或记忆关联/);
assert.match(uiSource, /previewCoreMemoryCompaction/);
assert.match(uiSource, /applyCoreMemoryCompaction/);

console.log("core memory compaction tests passed");
