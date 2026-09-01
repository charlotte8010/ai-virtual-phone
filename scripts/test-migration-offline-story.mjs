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

  class MemoryStorage {
    kind = "isolated-browser";
    snapshot = structuredClone(emptySnapshot);
    journals = new Map();

    async readSnapshot() { return structuredClone(this.snapshot); }
    async saveJournal(journal) { this.journals.set(journal.runId, structuredClone(journal)); }
    async readJournal(runId) { return structuredClone(this.journals.get(runId) ?? null); }
    async applyCreates(nativePlan, reconciliation, pkg) {
      const created = {};
      const add = (key, values, idField = "id") => {
        if (!values.length) return;
        this.snapshot[key].push(...structuredClone(values));
        created[key] = values.map((value) => value[idField]);
      };
      add("identities", reconciliation.identities.create);
      add("characters", reconciliation.characters.create);
      add("contacts", reconciliation.contacts.create);
      add("sessions", reconciliation.sessions.create);
      add("messages", reconciliation.messages.create);
      add("storySessions", reconciliation.storySessions.create);
      add("storyMessages", reconciliation.storyMessages.create);
      add("moments", reconciliation.moments.create);
      add("momentComments", reconciliation.momentComments.create);
      add("diaries", reconciliation.diaries.create);
      add("worlds", reconciliation.worlds.create);
      add("worldbooks", reconciliation.worldbooks.create);
      add("calendar", reconciliation.calendar.create);
      add("memories", reconciliation.memories.create);
      if (reconciliation.media.create.length) {
        for (const media of reconciliation.media.create) assert.ok(await pkg.getAssetBytes(media.sourceAssetId));
        this.snapshot.mediaIds.push(...reconciliation.media.create.map((media) => media.targetId));
        created.media = reconciliation.media.create.map((media) => media.targetId);
      }
      if (reconciliation.archive === "create") {
        this.snapshot.archive = structuredClone(nativePlan.archive);
        created.archive = ["archive"];
      }
      if (reconciliation.idMap === "create") {
        this.snapshot.idMap = structuredClone(nativePlan.idMap);
        created.idMap = ["idmap"];
      }
      return { created, warnings: [], failures: [] };
    }
    async rollbackCreated(journal) {
      const remove = (key, ids, idField = "id") => {
        if (!ids?.length) return;
        const removeIds = new Set(ids);
        this.snapshot[key] = this.snapshot[key].filter((value) => !removeIds.has(value[idField]));
      };
      remove("identities", journal.created.identities);
      remove("characters", journal.created.characters);
      remove("contacts", journal.created.contacts);
      remove("sessions", journal.created.sessions);
      remove("messages", journal.created.messages);
      remove("storySessions", journal.created.storySessions);
      remove("storyMessages", journal.created.storyMessages);
      remove("moments", journal.created.moments);
      remove("momentComments", journal.created.momentComments);
      remove("diaries", journal.created.diaries);
      remove("worlds", journal.created.worlds);
      remove("worldbooks", journal.created.worldbooks);
      remove("calendar", journal.created.calendar);
      remove("memories", journal.created.memories);
      if (journal.created.media?.length) {
        const removeIds = new Set(journal.created.media);
        this.snapshot.mediaIds = this.snapshot.mediaIds.filter((id) => !removeIds.has(id));
      }
      if (journal.created.archive?.length) delete this.snapshot.archive;
      if (journal.created.idMap?.length) delete this.snapshot.idMap;
      return { warnings: [], failures: [] };
    }
  }

  const storageAfterApply = new MemoryStorage();
  const first = await dryRunFloatMigrationPackage(await readFile(packagePath), { storage: storageAfterApply });
  assert.equal(first.ok, true, first.ok ? "" : first.errors.join("\n"));
  assert.equal(first.dryRun.reconciliation.messages.create.length, 4708);
  assert.equal(first.dryRun.reconciliation.storySessions.create.length, 1);
  assert.equal(first.dryRun.reconciliation.storyMessages.create.length, 445);
  assert.equal(first.dryRun.reconciliation.storySessions.reuse.length, 0);
  assert.equal(first.dryRun.reconciliation.storyMessages.conflicts.length, 0);

  const applied = await (await import("node:fs/promises")).readFile(packagePath).then((bytes) =>
    runtime.requireModule("native/importer.js").applyFloatMigrationPackage(bytes, { storage: storageAfterApply }));
  assert.equal(applied.ok, true, JSON.stringify(applied.expectedVsActual));
  assert.equal(applied.expectedVsActual.remainingCreatesAfterApply, 0);
  assert.equal(storageAfterApply.snapshot.messages.length, 4708);
  assert.equal(storageAfterApply.snapshot.storySessions.length, 1);
  assert.equal(storageAfterApply.snapshot.storyMessages.length, 445);
  assert.equal(applied.journal.created.storySessions.length, 1);
  assert.equal(applied.journal.created.storyMessages.length, 445);

  const second = await runtime.requireModule("native/importer.js").applyFloatMigrationPackage(await readFile(packagePath), { storage: storageAfterApply });
  assert.equal(second.ok, true, JSON.stringify(second.expectedVsActual));
  assert.equal(second.expectedVsActual.actualCreates, 0);
  assert.equal(second.dryRun.reconciliation.totals.create, 0);
  assert.equal(storageAfterApply.snapshot.storySessions.length, 1);
  assert.equal(storageAfterApply.snapshot.storyMessages.length, 445);

  const rollback = await runtime.requireModule("native/importer.js").rollbackFloatMigrationRun(applied.journal.runId, storageAfterApply);
  assert.equal(rollback.ok, true);
  assert.equal(storageAfterApply.snapshot.storySessions.length, 0);
  assert.equal(storageAfterApply.snapshot.storyMessages.length, 0);
  assert.equal(storageAfterApply.snapshot.messages.length, 0);

  const existingStorage = new MemoryStorage();
  const existingPlan = plan;
  const existingSession = { ...existingPlan.storySessions[0], id: "preexisting-story-session", title: "Keep this title", customCSS: "keep-this-css", uiPrefs: { theme: "keep-this-theme" } };
  const existingMessage = { ...existingPlan.storyMessages[0], sessionId: existingSession.id, rawContent: "Keep this existing StoryMessage" };
  existingStorage.snapshot.storySessions = [existingSession];
  existingStorage.snapshot.storyMessages = [existingMessage];
  const existingDryRun = await dryRunFloatMigrationPackage(await readFile(packagePath), { storage: existingStorage });
  assert.equal(existingDryRun.ok, true, existingDryRun.ok ? "" : existingDryRun.errors.join("\n"));
  assert.equal(existingDryRun.dryRun.reconciliation.storySessions.create.length, 0);
  assert.equal(existingDryRun.dryRun.reconciliation.storySessions.reuse.length, 1);
  assert.equal(existingDryRun.dryRun.reconciliation.storyMessages.conflicts.length, 1);
  assert.equal(existingDryRun.dryRun.reconciliation.storyMessages.create.length, 444);
  const existingApplied = await runtime.requireModule("native/importer.js").applyFloatMigrationPackage(await readFile(packagePath), { storage: existingStorage });
  assert.equal(existingApplied.ok, true, JSON.stringify(existingApplied.expectedVsActual));
  assert.deepEqual(existingStorage.snapshot.storySessions[0], existingSession);
  assert.equal(existingStorage.snapshot.storyMessages.find((message) => message.id === existingMessage.id).rawContent, existingMessage.rawContent);
  assert.equal(existingStorage.snapshot.storyMessages.length, 445);
  const existingRollback = await runtime.requireModule("native/importer.js").rollbackFloatMigrationRun(existingApplied.journal.runId, existingStorage);
  assert.equal(existingRollback.ok, true);
  assert.deepEqual(existingStorage.snapshot.storySessions, [existingSession]);
  assert.deepEqual(existingStorage.snapshot.storyMessages, [existingMessage]);

  console.log("Offline Sully RP Story routing GREEN tests passed");
} finally {
  await runtime.cleanup();
}
