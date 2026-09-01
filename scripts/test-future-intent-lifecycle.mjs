import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";

async function loadTypeScriptModule(relativePath) {
    const tempDir = await mkdtemp(join(process.cwd(), ".tmp-future-intent-lifecycle-"));
    const relativeModules = relativePath === "lib/future-intent-lifecycle.ts"
        ? [relativePath, "lib/future-intent-detector.ts", "lib/memory-extraction.ts"]
        : [relativePath];
    const moduleNames = new Map(relativeModules.map(item => [item, `${basename(item, ".ts")}.mjs`]));
    let modulePath = join(tempDir, moduleNames.get(relativePath));
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
        const outputPath = join(tempDir, outputNameFor(dependencyPath, moduleNames));
        await writeFile(outputPath, output, "utf8");
    }
    try {
        return await import(`${pathToFileURL(modulePath).href}?${Date.now()}`);
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

function outputNameFor(relativePath, moduleNames) {
    return moduleNames.get(relativePath);
}

const lifecycle = await loadTypeScriptModule("lib/future-intent-lifecycle.ts");

const classifierEvent = event("classifier-event", "周六跟小王的电影取消了", "2026-09-05T12:00:00.000Z");
const classifierCandidates = [
    memory("classifier-f0", {
        type: "plan", status: "pending", timePrecision: "day", targetAt: "2026-09-05T00:00:00.000Z",
    }, { content: "周五和用户看电影" }),
    memory("classifier-f1", {
        type: "plan", status: "pending", timePrecision: "day", targetAt: "2026-09-06T00:00:00.000Z",
    }, { content: "周六和小王看电影" }),
];
const classifierTimeContext = { now: new Date(classifierEvent.timestamp), timezone: "Asia/Shanghai" };
const lifecyclePrompt = lifecycle.buildFutureIntentLifecyclePrompt(
    classifierEvent,
    classifierTimeContext,
    lifecycleCandidatesFromEntries(classifierCandidates),
);
assert.match(lifecyclePrompt, /F0/);
assert.match(lifecyclePrompt, /F1/);
assert.match(lifecyclePrompt, /\[event_ref=classifier-event\]/);
assert.doesNotMatch(lifecyclePrompt, /classifier-f0|classifier-f1/);
assert.match(lifecyclePrompt, /当前 \[E\] 事件/);
assert.match(lifecyclePrompt, /你的唯一任务是：/);
assert.match(lifecyclePrompt, /当前这一条真实事件/);
assert.match(lifecyclePrompt, /不是聊天助手/);
assert.match(lifecyclePrompt, /不负责创建无关的新计划/);
assert.match(lifecyclePrompt, /只判断当前事件对已有 Future Intent/);
assert.match(lifecyclePrompt, /\[E\]/);
assert.match(lifecyclePrompt, /候选编号 F0、F1、F2……只是本次判断使用的临时引用/);
assert.match(lifecyclePrompt, /不得输出、猜测或构造任何真实数据库 memory id/);
assert.match(lifecyclePrompt, /一个事件最多改变一个已有 Future Intent/);
assert.match(lifecyclePrompt, /fulfilled 必须有明确完成事实/);
assert.match(lifecyclePrompt, /cancelled 必须有明确取消\/终止事实/);
assert.match(lifecyclePrompt, /replaced 必须有明确修改\/替代事实/);
assert.match(lifecyclePrompt, /当前事件是在询问是否完成、是否取消/);
assert.match(lifecyclePrompt, /当前事件只是在讨论计划，而没有明确改变计划状态/);
assert.match(lifecyclePrompt, /时间流逝不是完成证据/);
assert.match(lifecyclePrompt, /overdue 完全由外部确定性代码处理/);
assert.match(lifecyclePrompt, /你永远不要输出 action=overdue/);
assert.match(lifecyclePrompt, /相对时间必须以“当前事件时间”为参考/);
assert.match(lifecyclePrompt, /如果 replacement 的新时间无法可靠确定/);
assert.match(lifecyclePrompt, /replacement\.type 只能是/);
assert.match(lifecyclePrompt, /timePrecision 只能是/);
assert.match(lifecyclePrompt, /targetEndAt 只在确实是时间范围时提供/);
assert.match(lifecyclePrompt, /timezone 只能使用当前提供的有效参考时区/);
assert.match(lifecyclePrompt, /严格只输出一个 JSON object/);
assert.match(lifecyclePrompt, /如果无法完全满足上述 contract/);

function lifecycleCandidatesFromEntries(entries) {
    return entries.map((entry, index) => ({
        ref: `F${index}`,
        content: entry.content,
        sourceApp: entry.sourceApp,
        type: entry.futureIntent.type,
        status: entry.futureIntent.status,
        timePrecision: entry.futureIntent.timePrecision,
        targetAt: entry.futureIntent.targetAt,
        targetEndAt: entry.futureIntent.targetEndAt,
        timezone: entry.futureIntent.timezone,
        originalTimeExpression: entry.futureIntent.originalTimeExpression,
    }));
}

assert.deepEqual(lifecycle.parseFutureIntentLifecycleModelOutput(
    '{"action":"none"}',
    lifecycleCandidatesFromEntries(classifierCandidates),
    classifierTimeContext,
), { action: "none" });
assert.deepEqual(lifecycle.parseFutureIntentLifecycleModelOutput(
    '{"action":"cancelled","target":"F1"}',
    lifecycleCandidatesFromEntries(classifierCandidates),
    classifierTimeContext,
), { action: "cancelled", targetIndex: 1 });
assert.equal(lifecycle.parseFutureIntentLifecycleModelOutput(
    '{"action":"cancelled","target":"F999"}',
    lifecycleCandidatesFromEntries(classifierCandidates),
    classifierTimeContext,
), null);
assert.equal(lifecycle.parseFutureIntentLifecycleModelOutput(
    '{"action":"cancelled","target":"classifier-f1"}',
    lifecycleCandidatesFromEntries(classifierCandidates),
    classifierTimeContext,
), null);
assert.equal(lifecycle.parseFutureIntentLifecycleModelOutput(
    '{"action":"maybe","target":"F1"}',
    lifecycleCandidatesFromEntries(classifierCandidates),
    classifierTimeContext,
), null);
assert.equal(lifecycle.parseFutureIntentLifecycleModelOutput(
    '{"action":"cancelled","target":"F1"',
    lifecycleCandidatesFromEntries(classifierCandidates),
    classifierTimeContext,
), null);
assert.equal(lifecycle.parseFutureIntentLifecycleModelOutput(
    '{"action":"cancelled","target":"F1","target":"F0"}',
    lifecycleCandidatesFromEntries(classifierCandidates),
    classifierTimeContext,
), null);

const normalizedReplacementDecision = lifecycle.parseFutureIntentLifecycleModelOutput(
    JSON.stringify({
        action: "replaced",
        target: "F1",
        replacement: {
            content: "周六跟小王的电影改到周日晚上",
            type: "plan",
            timePrecision: "day",
            targetAt: "2026-09-07T00:00:00+08:00",
            originalTimeExpression: "周日晚上",
            timezone: "Asia/Shanghai",
        },
    }),
    lifecycleCandidatesFromEntries(classifierCandidates),
    classifierTimeContext,
);
assert.equal(normalizedReplacementDecision.action, "replaced");
assert.equal(normalizedReplacementDecision.targetIndex, 1);
assert.equal(normalizedReplacementDecision.replacement.futureIntent.status, "pending");
assert.equal(normalizedReplacementDecision.replacement.futureIntent.targetAt, "2026-09-07T00:00:00+08:00");

const mismatchedTimezoneDecision = lifecycle.parseFutureIntentLifecycleModelOutput(
    JSON.stringify({
        action: "replaced",
        target: "F1",
        replacement: {
            content: "周六跟小王的电影改到周日晚上",
            type: "plan",
            timePrecision: "day",
            targetAt: "2026-09-07T00:00:00+08:00",
            originalTimeExpression: "周日晚上",
            timezone: "America/New_York",
        },
    }),
    lifecycleCandidatesFromEntries(classifierCandidates),
    classifierTimeContext,
);
assert.equal(mismatchedTimezoneDecision, null);

const omittedTimezoneDecision = lifecycle.parseFutureIntentLifecycleModelOutput(
    JSON.stringify({
        action: "replaced",
        target: "F1",
        replacement: {
            content: "周六跟小王的电影改到周日晚上",
            type: "plan",
            timePrecision: "day",
            targetAt: "2026-09-07T00:00:00+08:00",
            originalTimeExpression: "周日晚上",
        },
    }),
    lifecycleCandidatesFromEntries(classifierCandidates),
    classifierTimeContext,
);
assert.equal(omittedTimezoneDecision.action, "replaced");
assert.equal(omittedTimezoneDecision.replacement.futureIntent.timezone, "Asia/Shanghai");

const unavailableReferenceTimezoneDecision = lifecycle.parseFutureIntentLifecycleModelOutput(
    JSON.stringify({
        action: "replaced",
        target: "F1",
        replacement: {
            content: "周六跟小王的电影改到周日晚上",
            type: "plan",
            timePrecision: "day",
            targetAt: "2026-09-07T00:00:00+08:00",
            originalTimeExpression: "周日晚上",
            timezone: "Asia/Shanghai",
        },
    }),
    lifecycleCandidatesFromEntries(classifierCandidates),
    { now: new Date(classifierEvent.timestamp), timezone: "Invalid/Timezone" },
);
assert.equal(unavailableReferenceTimezoneDecision, null);

const classifierFulfilled = lifecycle.decideFutureIntentTransition(
    classifierCandidates[0],
    event("classifier-complete", "电影刚看完"),
    {
        timezone: "Asia/Shanghai",
        semanticDecision: { action: "fulfilled" },
    },
);
assert.equal(classifierFulfilled.action, "fulfilled");
const lexicalOnlyEvent = lifecycle.decideFutureIntentTransition(
    classifierCandidates[0],
    event("lexical-only", "电影看完了吗？"),
    { timezone: "Asia/Shanghai" },
);
assert.equal(lexicalOnlyEvent.action, "none");

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
    { timezone: "Asia/Shanghai", semanticDecision: { action: "fulfilled" } },
);
assert.equal(fulfilled.action, "fulfilled");
assert.equal(fulfilled.nextEntry.futureIntent.status, "fulfilled");
assert.equal(fulfilled.nextEntry.futureIntent.fulfilledAt, "2026-09-05T12:00:00.000Z");
assert.equal(fulfilled.nextEntry.metadata.futureIntentLifecycle.eventId, "fulfilled-event");

const cancelled = lifecycle.decideFutureIntentTransition(
    memory("cancel", { type: "plan", status: "pending", timePrecision: "exact", targetAt: "2026-09-06T12:00:00.000Z" }, { content: "明天一起去约会" }),
    event("cancel-event", "明天那个约会取消了"),
    { timezone: "Asia/Shanghai", semanticDecision: { action: "cancelled" } },
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
    memory("replace", { type: "plan", status: "pending", timePrecision: "exact", targetAt: "2026-09-06T12:00:00.000Z" }, { content: "明天一起看电影", sourceApp: "xiaohongshu" }),
    event("reschedule-event", "电影改到周五晚上"),
    {
        timezone: "Asia/Shanghai",
        semanticDecision: {
            action: "replaced",
            replacement: {
                content: "电影改到周五晚上",
                tags: [],
                importance: 0.8,
                kind: "future_intent",
                futureIntent: {
                    type: "plan",
                    status: "pending",
                    timePrecision: "exact",
                    targetAt: "2026-09-10T12:00:00.000Z",
                    timezone: "Asia/Shanghai",
                    originalTimeExpression: "周五晚上",
                },
            },
        },
    },
);
assert.equal(replacement.action, "replaced");
assert.equal(replacement.nextEntry.futureIntent.status, "cancelled");
assert.equal(replacement.nextEntry.futureIntent.replacedByMemoryId, replacement.replacementEntry.id);
assert.equal(replacement.replacementEntry.futureIntent.status, "pending");
assert.equal(replacement.replacementEntry.futureIntent.targetAt, "2026-09-10T12:00:00.000Z");
assert.equal(replacement.replacementEntry.futureIntent.originalTimeExpression, "周五晚上");
assert.deepEqual(replacement.replacementEntry.sourceMessageIds, ["reschedule-event"]);
assert.equal(replacement.replacementEntry.sourceApp, "chat");
assert.equal(replacement.replacementEntry.futureIntent.timezone, "Asia/Shanghai");

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
    classifier: async (_event, candidates) => ({
        action: "replaced",
        targetIndex: candidates.findIndex(candidate => candidate.content === "明天一起看电影"),
        replacement: {
            content: "电影改到 2026-09-10 20:00",
            tags: [],
            importance: 0.8,
            kind: "future_intent",
            futureIntent: {
                type: "plan",
                status: "pending",
                timePrecision: "exact",
                targetAt: "2026-09-10T12:00:00.000Z",
                timezone: "Asia/Shanghai",
                originalTimeExpression: "2026-09-10 20:00",
            },
        },
    }),
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
assert.equal(lifecycle.decideFutureIntentTransition(sharedSessionEntries[0], sharedCancelEvent, {
    timezone: "Asia/Shanghai",
    semanticDecision: { action: "cancelled" },
}).action, "cancelled");
const sharedSessionRun = await lifecycle.runFutureIntentLifecycle("char-1", sharedCancelEvent, {
    store: sharedSessionStore,
    timezone: "Asia/Shanghai",
    classifier: async () => ({ action: "cancelled", targetIndex: 0 }),
});
assert.equal(sharedSessionRun.status, "cancelled");
assert.equal(sharedSessionWrites[0].filter(entry => entry.futureIntent.status === "cancelled").length, 1);

const semanticNegativeCases = [
    "电影看完了吗？",
    "你们去了没有？",
    "我看了电影预告",
    "明天不去了？",
];
for (const [index, content] of semanticNegativeCases.entries()) {
    const negativeEntry = memory(`semantic-negative-${index}`, {
        type: "plan", status: "pending", timePrecision: "exact", targetAt: "2026-09-10T12:00:00.000Z",
    }, { content: "明天一起看电影" });
    const negativeStoreEntries = [negativeEntry];
    let negativeWrites = 0;
    const negativeRun = await lifecycle.runFutureIntentLifecycle("char-1", event(`semantic-negative-event-${index}`, content), {
        store: {
            async loadMemoryEntriesByType() { return negativeStoreEntries; },
            async saveMemoryEntries() { negativeWrites += 1; },
        },
        timezone: "Asia/Shanghai",
        classifier: async () => ({ action: "none" }),
    });
    assert.equal(negativeRun.status, "no_change");
    assert.equal(negativeWrites, 0);
    assert.equal(negativeEntry.futureIntent.status, "pending");
}

const multiCandidateStoreEntries = [
    memory("multi-f0", {
        type: "plan", status: "pending", timePrecision: "day", targetAt: "2026-09-05T00:00:00.000Z",
    }, { content: "周五和用户看电影" }),
    memory("multi-f1", {
        type: "plan", status: "pending", timePrecision: "day", targetAt: "2026-09-06T00:00:00.000Z",
    }, { content: "周六和小王看电影" }),
];
let multiCandidateWrites = [];
const multiCandidateRun = await lifecycle.runFutureIntentLifecycle(
    "char-1",
    event("multi-cancel", "周六跟小王的电影取消了", "2026-09-05T12:00:00.000Z"),
    {
        store: {
            async loadMemoryEntriesByType() { return multiCandidateStoreEntries; },
            async saveMemoryEntries(entries) {
                multiCandidateWrites.push(entries);
                for (const entry of entries) {
                    const index = multiCandidateStoreEntries.findIndex(item => item.id === entry.id);
                    if (index >= 0) multiCandidateStoreEntries[index] = entry;
                }
            },
        },
        timezone: "Asia/Shanghai",
        classifier: async (_event, candidates) => ({
            action: "cancelled",
            targetIndex: candidates.findIndex(candidate => candidate.content === "周六和小王看电影"),
        }),
    },
);
assert.equal(multiCandidateRun.status, "cancelled");
assert.equal(multiCandidateWrites[0].find(entry => entry.id === "multi-f1").futureIntent.status, "cancelled");
assert.equal(multiCandidateStoreEntries.find(entry => entry.id === "multi-f0").futureIntent.status, "pending");

const ambiguousRun = await lifecycle.runFutureIntentLifecycle(
    "char-1",
    event("ambiguous-cancel", "电影不去了", "2026-09-05T12:00:00.000Z"),
    {
        store: {
            async loadMemoryEntriesByType() { return multiCandidateStoreEntries; },
            async saveMemoryEntries() { throw new Error("ambiguous event should not write"); },
        },
        timezone: "Asia/Shanghai",
        classifier: async () => ({ action: "none" }),
    },
);
assert.equal(ambiguousRun.status, "no_change");

const modelFailureEntry = memory("model-failure-overdue", {
    type: "plan", status: "pending", timePrecision: "exact", targetAt: "2026-09-01T12:00:00.000Z",
});
let modelFailureWrites = [];
const modelFailureRun = await lifecycle.runFutureIntentLifecycle(
    "char-1",
    event("model-failure-event", "普通聊天", "2026-09-05T12:00:00.000Z"),
    {
        store: {
            async loadMemoryEntriesByType() { return [modelFailureEntry]; },
            async saveMemoryEntries(entries) { modelFailureWrites.push(entries); },
        },
        timezone: "Asia/Shanghai",
        classifier: async () => { throw new Error("classifier unavailable"); },
    },
);
assert.equal(modelFailureRun.status, "overdue");
assert.equal(modelFailureWrites[0][0].futureIntent.status, "overdue");

const unavailableEntry = memory("model-unavailable", {
    type: "plan", status: "pending", timePrecision: "exact", targetAt: "2026-09-10T12:00:00.000Z",
}, { content: "明天一起看电影" });
let unavailableWrites = 0;
const unavailableRun = await lifecycle.runFutureIntentLifecycle(
    "char-1",
    event("model-unavailable-event", "电影看完了", "2026-09-05T12:00:00.000Z"),
    {
        store: {
            async loadMemoryEntriesByType() { return [unavailableEntry]; },
            async saveMemoryEntries() { unavailableWrites += 1; },
        },
        timezone: "Asia/Shanghai",
    },
);
assert.equal(unavailableRun.status, "no_change");
assert.equal(unavailableWrites, 0);
assert.equal(unavailableEntry.futureIntent.status, "pending");

const terminalFulfilled = memory("terminal-fulfilled", {
    type: "plan", status: "fulfilled", timePrecision: "exact", targetAt: "2026-09-01T12:00:00.000Z",
    fulfilledAt: "2026-09-01T13:00:00.000Z",
});
const terminalCancelled = memory("terminal-cancelled", {
    type: "plan", status: "cancelled", timePrecision: "exact", targetAt: "2026-09-01T12:00:00.000Z",
    cancelledAt: "2026-09-01T13:00:00.000Z",
});
assert.equal(lifecycle.decideFutureIntentTransition(terminalFulfilled, event("later-cancel", "取消电影"), {
    semanticDecision: { action: "cancelled" },
}).action, "none");
assert.equal(lifecycle.decideFutureIntentTransition(terminalCancelled, event("later-fulfill", "电影看完了"), {
    semanticDecision: { action: "fulfilled" },
}).action, "none");

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
const lifecycleSource = await readFile(new URL("../lib/future-intent-lifecycle.ts", import.meta.url), "utf8");
const migrationSource = await readFile(new URL("../lib/data-management/idb.ts", import.meta.url), "utf8");
const memoryStorageSource = await readFile(new URL("../lib/memory-storage.ts", import.meta.url), "utf8");
const chatStorageSource = await readFile(new URL("../lib/chat-storage.ts", import.meta.url), "utf8");
const groupChatSource = await readFile(new URL("../lib/group-chat-engine.ts", import.meta.url), "utf8");
assert.doesNotMatch(memoryServiceSource, /runFutureIntentLifecycle|saveMemoryEntries/);
assert.doesNotMatch(promptAssemblerSource, /runFutureIntentLifecycle|saveMemoryEntries/);
assert.doesNotMatch(migrationSource, /runFutureIntentLifecycle|saveMemoryEntries/);
assert.match(lifecycleSource, /memorySummaryApiConfigId/);
assert.match(lifecycleSource, /normalizeFutureIntentCandidate/);
assert.doesNotMatch(lifecycleSource, /FULFILMENT_PATTERN|CANCELLATION_PATTERN|RESCHEDULE_PATTERN|hasIntentRelation/);
assert.match(memoryStorageSource, /maybeRunFutureIntentLifecycle/);
assert.match(memoryStorageSource, /lifecycleResult\?\.status === "replaced"/);
assert.match(chatStorageSource, /incrementEventCounter\(persistedSession\.contactId, toFutureIntentEvent\(newMsg\)\)/);
assert.match(groupChatSource, /incrementEventCounter\(characterId, \{/);

console.log("future intent lifecycle tests passed");
