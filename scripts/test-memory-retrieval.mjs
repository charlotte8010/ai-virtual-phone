import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { createContext, SourceTextModule } from "node:vm";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const context = createContext({ console });
context.__testMemories = [];
context.__testConfig = null;
context.__testEmbeddingConfig = null;
context.__testEmbeddingModel = null;
context.__queryEmbedding = [1, 0];
context.__embeddingQueries = [];

const mockSources = new Map([
    [resolve(repoRoot, "lib/memory-storage.ts"), `
        export function loadMemoryConfig() { return globalThis.__testConfig; }
        export async function loadMemoryEntriesByType() { return globalThis.__testMemories; }
    `],
    [resolve(repoRoot, "lib/settings-storage.ts"), `
        export function resolveAuxiliaryApiConfig() { return globalThis.__testEmbeddingConfig; }
    `],
    [resolve(repoRoot, "lib/memory-embedding.ts"), `
        export function resolveEmbeddingModel() { return globalThis.__testEmbeddingModel; }
        export async function generateEmbedding(query) {
            globalThis.__embeddingQueries.push(query);
            return globalThis.__queryEmbedding;
        }
        export function cosineSimilarity(a, b) {
            if (a.length !== b.length || a.length === 0) return 0;
            let dot = 0;
            let magA = 0;
            let magB = 0;
            for (let index = 0; index < a.length; index += 1) {
                dot += a[index] * b[index];
                magA += a[index] * a[index];
                magB += b[index] * b[index];
            }
            const denominator = Math.sqrt(magA) * Math.sqrt(magB);
            return denominator === 0 ? 0 : dot / denominator;
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

    const source = mockSources.get(normalizedPath)
        ?? await readFile(normalizedPath, "utf8");
    const code = mockSources.has(normalizedPath)
        ? source
        : ts.transpileModule(source, {
            compilerOptions: {
                target: ts.ScriptTarget.ES2022,
                module: ts.ModuleKind.ESNext,
                moduleResolution: ts.ModuleResolutionKind.Bundler,
            },
        }).outputText;
    const module = new SourceTextModule(code, {
        context,
        identifier: normalizedPath,
    });
    moduleCache.set(normalizedPath, module);
    await module.link((specifier, referencingModule) => loadModule(
        sourceModulePath(specifier, referencingModule),
    ));
    return module;
}

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

const dueToday = memory("due-today", {
    content: "今天要提醒用户复诊。",
    kind: "future_intent",
    importance: 0.7,
    futureIntent: {
        type: "promise",
        status: "pending",
        timePrecision: "exact",
        targetAt: "2026-09-01T14:00:00.000Z",
    },
});
const overdue = memory("overdue", {
    content: "昨天答应提醒用户复诊，但还没有确认。",
    kind: "future_intent",
    futureIntent: {
        type: "plan",
        status: "overdue",
        timePrecision: "day",
        targetAt: "2026-08-31T14:00:00.000Z",
    },
});
const recent = memory("recent", {
    content: "最近记录的一件普通事情。",
    kind: "event",
    updatedAt: "2026-09-01T11:00:00.000Z",
});
const config = {
    cognitiveMemoryEnabled: true,
    vectorRecallEnabled: true,
    hybridRecallEnabled: true,
    longTermTokenBudget: 10000,
    maxSelectedLongTermMemories: 10,
    maxProtectedFutureIntents: 3,
};

context.__testMemories = [dueToday, overdue, recent];
context.__testConfig = config;
context.__testEmbeddingConfig = { provider: "OpenAI", defaultModel: "text-embedding-3-small" };
context.__testEmbeddingModel = "text-embedding-3-small";

const serviceModule = await loadModule(resolve(repoRoot, "lib/memory-service.ts"));
await serviceModule.evaluate();
const result = await serviceModule.namespace.selectMemoriesForPrompt("char-1", "", {
    config,
    now: new Date("2026-09-01T12:00:00.000Z"),
    timezone: "Asia/Shanghai",
    maxSelected: 10,
});

assert.ok(result.selected.some(entry => entry.id === "due-today"));
assert.ok(result.selected.some(entry => entry.id === "overdue"));
assert.ok(result.selected.some(entry => entry.id === "recent"));
assert.equal(result.debug.channelCounts.vector, 0);
assert.equal(result.debug.channelCounts.keyword, 0);
assert.ok(result.debug.channelCounts.future_intent > 0);
assert.ok(result.debug.channelCounts.recent > 0);
assert.deepEqual(context.__embeddingQueries, []);

console.log("memory retrieval tests passed");
