import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileMigrationModules } from "./migration-ts-loader.mjs";

const packagePath = "E:/OneDrive/Documents/ChatGPT/小手机/御茗_sully-to-float_no-moments_no-worldepisode_2026-09-01.float-migration.zip";
const runtime = await compileMigrationModules();

try {
  const { readFloatMigrationPackage } = runtime.requireModule("format/read-package.js");
  const { dryRunFloatMigrationPackage } = runtime.requireModule("native/importer.js");

  const read = await readFloatMigrationPackage(await readFile(packagePath));
  assert.equal(read.ok, true, read.ok ? "" : read.errors.join("\n"));
  const payload = read.payload;
  const emptySnapshot = {
    identities: [], characters: [], contacts: [], sessions: [], messages: [], mediaIds: [],
    moments: [], momentComments: [], diaries: [], worlds: [], worldbooks: [], calendar: [],
    memories: [], storySessions: [], storyMessages: [],
  };
  const storage = {
    kind: "isolated-browser",
    async readSnapshot() { return emptySnapshot; },
  };

  const prepared = await dryRunFloatMigrationPackage(await readFile(packagePath), { storage });
  assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.errors.join("\n"));
  const { plan, summary } = prepared.dryRun;
  const offline = payload.messages.filter((message) => message.sourceMetadata?.source === "date");
  const offlineIds = new Set(offline.map((message) => message.migrationId));

  assert.equal(summary.sourceMessages, 5153);
  assert.equal(summary.chatMessages, 4708);
  assert.equal(summary.storyMessages, 445);
  assert.equal(summary.storySessions, 1);
  assert.equal(plan.messages.length, 4708);
  assert.equal(plan.storyMessages.length, 445);
  assert.equal(plan.storySessions.length, 1);
  assert.equal(plan.archive.stories.length, 193);

  const chatSourceIds = new Set(plan.messages.map((message) => message.id));
  const storySourceIds = new Set(plan.storyMessages.map((message) => message.id));
  assert.equal([...chatSourceIds].some((id) => storySourceIds.has(id)), false);
  assert.equal(Object.keys(plan.idMap.messages ?? {}).length, 4708);
  assert.equal(Object.keys(plan.idMap.storyMessages ?? {}).length, 445);
  assert.equal(Object.keys(plan.idMap.storySessions ?? {}).length, 1);

  const sourceById = new Map(payload.messages.map((message) => [message.migrationId, message]));
  for (const message of plan.storyMessages) {
    const sourceId = Object.entries(plan.idMap.storyMessages).find(([, id]) => id === message.id)?.[0];
    assert.ok(sourceId && offlineIds.has(sourceId));
    const source = sourceById.get(sourceId);
    assert.ok(source);
    assert.equal(message.rawContent, source.content);
    assert.equal(message.createdAt, new Date(source.createdAt).toISOString());
    assert.ok(message.role === "user" || message.role === "assistant");
    assert.equal(message.renderedContent, undefined);
    assert.equal(message.storySummary, undefined);
    assert.equal(message.regexSignature, undefined);
    assert.equal(message.parserVersion, undefined);
  }

  const counts = new Map();
  for (const message of offline) {
    const character = message.characterRef ?? payload.conversations.find((conversation) => conversation.migrationId === message.conversationRef)?.characterRef;
    const current = counts.get(character) ?? { total: 0, user: 0, assistant: 0 };
    current.total += 1;
    current[message.role] += 1;
    counts.set(character, current);
  }
  assert.deepEqual([...counts.values()], [{ total: 445, user: 223, assistant: 222 }]);
  assert.equal(new Set(plan.storyMessages.map((message) => message.sessionId)).size, 1);
  assert.equal(plan.storySessions[0].characterId, plan.characters.find((character) => character.sourceMigrationId === [...counts.keys()][0]).value.id);
  assert.equal(plan.storySessions[0].lastMessageId, plan.storyMessages.at(-1).id);
  assert.equal(plan.storySessions[0].updatedAt, plan.storyMessages.at(-1).createdAt);
  assert.equal(plan.storySessions[0].lastMessagePreview, plan.storyMessages.at(-1).rawContent.slice(0, 120));

  const chatBySession = new Map();
  for (const message of plan.messages) {
    const list = chatBySession.get(message.sessionId) ?? [];
    list.push(message);
    chatBySession.set(message.sessionId, list);
  }
  for (const session of plan.sessions) {
    const list = chatBySession.get(session.id) ?? [];
    assert.equal(session.lastMessageId, list.at(-1)?.id);
    assert.equal(session.updatedAt, list.at(-1)?.createdAt ?? session.updatedAt);
    assert.equal(session.lastMessageId && storySourceIds.has(session.lastMessageId), false);
  }

  console.log("Offline Sully RP Story routing RED tests passed");
} finally {
  await runtime.cleanup();
}
