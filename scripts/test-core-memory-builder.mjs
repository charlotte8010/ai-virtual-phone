import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { createContext, SourceTextModule } from "node:vm";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const context = createContext({ console, setTimeout });
context.__testMemories = [];
context.__testConfig = {
    autoBuildCoreEnabled: true,
    coreMemoryPrompt: "角色：{{char}}\n{{events}}",
};
context.__savedEntries = [];
context.__prompts = [];

const mockSources = new Map([
    [resolve(repoRoot, "lib/memory-types.ts"), `
        export const DEFAULT_CORE_MEMORY_PROMPT = "角色：{{char}}\\n{{events}}";
    `],
    [resolve(repoRoot, "lib/memory-storage.ts"), `
        export function loadMemoryConfig() { return globalThis.__testConfig; }
        export async function loadMemoryEntriesByType(characterId, type) {
            return globalThis.__testMemories.filter(entry => entry.characterId === characterId && entry.type === type);
        }
        export async function saveMemoryEntry(entry) { globalThis.__savedEntries.push(entry); }
        export function getCoreMemoryCounter() { return 0; }
        export function resetCoreMemoryCounter() {}
        export function getLastCoreSummarizedTimestamp() { return undefined; }
        export function setLastCoreSummarizedTimestamp() {}
    `],
    [resolve(repoRoot, "lib/settings-storage.ts"), `
        export function resolveAuxiliaryApiConfig() { return { id: "memory-summary" }; }
    `],
    [resolve(repoRoot, "lib/api-helpers.ts"), `
        export async function simpleLLMCall(_config, messages) {
            globalThis.__prompts.push(messages[0].content);
            return { content: "稳定核心摘要", wasTruncated: false };
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

const builder = await loadModule(resolve(repoRoot, "lib/core-memory-builder.ts"));
await builder.evaluate();

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

const futureIntents = ["pending", "overdue", "fulfilled", "cancelled"].map(status => memory(
    `future-${status}`,
    {
        kind: "future_intent",
        content: `Future Intent ${status}`,
        futureIntent: { type: "plan", status, timePrecision: "unknown" },
    },
));
const ordinaryEntries = [
    memory("event", { kind: "event", content: "ordinary event should be summarized" }),
    memory("relationship", { kind: "relationship", content: "relationship should be summarized" }),
    memory("user-fact", { kind: "user_fact", content: "user fact should be summarized" }),
    memory("self-fact", { kind: "self_fact", content: "self fact should be summarized" }),
    memory("knowledge", { kind: "knowledge", content: "knowledge should be summarized" }),
    memory("legacy", { content: "legacy memory without kind should be summarized" }),
];

const mixedEntries = [...futureIntents, ...ordinaryEntries];
const mixedSnapshot = structuredClone(mixedEntries);
context.__testMemories = mixedEntries;
context.__savedEntries.length = 0;
context.__prompts.length = 0;

const mixedResult = await builder.namespace.runCoreMemoryPipeline("char-1", "角色", { force: true });
assert.equal(mixedResult.success, true);
assert.equal(mixedResult.rebuiltCount, 1);
assert.equal(context.__prompts.length, 1);
for (const status of ["pending", "overdue", "fulfilled", "cancelled"]) {
    assert.doesNotMatch(context.__prompts[0], new RegExp(`Future Intent ${status}`));
}
for (const entry of ordinaryEntries) {
    assert.match(context.__prompts[0], new RegExp(entry.content));
}
assert.equal(context.__savedEntries.length, 1);
assert.deepEqual(context.__testMemories, mixedSnapshot);

const allFutureSnapshot = structuredClone(futureIntents);
context.__testMemories = futureIntents;
context.__savedEntries.length = 0;
context.__prompts.length = 0;

const allFutureResult = await builder.namespace.runCoreMemoryPipeline("char-1", "角色", { force: true });
assert.equal(allFutureResult.success, false);
assert.equal(allFutureResult.error, "没有可用于总结核心记忆的长期记忆");
assert.equal(context.__savedEntries.length, 0);
assert.equal(context.__prompts.length, 0);
assert.deepEqual(context.__testMemories, allFutureSnapshot);

console.log("core memory builder guardrail tests passed");
