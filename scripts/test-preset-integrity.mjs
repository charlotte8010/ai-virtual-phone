import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { createContext, SourceTextModule } from "node:vm";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modulePath = resolve(repoRoot, "lib/preset-integrity.ts");
const source = await readFile(modulePath, "utf8");
const code = ts.transpileModule(source, {
    compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
}).outputText;
const module = new SourceTextModule(code, {
    context: createContext({ console }),
    identifier: modulePath,
});
await module.link(() => {
    throw new Error("preset-integrity should have no runtime imports");
});
await module.evaluate();

const { repairPresetPromptIntegrity, repairPresetCollectionIntegrity } = module.namespace;

function prompt(identifier, name, content, enabled = true) {
    return {
        identifier,
        name,
        role: "system",
        content,
        injection_depth: 0,
        enabled,
    };
}

function preset(overrides = {}) {
    return {
        id: "preset-1",
        name: "Test",
        description: "",
        createdAt: 1,
        updatedAt: 1,
        temperature: 1,
        top_p: 1,
        top_k: 0,
        frequency_penalty: 0,
        presence_penalty: 0,
        repetition_penalty: 1,
        openai_max_tokens: 0,
        openai_max_context: 100000,
        prompts: [],
        prompt_order: [],
        ...overrides,
    };
}

// Exact accidental duplicate + duplicate/stale order entries collapse safely.
{
    const duplicate = prompt("alpha", "Alpha", "same");
    const input = preset({
        prompts: [duplicate, { ...duplicate }, prompt("beta", "Beta", "b")],
        prompt_order: [
            { identifier: "alpha", enabled: true },
            { identifier: "alpha", enabled: false },
            { identifier: "missing", enabled: true },
            { identifier: "beta", enabled: true },
        ],
    });
    const result = repairPresetPromptIntegrity(input);
    assert.equal(result.changed, true);
    assert.deepEqual(result.preset.prompts.map(item => item.identifier), ["alpha", "beta"]);
    assert.deepEqual(result.preset.prompt_order, [
        { identifier: "alpha", enabled: true },
        { identifier: "beta", enabled: true },
    ]);
    assert.equal(result.stats.droppedExactPromptDuplicates, 1);
    assert.equal(result.stats.removedDuplicateOrderEntries, 1);
    assert.equal(result.stats.removedStaleOrderEntries, 1);
}

// Distinct user content sharing an identifier is preserved, not discarded.
{
    const input = preset({
        prompts: [
            prompt("alpha", "Alpha 1", "one", true),
            prompt("alpha", "Alpha 2", "two", false),
            prompt("alpha__2", "Already used", "three", true),
        ],
        prompt_order: [
            { identifier: "alpha", enabled: true },
            { identifier: "alpha", enabled: false },
            { identifier: "alpha__2", enabled: true },
        ],
    });
    const result = repairPresetPromptIntegrity(input);
    const ids = result.preset.prompts.map(item => item.identifier);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, ["alpha", "alpha__3", "alpha__2"]);
    assert.deepEqual(result.preset.prompt_order, [
        { identifier: "alpha", enabled: true },
        { identifier: "alpha__3", enabled: false },
        { identifier: "alpha__2", enabled: true },
    ]);
    assert.equal(result.stats.renamedPromptIdentifiers, 1);
}

// Missing order entries are appended exactly once and blank identifiers are repaired deterministically.
{
    const input = preset({
        prompts: [prompt("", "Blank", "x"), prompt("beta", "Beta", "b", false)],
        prompt_order: [{ identifier: "beta", enabled: false }],
    });
    const result = repairPresetPromptIntegrity(input);
    assert.deepEqual(result.preset.prompts.map(item => item.identifier), ["prompt_1", "beta"]);
    assert.deepEqual(result.preset.prompt_order, [
        { identifier: "beta", enabled: false },
        { identifier: "prompt_1", enabled: true },
    ]);
    assert.equal(result.stats.appendedMissingOrderEntries, 1);
}

// Repair is idempotent.
{
    const input = preset({
        prompts: [prompt("same", "A", "a"), prompt("same", "B", "b")],
        prompt_order: [
            { identifier: "same", enabled: true },
            { identifier: "same", enabled: false },
        ],
    });
    const once = repairPresetPromptIntegrity(input);
    const twice = repairPresetPromptIntegrity(once.preset);
    assert.equal(once.changed, true);
    assert.equal(twice.changed, false);
    assert.deepEqual(twice.preset, once.preset);
}

// Collection result reports only the presets that actually changed.
{
    const clean = preset({ id: "clean", prompts: [prompt("a", "A", "a")], prompt_order: [{ identifier: "a", enabled: true }] });
    const dirty = preset({ id: "dirty", prompts: [prompt("x", "X", "x"), prompt("x", "X", "x")], prompt_order: [{ identifier: "x", enabled: true }] });
    const result = repairPresetCollectionIntegrity([clean, dirty]);
    assert.equal(result.changed, true);
    assert.equal(result.repairedPresetCount, 1);
    assert.equal(result.presets[1].prompts.length, 1);
}

console.log("preset integrity tests passed");
