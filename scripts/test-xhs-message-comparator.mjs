import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, SourceTextModule } from "node:vm";
import { resolve } from "node:path";
import * as ts from "typescript";

const repoRoot = resolve(import.meta.dirname, "..");
const sourcePath = resolve(repoRoot, "lib/chat-message-comparator.ts");
const source = await readFile(sourcePath, "utf8");
const context = createContext({ console });
const module = new SourceTextModule(ts.transpileModule(source, {
    compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
    },
}).outputText, { context, identifier: sourcePath });
await module.link(() => {
    throw new Error("test module should not have imports");
});
await module.evaluate();

const base = {
    id: "message-1",
    sessionId: "session-1",
    role: "user",
    content: "https://www.xiaohongshu.com/explore/abc123",
    mediaType: "plugin:xhs-card",
    mediaData: { title: "旧标题", loading: true },
};

assert.equal(module.namespace.areChatMessagesEqualForBubble(base, { ...base }), true);
assert.equal(module.namespace.areChatMessagesEqualForBubble(base, {
    ...base,
    mediaData: { title: "新标题", loading: false },
}), false, "plugin mediaData changes must re-render the bubble");

console.log("xhs message comparator tests passed");
