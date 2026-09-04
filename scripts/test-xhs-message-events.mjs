import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, SourceTextModule } from "node:vm";
import { resolve } from "node:path";
import * as ts from "typescript";

const repoRoot = resolve(import.meta.dirname, "..");
const sourcePath = resolve(repoRoot, "lib/chat-message-events.ts");
const source = await readFile(sourcePath, "utf8");
const context = createContext({ console });
const events = [];
context.window = {
    dispatchEvent(event) {
        events.push(event);
        return true;
    },
};
context.CustomEvent = class FakeCustomEvent {
    constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
    }
};

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

module.namespace.dispatchChatMessagesUpdated("session-1", "message-1");
assert.equal(events.length, 1);
assert.equal(events[0].type, "chat-messages-updated");
assert.equal(events[0].detail.sessionId, "session-1");
assert.equal(events[0].detail.messageId, "message-1");

console.log("xhs message update event tests passed");
