import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, SourceTextModule } from "node:vm";
import { resolve } from "node:path";
import * as ts from "typescript";

const repoRoot = resolve(import.meta.dirname, "..");
const sourcePath = resolve(repoRoot, "lib/chat-share.ts");
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

const text = module.namespace.formatXiaohongshuReaderCardForPrompt({
    author: "作者A",
    title: "测试帖子",
    body: "这是帖子正文",
    description: "配图说明",
    tags: ["生活", "记录"],
    comments: [{ user: "评论者", content: "评论内容", ipLocation: "上海", likeCount: 3 }],
});

assert.match(text, /作者A/);
assert.match(text, /测试帖子/);
assert.match(text, /这是帖子正文/);
assert.match(text, /评论者/);
assert.match(text, /评论内容/);
assert.match(text, /上海/);

console.log("xhs card prompt tests passed");
