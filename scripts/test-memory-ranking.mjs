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
    const tempDir = await mkdtemp(join(process.cwd(), ".tmp-memory-ranking-"));
    const modulePath = join(tempDir, "module.mjs");
    await writeFile(modulePath, transpiled.outputText, "utf8");
    try {
        return await import(`${pathToFileURL(modulePath).href}?${Date.now()}`);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

const ranking = await loadTypeScriptModule("lib/memory-ranking.ts");
const textSearch = await loadTypeScriptModule("lib/memory-text-search.ts");
const injector = await loadTypeScriptModule("lib/memory-injector.ts");

const now = new Date("2026-09-01T12:00:00.000Z");

function memory(id, overrides = {}) {
    return {
        id,
        characterId: "char-1",
        sourceApp: "chat",
        type: "long_term",
        content: `记忆 ${id}`,
        importance: 0.5,
        createdAt: "2026-08-20T12:00:00.000Z",
        updatedAt: "2026-08-20T12:00:00.000Z",
        ...overrides,
    };
}

const tagged = memory("song-jin", {
    content: "用户和宋瑾约好周五一起看电影。",
    tags: ["宋瑾", "电影", "约定"],
});
const unrelated = memory("unrelated", {
    content: "用户喜欢雨天散步。",
    tags: ["雨天", "散步"],
});
const textResults = textSearch.searchMemoryText("宋瑾", [unrelated, tagged], 10);
assert.equal(textResults[0].entry.id, "song-jin");
assert.ok(textResults[0].keywordScore > 0);
assert.ok(textResults[0].tagScore > 0);
assert.deepEqual(textSearch.searchMemoryText("", [tagged], 10), []);

const ranked = ranking.rankMemoryCandidates([
    { memory: unrelated, source: "recent" },
    { memory: tagged, source: "keyword", keywordScore: 0.9, tagScore: 1 },
    { memory: memory("vector", {
        content: "用户和宋瑾曾在夏天旅行。",
        embedding: [0.99, 0.1],
        importance: 0.8,
        kind: "event",
    }), source: "vector", semanticScore: 0.99 },
], "宋瑾电影", { now, timezone: "Asia/Shanghai" });
assert.equal(ranked.length, 3);
assert.ok(ranked[0].score >= ranked[1].score);
for (const item of ranked) {
    for (const value of Object.values(item.features)) {
        assert.ok(value >= 0 && value <= 1, `${item.memory.id} feature outside 0..1`);
    }
}

const dueToday = memory("due-today", {
    content: "今天晚上角色答应陪用户去医院。",
    kind: "future_intent",
    importance: 0.7,
    futureIntent: {
        type: "promise",
        status: "pending",
        timePrecision: "exact",
        targetAt: "2026-09-01T14:00:00.000Z",
    },
});
const dueTomorrow = memory("due-tomorrow", {
    content: "明天一起吃饭。",
    kind: "future_intent",
    futureIntent: {
        type: "plan",
        status: "pending",
        timePrecision: "day",
        targetAt: "2026-09-02T14:00:00.000Z",
    },
});
const overdue = memory("overdue", {
    content: "昨天答应提醒用户复诊，但还没有确认。",
    kind: "future_intent",
    futureIntent: {
        type: "promise",
        status: "overdue",
        timePrecision: "day",
        targetAt: "2026-08-31T14:00:00.000Z",
    },
});
const dueRanked = ranking.rankMemoryCandidates([
    { memory: dueToday, source: "future_intent" },
    { memory: dueTomorrow, source: "future_intent" },
    { memory: overdue, source: "future_intent" },
], "完全无关的话题", { now, timezone: "Asia/Shanghai" });
assert.equal(dueRanked.find(item => item.memory.id === "due-today")?.protectedReason, "due_today");
assert.equal(dueRanked.find(item => item.memory.id === "due-tomorrow")?.protectedReason, "due_tomorrow");
assert.equal(dueRanked.find(item => item.memory.id === "overdue")?.protectedReason, "critical_overdue");
assert.ok(ranking.getFutureIntentUrgency(dueToday, now, "Asia/Shanghai") > 0.8);

const clusterEntries = [
    ...Array.from({ length: 3 }, (_, index) => memory(`cluster-${index}`, {
        content: `同一批次细节 ${index}`,
        importance: 0.95 - index * 0.05,
        metadata: { sourceEventSignatures: ["batch:one"] },
    })).map(item => ({ memory: item, source: "keyword", keywordScore: 1 })),
    { memory: memory("other-cluster", { content: "另一段重要人生经历", importance: 0.6 }), source: "keyword", keywordScore: 0.4 },
];
const selectedCluster = ranking.selectRankedMemoryCandidates(
    ranking.rankMemoryCandidates(clusterEntries, "人生经历", { now }),
    { tokenBudget: 10000, maxSelected: 10, maxPerCluster: 2 },
);
assert.equal(selectedCluster.filter(item => item.memory.metadata?.sourceEventSignatures?.[0] === "batch:one").length, 2);
assert.equal(selectedCluster.some(item => item.memory.id === "other-cluster"), true);

const protectedClusterEntries = [
    ...["ordinary-a", "ordinary-b"].map(id => ({
        memory: memory(id, {
            content: `同一批次普通候选 ${id}`,
            importance: 1,
            metadata: { sourceEventSignatures: ["batch:protected-priority"] },
        }),
        source: "keyword",
        keywordScore: 1,
    })),
    {
        memory: memory("protected-c", {
            content: "今天的受保护约定。",
            kind: "future_intent",
            importance: 0.1,
            metadata: { sourceEventSignatures: ["batch:protected-priority"] },
            futureIntent: {
                type: "plan",
                status: "pending",
                timePrecision: "day",
                targetAt: "2026-09-01T14:00:00.000Z",
            },
        }),
        source: "future_intent",
    },
];
const protectedClusterRanked = ranking.rankMemoryCandidates(
    protectedClusterEntries,
    "普通候选",
    { now, timezone: "Asia/Shanghai" },
);
assert.equal(protectedClusterRanked[0].memory.id, "ordinary-a");
const protectedClusterSelected = ranking.selectRankedMemoryCandidates(
    protectedClusterRanked,
    { tokenBudget: 10000, maxSelected: 3, maxProtectedFutureIntents: 1, maxPerCluster: 2 },
);
assert.equal(protectedClusterSelected[0].memory.id, "protected-c");
assert.equal(protectedClusterSelected[0].protectedReason, "due_today");
assert.equal(protectedClusterSelected.filter(item => item.protectedReason).length, 1);
assert.equal(protectedClusterSelected.filter(item => item.clusterKey === protectedClusterSelected[0].clusterKey).length, 2);
assert.equal(protectedClusterSelected.filter(item => item.memory.id.startsWith("ordinary-")).length, 1);

const manyMemories = Array.from({ length: 5 }, (_, index) => ({
    memory: memory(`limited-${index}`, { importance: 0.9 - index * 0.1 }),
    source: "recent",
}));
const limited = ranking.selectRankedMemoryCandidates(
    ranking.rankMemoryCandidates(manyMemories, "", { now }),
    { tokenBudget: 10000, maxSelected: 3 },
);
assert.equal(limited.length, 3);

const longMemory = memory("too-long", { content: "很长的记忆".repeat(100) });
const shortMemory = memory("short-after-long", { content: "短记忆" });
const budgetSelected = ranking.selectRankedMemoryCandidates(
    ranking.rankMemoryCandidates([
        { memory: longMemory, source: "keyword", keywordScore: 1 },
        { memory: shortMemory, source: "recent", importance: 0.1 },
    ], "记忆", { now }),
    { tokenBudget: 10, maxSelected: 5 },
);
assert.equal(budgetSelected.some(item => item.memory.id === "short-after-long"), true);

const protectedOverflow = ranking.selectRankedMemoryCandidates(
    ranking.rankMemoryCandidates(
        Array.from({ length: 4 }, (_, index) => ({
            memory: memory(`protected-${index}`, {
                content: `今天的计划 ${index}`,
                kind: "future_intent",
                futureIntent: {
                    type: "plan",
                    status: "pending",
                    timePrecision: "day",
                    targetAt: "2026-09-01T14:00:00.000Z",
                },
            }),
            source: "future_intent",
        })),
        "无关上下文",
        { now, timezone: "Asia/Shanghai" },
    ),
    { tokenBudget: 10000, maxSelected: 4, maxProtectedFutureIntents: 2 },
);
assert.equal(protectedOverflow.filter(item => item.protectedReason).length, 2);

const promptText = injector.formatLongTermMemories([dueToday, tagged], {
    now,
    timezone: "Asia/Shanghai",
});
assert.match(promptText, /## 当前相关记忆/);
assert.match(promptText, /## 近期计划与约定/);
assert.match(promptText, /\[今天\]/);

console.log("memory ranking tests passed");
