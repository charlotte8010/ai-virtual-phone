import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileMigrationModules } from "./migration-ts-loader.mjs";

const runtime = await compileMigrationModules();

try {
  const { readFloatMigrationPackage } = runtime.requireModule("format/read-package.js");
  const { writeFloatMigrationPackage } = runtime.requireModule("format/package-writer.js");
  const { dryRunFloatMigrationPackage, applyFloatMigrationPackage, rollbackFloatMigrationRun } = runtime.requireModule("native/importer.js");

  const fingerprint = `sha256:${"1".repeat(64)}`;
  const source = (store, originalId) => ({ platform: "sully", backupFormat: "sully_v3", backupFormatVersion: 3, backupFingerprint: fingerprint, store, originalId });
  const characters = Array.from({ length: 4 }, (_, index) => ({
    migrationId: `mig_characters_${index}`,
    kind: "character",
    displayName: index === 0 ? "Synthetic Sully" : `Synthetic Character ${index}`,
    persona: `fixture persona ${index}`,
    source: source("characters", `char-${index}`),
  }));
  const character = characters[0];
  const conversations = characters.map((entry, index) => ({
    migrationId: `mig_conversations_${index}`,
    characterRef: entry.migrationId,
    source: source("messages", `char-${index}`),
  }));
  const conversation = conversations[0];
  const messages = Array.from({ length: 5153 }, (_, index) => {
    const offline = index < 445;
    const chatIndex = index - 445;
    const messageCharacter = offline ? character : characters[chatIndex % characters.length];
    const messageConversation = offline ? conversation : conversations[chatIndex % conversations.length];
    return {
      migrationId: `mig_messages_${index}`,
      sourceOriginalId: String(index),
      characterRef: messageCharacter.migrationId,
      conversationRef: messageConversation.migrationId,
      role: offline ? (index % 2 === 0 ? "user" : "assistant") : (index % 3 === 0 ? "user" : "assistant"),
      content: `${offline ? "offline" : "chat"} fixture message ${index}`,
      createdAt: new Date(Date.parse("2026-08-01T00:00:00.000Z") + index * 1000).toISOString(),
      source: source("messages", String(index)),
      sourceMetadata: { source: offline ? "date" : "online" },
    };
  });
  const stories = Array.from({ length: 193 }, (_, index) => ({
    migrationId: `mig_vr_archive_${index}`,
    kind: "vr_novel",
    title: `Archived VR record ${index}`,
    content: `archive ${index}`,
    source: source("vrNovels", String(index)),
  }));
  const assets = Array.from({ length: 79 }, (_, index) => ({
    assetId: `asset-${index}`,
    packagePath: `assets/files/asset-${index}.bin`,
    mediaType: "application/octet-stream",
    byteLength: 3,
    source: source("assets", `asset-${index}`),
  }));
  const diaries = [{
    migrationId: "mig_diary_0", date: "2026-08-01", userContent: { text: "user page" },
    characterContent: { text: "character page" }, createdAt: "2026-08-01T00:00:00.000Z",
    source: source("diaries", "diary-0"), metadata: { charId: "char-0" },
  }];
  const worlds = [{
    migrationId: "mig_world_0", title: "Synthetic world", content: "world content",
    source: source("worlds", "world-0"), metadata: { memberIds: characters.map((_, index) => `char-${index}`) },
  }];
  const worldbooks = Array.from({ length: 14 }, (_, index) => ({
    migrationId: `mig_worldbook_${index}`, title: `WorldBook ${index}`, content: `worldbook ${index}`,
    keys: [`key-${index}`], source: source("worldbooks", `worldbook-${index}`), settings: {},
  }));
  const schedules = Array.from({ length: 11 }, (_, index) => ({
    migrationId: `mig_schedule_${index}`, characterRef: character.migrationId,
    date: `2026-08-${String(3 + (index % 3) * 7).padStart(2, "0")}`,
    content: { slots: [{ startTime: "09:00", activity: `schedule ${index}` }] },
    source: source("dailySchedules", `schedule-${index}`), metadata: { generatedAt: "2026-09-01T00:00:00.000Z" },
  }));
  const memories = [
    ...Array.from({ length: 250 }, (_, index) => ({
      migrationId: `mig_memory_active_${index}`, characterRef: characters[index % characters.length].migrationId,
      content: `active memory ${index}`, createdAt: "2026-08-01T00:00:00.000Z", source: source("memoryNodes", `active-${index}`),
    })),
    ...Array.from({ length: 147 }, (_, index) => ({
      migrationId: `mig_memory_archived_${index}`, characterRef: characters[index % characters.length].migrationId,
      content: `archived memory ${index}`, archived: true, room: index < 5 ? "windowsill" : "study",
      createdAt: "2026-08-01T00:00:00.000Z", source: source("memoryNodes", `archived-${index}`),
    })),
  ];
  const futureIntents = [
    ...Array.from({ length: 4 }, (_, index) => ({
      migrationId: `mig_intent_active_${index}`, characterRef: characters[index % characters.length].migrationId,
      content: `active intent ${index}`, timePrecision: "vague", sourceMemoryRef: `mig_memory_active_${index}`,
      source: source("memoryNodes", `active-${index}`),
    })),
    ...Array.from({ length: 5 }, (_, index) => ({
      migrationId: `mig_intent_archived_${index}`, characterRef: characters[index % characters.length].migrationId,
      content: `archived intent ${index}`, timePrecision: "vague", sourceMemoryRef: `mig_memory_archived_${index}`,
      source: source("memoryNodes", `archived-${index}`),
    })),
  ];
  const legacyCharacterMemories = Array.from({ length: 11 }, (_, index) => ({
    characterSourceId: `char-${index % characters.length}`,
    memory: { id: `legacy-${index}`, date: "2026-08-01", summary: `legacy summary ${index}` },
  }));
  const fixturePayload = {
    identities: [{ migrationId: "mig_identity_user", kind: "user", displayName: "Fixture User", source: source("metadata.userProfile", "user") }],
    characters, relationships: [], conversations, messages,
    moments: [], diaries, worlds, worldbooks, stories, games: [{ migrationId: "mig_game_0", title: "game", source: source("games", "game-0") }],
    schedules, eventBoxes: Array.from({ length: 56 }, (_, index) => ({ migrationId: `mig_event_box_${index}`, source: source("eventBoxes", String(index)) })),
    memories, futureIntents, memoryLinks: Array.from({ length: 32667 }, (_, index) => ({
      migrationId: `mig_memory_link_${index}`, fromMemoryRef: memories[index % memories.length].migrationId,
      toMemoryRef: memories[(index + 1) % memories.length].migrationId, type: "temporal",
      weight: 1,
      source: source("memoryLinks", String(index)),
    })),
    extended: { legacyCharacterMemories },
    compat: Array.from({ length: 7 }, (_, index) => ({ store: `compat-${index}`, records: [] })),
    provenance: {
      idMap: {
        characters: Object.fromEntries(characters.map((entry, index) => [`char-${index}`, entry.migrationId])),
        conversations: Object.fromEntries(conversations.map((entry, index) => [`char-${index}`, entry.migrationId])),
      },
      normalizationReport: { redactions: { count: 0, paths: [] }, stores: {} },
      sourceManifest: {}, metadataRedactions: [], excludedSensitiveStores: {}, excludedRuntimeStores: {},
    },
  };
  const manifest = {
    format: "float_migration", formatVersion: 1, packageId: "pkg-offline-story-fixture",
    source: { platform: "sully", format: "sully_v3", formatVersion: 3, backupFingerprint: fingerprint },
    createdAt: "2026-09-01T00:00:00.000Z",
    counts: {
      identities: 1, characters: 4, relationships: 0, conversations: 4, messages: 5153, moments: 0, diaries: 1,
      worlds: 1, worldbooks: 14, stories: 193, games: 1, schedules: 11, eventBoxes: 56, memories: 397,
      futureIntents: 9, memoryLinks: 32667, compatStores: 7,
    },
    assets: { count: 79, totalBytes: 237 }, skippedByPolicy: {}, warnings: [],
  };
  const fixtureBytes = await writeFloatMigrationPackage({
    manifest,
    payload: fixturePayload,
    binaryAssets: assets.map((ref) => ({ ref, bytes: new Uint8Array([1, 2, 3]) })),
  });
  const realMode = process.argv[2] === "--real";
  const requestedPackagePath = process.env.SULLY_FINAL_PACKAGE_PATH ?? (realMode ? process.argv[3] : undefined);
  if (realMode && !requestedPackagePath) {
    throw new Error("--real requires a package path argument or SULLY_FINAL_PACKAGE_PATH");
  }
  const inputBytes = requestedPackagePath ? await readFile(requestedPackagePath) : fixtureBytes;

  const read = await readFloatMigrationPackage(inputBytes);
  assert.equal(read.ok, true, read.ok ? "" : read.errors.join("\n"));
  const payload = read.payload;
  const emptySnapshot = {
    identities: [], characters: [], contacts: [], sessions: [], messages: [], mediaIds: [],
    moments: [], momentComments: [], diaries: [], worlds: [], worldbooks: [], calendar: [],
    memories: [], memoryLinks: [], storySessions: [], storyMessages: [],
  };
  const storage = {
    kind: "isolated-browser",
    async readSnapshot() { return emptySnapshot; },
  };

  const prepared = await dryRunFloatMigrationPackage(inputBytes, { storage });
  assert.equal(prepared.ok, true, prepared.ok ? "" : prepared.errors.join("\n"));
  const { plan, summary } = prepared.dryRun;
  const offline = payload.messages.filter((message) => message.sourceMetadata?.source === "date");
  const offlineIds = new Set(offline.map((message) => message.migrationId));

  assert.equal(summary.sourceMessages, 5153);
  assert.equal(summary.chatMessages, 4708);
  assert.equal(summary.storyMessages, 445);
  assert.equal(summary.storySessions, 1);
  assert.equal(summary.assets, 79);
  assert.equal(summary.diary, 1);
  assert.equal(summary.worldbooks, 14);
  assert.equal(summary.activeMemories, 250);
  assert.equal(summary.archivedMemories, 147);
  assert.equal(summary.activeFutureIntents, 4);
  assert.equal(summary.archivedWindowsill, 5);
  assert.equal(summary.memoryLinks, 32667);
  assert.equal(summary.activeMemoryLinks, plan.memoryLinks.length);
  assert.equal(summary.archiveOnlyMemoryLinks, summary.memoryLinks - summary.activeMemoryLinks);
  if (realMode) {
    assert.equal(summary.memoryLinks, 32667);
    assert.equal(summary.activeMemoryLinks, 13604);
    assert.equal(summary.archiveOnlyMemoryLinks, 19063);
  }
  assert.equal(plan.memoryLinkAudit.brokenRef, 0);
  assert.equal(plan.memoryLinkAudit.crossCharacter, realMode ? 0 : 32667);
  assert.equal(plan.memoryLinkAudit.invalidStrength, 0);
  assert.equal(summary.legacyCoreSummaries, 11);
  assert.equal(summary.timelineRecords, 0);
  assert.equal(plan.messages.length, 4708);
  assert.equal(plan.storyMessages.length, 445);
  assert.equal(plan.storySessions.length, 1);
  assert.equal(plan.archive.stories.length, 193);
  assert.equal(plan.archive.memoryLinks.length, 32667);

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
      add("memoryLinks", reconciliation.memoryLinks.create);
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
        this.snapshot.idMap = structuredClone(reconciliation.resolvedIdMap);
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
      remove("memoryLinks", journal.created.memoryLinks);
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
  const first = await dryRunFloatMigrationPackage(inputBytes, { storage: storageAfterApply });
  assert.equal(first.ok, true, first.ok ? "" : first.errors.join("\n"));
  assert.equal(first.dryRun.reconciliation.messages.create.length, 4708);
  assert.equal(first.dryRun.reconciliation.storySessions.create.length, 1);
  assert.equal(first.dryRun.reconciliation.storyMessages.create.length, 445);
  assert.equal(first.dryRun.reconciliation.storySessions.reuse.length, 0);
  assert.equal(first.dryRun.reconciliation.storyMessages.conflicts.length, 0);
  const expectedCreates = first.dryRun.reconciliation.totals.create;
  assert.equal(expectedCreates - first.dryRun.reconciliation.memoryLinks.create.length, 5528);
  assert.equal(first.dryRun.reconciliation.totals.conflicts, 0);

  const applied = await applyFloatMigrationPackage(inputBytes, { storage: storageAfterApply });
  assert.equal(applied.ok, true, JSON.stringify(applied.expectedVsActual));
  assert.equal(applied.expectedVsActual.remainingCreatesAfterApply, 0);
  assert.equal(applied.expectedVsActual.plannedCreates, expectedCreates);
  assert.equal(applied.expectedVsActual.actualCreates, expectedCreates);
  assert.equal(applied.expectedVsActual.failed, 0);
  assert.equal(applied.expectedVsActual.warnings, 0);
  assert.equal(storageAfterApply.snapshot.messages.length, 4708);
  assert.equal(storageAfterApply.snapshot.memoryLinks.length, plan.memoryLinks.length);
  assert.equal((applied.journal.created.memoryLinks ?? []).length, plan.memoryLinks.length);
  assert.equal(storageAfterApply.snapshot.storySessions.length, 1);
  assert.equal(storageAfterApply.snapshot.storyMessages.length, 445);
  assert.equal(applied.journal.created.storySessions.length, 1);
  assert.equal(applied.journal.created.storyMessages.length, 445);

  const second = await applyFloatMigrationPackage(inputBytes, { storage: storageAfterApply });
  assert.equal(second.ok, true, JSON.stringify(second.expectedVsActual));
  assert.equal(second.expectedVsActual.actualCreates, 0);
  assert.equal(second.dryRun.reconciliation.totals.create, 0);
  assert.equal(second.expectedVsActual.remainingCreatesAfterApply, 0);
  assert.equal(storageAfterApply.snapshot.storySessions.length, 1);
  assert.equal(storageAfterApply.snapshot.storyMessages.length, 445);

  const rollback = await rollbackFloatMigrationRun(applied.journal.runId, storageAfterApply);
  assert.equal(rollback.ok, true);
  assert.equal(storageAfterApply.snapshot.storySessions.length, 0);
  assert.equal(storageAfterApply.snapshot.storyMessages.length, 0);
  assert.equal(storageAfterApply.snapshot.messages.length, 0);
  assert.equal(storageAfterApply.snapshot.identities.length, 0);
  assert.equal(storageAfterApply.snapshot.characters.length, 0);
  assert.equal(storageAfterApply.snapshot.contacts.length, 0);
  assert.equal(storageAfterApply.snapshot.sessions.length, 0);
  assert.equal(storageAfterApply.snapshot.mediaIds.length, 0);
  assert.equal(storageAfterApply.snapshot.diaries.length, 0);
  assert.equal(storageAfterApply.snapshot.worlds.length, 0);
  assert.equal(storageAfterApply.snapshot.worldbooks.length, 0);
  assert.equal(storageAfterApply.snapshot.calendar.length, 0);
  assert.equal(storageAfterApply.snapshot.memories.length, 0);
  assert.equal(storageAfterApply.snapshot.memoryLinks.length, 0);
  assert.equal(storageAfterApply.snapshot.archive, undefined);
  assert.equal(storageAfterApply.snapshot.idMap, undefined);

  const existingStorage = new MemoryStorage();
  const existingPlan = plan;
  const existingSession = { ...existingPlan.storySessions[0], id: "preexisting-story-session", title: "Keep this title", customCSS: "keep-this-css", uiPrefs: { theme: "keep-this-theme" } };
  const existingMessage = { ...existingPlan.storyMessages[0], sessionId: existingSession.id, rawContent: "Keep this existing StoryMessage" };
  existingStorage.snapshot.storySessions = [existingSession];
  existingStorage.snapshot.storyMessages = [existingMessage];
  const existingDryRun = await dryRunFloatMigrationPackage(inputBytes, { storage: existingStorage });
  assert.equal(existingDryRun.ok, true, existingDryRun.ok ? "" : existingDryRun.errors.join("\n"));
  assert.equal(existingDryRun.dryRun.reconciliation.storySessions.create.length, 0);
  assert.equal(existingDryRun.dryRun.reconciliation.storySessions.reuse.length, 1);
  assert.equal(existingDryRun.dryRun.reconciliation.storyMessages.conflicts.length, 1);
  assert.equal(existingDryRun.dryRun.reconciliation.storyMessages.create.length, 444);
  const existingApplied = await applyFloatMigrationPackage(inputBytes, { storage: existingStorage });
  assert.equal(existingApplied.ok, true, JSON.stringify(existingApplied.expectedVsActual));
  assert.deepEqual(existingStorage.snapshot.storySessions[0], existingSession);
  assert.equal(existingStorage.snapshot.storyMessages.find((message) => message.id === existingMessage.id).rawContent, existingMessage.rawContent);
  assert.equal(existingStorage.snapshot.storyMessages.length, 445);
  const existingSecond = await applyFloatMigrationPackage(inputBytes, { storage: existingStorage });
  assert.equal(existingSecond.expectedVsActual.actualCreates, 0);
  assert.equal(existingSecond.dryRun.reconciliation.totals.create, 0);
  assert.equal(existingStorage.snapshot.storyMessages.every((message) => message.sessionId === existingSession.id), true);
  assert.equal(existingStorage.snapshot.idMap.storySessions[[...counts.keys()][0]], existingSession.id);
  const existingRollback = await rollbackFloatMigrationRun(existingApplied.journal.runId, existingStorage);
  assert.equal(existingRollback.ok, true);
  assert.deepEqual(existingStorage.snapshot.storySessions, [existingSession]);
  assert.deepEqual(existingStorage.snapshot.storyMessages, [existingMessage]);

  const conflictStorage = new MemoryStorage();
  const conflictingLatest = {
    ...plan.storyMessages.at(-1),
    sessionId: "unrelated-existing-session",
    rawContent: "Existing conflicting latest StoryMessage",
  };
  conflictStorage.snapshot.storyMessages = [conflictingLatest];
  const conflictDryRun = await dryRunFloatMigrationPackage(inputBytes, { storage: conflictStorage });
  assert.equal(conflictDryRun.ok, true, conflictDryRun.ok ? "" : conflictDryRun.errors.join("\n"));
  assert.equal(conflictDryRun.dryRun.reconciliation.storySessions.create.length, 1);
  assert.equal(conflictDryRun.dryRun.reconciliation.storyMessages.conflicts.length, 1);
  const safeSession = conflictDryRun.dryRun.reconciliation.storySessions.create[0];
  assert.notEqual(safeSession.lastMessageId, conflictingLatest.id);
  if (safeSession.lastMessageId) {
    const safeMessage = conflictDryRun.dryRun.reconciliation.storyMessages.create.find((message) => message.id === safeSession.lastMessageId);
    assert.ok(safeMessage);
    assert.equal(safeMessage.sessionId, safeSession.id);
    assert.equal(safeSession.lastMessagePreview, safeMessage.rawContent.slice(0, 120));
  }
  const conflictApplied = await applyFloatMigrationPackage(inputBytes, { storage: conflictStorage });
  assert.equal(conflictApplied.ok, true, JSON.stringify(conflictApplied.expectedVsActual));
  const persistedSafeSession = conflictStorage.snapshot.storySessions[0];
  assert.notEqual(persistedSafeSession.lastMessageId, conflictingLatest.id);
  if (persistedSafeSession.lastMessageId) {
    const persistedSafeMessage = conflictStorage.snapshot.storyMessages.find((message) => message.id === persistedSafeSession.lastMessageId);
    assert.ok(persistedSafeMessage);
    assert.equal(persistedSafeMessage.sessionId, persistedSafeSession.id);
    assert.equal(persistedSafeSession.lastMessagePreview, persistedSafeMessage.rawContent.slice(0, 120));
  }
  assert.equal(conflictStorage.snapshot.storyMessages.find((message) => message.id === conflictingLatest.id).rawContent, conflictingLatest.rawContent);
  const conflictRollback = await rollbackFloatMigrationRun(conflictApplied.journal.runId, conflictStorage);
  assert.equal(conflictRollback.ok, true);
  assert.deepEqual(conflictStorage.snapshot.storySessions, []);
  assert.deepEqual(conflictStorage.snapshot.storyMessages, [conflictingLatest]);

  console.log("Offline Sully RP Story routing GREEN tests passed");
} finally {
  await runtime.cleanup();
}
