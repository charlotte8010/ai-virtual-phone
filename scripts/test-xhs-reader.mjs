import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, SourceTextModule } from "node:vm";

const pluginPath = "D:/file/1/xhs-reader.js";
const scheduled = [];
const storage = new Map();
const transforms = new Map();
const events = new Map();
const renderers = new Map();
const settings = {
    workerUrl: "https://worker.test",
    apiKey: "",
    fetchComments: false,
    commentCount: 10,
    commentSort: "latest_v2",
    sendImages: false,
    maxImages: 5,
};
const hostSetTimeout = globalThis.setTimeout;

const context = createContext({
    console,
    setTimeout(callback, delay) {
        if (delay === 100) return hostSetTimeout(callback, delay);
        scheduled.push(callback);
        return scheduled.length;
    },
    clearTimeout() {},
    window: { open() {} },
    document: { querySelectorAll() { return []; } },
});

let resolveCardResponse;
let cardFetchStarted = false;
context.fetch = async () => {
    throw new Error("plugin should use ctx.system.fetch");
};

const ctx = {
    hooks: {
        transform(point, handler) {
            transforms.set(point, handler);
        },
        on(point, handler) {
            events.set(point, handler);
        },
    },
    ui: {
        messageKind(kind, renderer) {
            renderers.set(kind, renderer);
        },
        toast() {
            return { close() {} };
        },
    },
    system: {
        settings: { get(key) { return settings[key]; } },
        timers: { setInterval() {} },
        storage: {
            async get(key) { return storage.get(key) ?? null; },
            async set(key, value) { storage.set(key, value); },
            async remove(key) { storage.delete(key); },
        },
        async fetch(url) {
            if (url.endsWith("/api/xhs-card")) {
                cardFetchStarted = true;
                return new Promise(resolve => { resolveCardResponse = resolve; });
            }
            throw new Error(`unexpected fetch: ${url}`);
        },
        log() {},
    },
    data: { messages: { update() {} } },
    ai: { async chat() { return ""; } },
};

const source = await readFile(pluginPath, "utf8");
const module = new SourceTextModule(source, { context, identifier: pluginPath });
await module.link(() => {
    throw new Error("plugin should be self-contained");
});
await module.evaluate();
module.namespace.default.setup(ctx);

const renderer = renderers.get("xhs-card");
assert.equal(typeof renderer, "function");
const element = {
    style: {},
    parentElement: null,
    _innerHTML: "",
    set innerHTML(value) { this._innerHTML = String(value); },
    get innerHTML() { return this._innerHTML; },
    querySelector() { return null; },
};
renderer(element, {
    mediaData: {
        title: "测试帖子",
        author: "作者A",
        body: "这是帖子正文",
        loading: false,
    },
});
assert.match(element.innerHTML, /这是帖子正文/);
assert.equal(scheduled.length, 0, "renderer must update through React message state, not parent.innerHTML");

const persisted = events.get("message.persisted");
const request = transforms.get("llm.request");
assert.equal(typeof persisted, "function");
assert.equal(typeof request, "function");

const noteUrl = "https://www.xiaohongshu.com/explore/abc123";
const persistedPromise = persisted({
    message: {
        id: "msg-1",
        sessionId: "session-1",
        role: "user",
        content: noteUrl,
        mediaType: "plugin:xhs-card",
    },
});
await Promise.resolve();
assert.equal(cardFetchStarted, true);

let requestResolved = false;
const requestPromise = request({
    sessionId: "session-1",
    purpose: "chat",
    messages: [{ role: "user", content: noteUrl }],
});
requestPromise.then(() => { requestResolved = true; });
await Promise.resolve();
assert.equal(requestResolved, false, "llm.request must wait for the pending XHS enrichment");

resolveCardResponse({
    async json() {
        return {
            ok: true,
            source: "direct",
            note: {
                title: "测试帖子",
                author: "作者A",
                desc: "这是帖子正文",
                likedCount: 7,
                commentCount: 1,
                collectedCount: 2,
                imageCount: 0,
                images: [],
                tags: ["记录"],
                comments: [{ user: "评论者", content: "评论内容", ipLocation: "上海", likeCount: 3 }],
                type: "normal",
            },
        };
    },
});

await persistedPromise;
const requestResult = await requestPromise;
assert.ok(Array.isArray(requestResult.messages[0].content));
const noteTextPart = requestResult.messages[0].content.find(part => typeof part.text === "string" && part.text.includes("小红书笔记"));
assert.ok(noteTextPart);
assert.match(noteTextPart.text, /这是帖子正文/);
assert.match(noteTextPart.text, /评论内容/);

console.log("xhs reader tests passed");
