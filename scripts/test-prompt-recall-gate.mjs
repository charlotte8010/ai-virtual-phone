import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { createContext, SourceTextModule } from "node:vm";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const context = createContext({ console });

const mockSources = new Map([
    [resolve(repoRoot, "lib/macro-engine.ts"), `
        export class MacroEngine {
            constructor(charName, userName) { this.charName = charName; this.userName = userName; }
            expand(value) {
                return String(value)
                    .replaceAll("{{char}}", this.charName)
                    .replaceAll("{{user}}", this.userName);
            }
        }
        export function postProcessTrim(value) { return String(value).trim(); }
    `],
    [resolve(repoRoot, "lib/dwelling-storage.ts"), `
        export function readDwellingLayoutCache() { return null; }
    `],
    [resolve(repoRoot, "lib/dwelling-engine.ts"), `
        export function formatDwellingContext() { return ""; }
    `],
    [resolve(repoRoot, "lib/content-tag-utils.ts"), `
        export function matchesActiveTags(tags, activeTags) {
            return !tags || tags.length === 0 || tags.every(tag => activeTags.includes(tag));
        }
    `],
    [resolve(repoRoot, "lib/chat-share.ts"), `
        export function formatXiaohongshuShareForPrompt() { return ""; }
    `],
    [resolve(repoRoot, "lib/prompt-sanitizer.ts"), `
        export function stripStateAndInnerForPrompt(value) { return value; }
    `],
    [resolve(repoRoot, "lib/prompt-time.ts"), `
        export function formatPromptTimestamp(value) { return value; }
        export function getPromptTimestampOptionsForTimeContext() { return { showTimestamp: false }; }
        export function resolvePromptTimeAware(value) { return value !== false; }
    `],
    [resolve(repoRoot, "lib/character-world-storage.ts"), `
        export function formatCharacterRelationsForPrompt() { return ""; }
    `],
    [resolve(repoRoot, "lib/character-time.ts"), `
        export function buildCharacterTimeContext() {
            return {
                timeContext: "",
                systemTimeZone: "UTC",
                characterTime: "",
                characterTimeZone: "UTC",
                characterWeekday: "",
            };
        }
        export function buildGroupTimeContext() { return buildCharacterTimeContext(); }
    `],
    [resolve(repoRoot, "lib/shopping-payment-request.ts"), `
        export function formatShoppingPaymentRequestHistory() { return ""; }
    `],
    [resolve(repoRoot, "lib/group-admin.ts"), `
        export function buildGroupAdminBracketText() { return ""; }
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

const assemblerModule = await loadModule(resolve(repoRoot, "lib/llm-prompt-assembler.ts"));
await assemblerModule.evaluate();
const { assembleGroupPromptPayload, assemblePromptPayload } = assemblerModule.namespace;

const character = {
    id: "char-1",
    name: "角色",
    persona: "角色设定",
    personality: "温和",
    timeZone: "UTC",
};

function presetForMemory(enabled = true) {
    return {
        name: "recall gate test",
        prompts: [{
            identifier: "memoryLongTerm",
            name: "长期记忆",
            role: "system",
            content: "",
            enabled,
            marker: true,
        }],
    };
}

function assembleSingle({ preset = presetForMemory(), longTermMemories = "记忆内容", regexes = [], callback }) {
    return assemblePromptPayload({
        character,
        history: [],
        preset,
        worldBooks: [],
        regexes,
        longTermMemories,
        onLongTermMemoriesInjected: callback,
    });
}

let callbackCount = 0;
assembleSingle({ preset: presetForMemory(false), callback: () => { callbackCount += 1; } });
assert.equal(callbackCount, 0, "disabled memory marker must not recall");

assembleSingle({ longTermMemories: "   ", callback: () => { callbackCount += 1; } });
assert.equal(callbackCount, 0, "empty memory must not recall");

const actualPayload = assembleSingle({ callback: () => { callbackCount += 1; } });
assert.equal(callbackCount, 1, "real final memory injection must recall exactly once");
assert.ok(actualPayload.some(message => String(message.content).includes("记忆内容")));

const clearMemoryRegex = [{
    id: "clear-memory",
    name: "clear memory",
    rules: [{
        findRegex: "/记忆内容/g",
        replaceString: "",
        placement: [1],
        promptOnly: true,
    }],
}];
const beforeRegexCleared = callbackCount;
const clearedPayload = assembleSingle({ regexes: clearMemoryRegex, callback: () => { callbackCount += 1; } });
assert.equal(callbackCount, beforeRegexCleared, "regex-cleared memory contribution must not recall");
assert.ok(clearedPayload.every(message => !String(message.content).includes("记忆内容")));

function assembleGroup({ preset = presetForMemory(), regexes = [], callback }) {
    return assembleGroupPromptPayload({
        members: [{
            character,
            worldBooks: [],
            longTermMemories: "群聊记忆",
            onLongTermMemoriesInjected: callback,
        }],
        history: [],
        preset,
        regexes,
        appTags: ["group_chat"],
    });
}

let groupCallbackCount = 0;
assembleGroup({ preset: presetForMemory(false), callback: () => { groupCallbackCount += 1; } });
assert.equal(groupCallbackCount, 0, "disabled group memory marker must not recall");

const groupPayload = assembleGroup({ callback: () => { groupCallbackCount += 1; } });
assert.equal(groupCallbackCount, 1, "real group memory injection must recall exactly once");
assert.ok(groupPayload.some(message => String(message.content).includes("群聊记忆")));

const groupClearMemoryRegex = [{
    id: "clear-group-memory",
    name: "clear group memory",
    rules: [{
        findRegex: "/群聊记忆/g",
        replaceString: "",
        placement: [1],
        promptOnly: true,
    }],
}];
const beforeGroupRegexCleared = groupCallbackCount;
const groupClearedPayload = assembleGroup({
    regexes: groupClearMemoryRegex,
    callback: () => { groupCallbackCount += 1; },
});
assert.equal(groupCallbackCount, beforeGroupRegexCleared, "regex-cleared group memory contribution must not recall");
assert.ok(groupClearedPayload.every(message => !String(message.content).includes("群聊记忆")));

console.log("prompt recall gate tests passed");
