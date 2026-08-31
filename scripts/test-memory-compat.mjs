import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as ts from "typescript";

const sourceUrl = new URL("../lib/memory-compat.ts", import.meta.url);
const source = await readFile(sourceUrl, "utf8");
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
});
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString("base64")}`;
const { normalizeMemoryEntry } = await import(moduleUrl);

const oldEntry = {
    id: "legacy-1",
    characterId: "char-1",
    sourceApp: "chat",
    type: "long_term",
    content: "用户喜欢雨天散步。",
    importance: 0.6,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
};
const oldSnapshot = structuredClone(oldEntry);

assert.deepEqual(normalizeMemoryEntry(oldEntry), {
    ...oldEntry,
    tags: [],
    kind: "event",
    accessCount: 0,
    stability: 0.59,
});
assert.deepEqual(oldEntry, oldSnapshot);

const coreEntry = normalizeMemoryEntry({
    ...oldEntry,
    id: "core-1",
    type: "core",
});
assert.equal(coreEntry.stability, 0.95);

const enrichedEntry = normalizeMemoryEntry({
    ...oldEntry,
    tags: ["雨天", "散步"],
    kind: "user_fact",
    accessCount: 4,
    stability: 0.72,
});
assert.deepEqual(enrichedEntry.tags, ["雨天", "散步"]);
assert.equal(enrichedEntry.kind, "user_fact");
assert.equal(enrichedEntry.accessCount, 4);
assert.equal(enrichedEntry.stability, 0.72);

console.log("memory compatibility tests passed");
