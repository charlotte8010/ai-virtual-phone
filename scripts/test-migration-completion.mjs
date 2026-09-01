import assert from "node:assert/strict";
import { compileMigrationModules } from "./migration-ts-loader.mjs";

const runtime = await compileMigrationModules();
try {
  const { writeFloatMigrationPackage } = runtime.requireModule("format/package-writer.js");
  const { dryRunFloatMigrationPackage, applyFloatMigrationPackage, rollbackFloatMigrationRun } = runtime.requireModule("native/importer.js");
  const { deterministicNativeId } = runtime.requireModule("native/id.js");

  const fingerprint = "sha256:0bae3c5f57ba5cb0246c58e735674670ee39b5e3fe7aa17805fd51695a29fcba";
  const createdAt = "2026-09-01T00:00:00.000Z";
  const source = (store, originalId) => ({ platform: "sully", backupFormat: "sully_v3", backupFormatVersion: 3, backupFingerprint: fingerprint, store, originalId });
  const chars = Array.from({ length: 4 }, (_, i) => ({
    migrationId: `mig_characters_c${i}`, kind: "character", displayName: `C${i}`, persona: `P${i}`,
    source: source("characters", `c${i}`), metadata: {},
  }));
  const conversations = chars.map((char, i) => ({ migrationId: `mig_conversations_c${i}`, characterRef: char.migrationId, source: source("messages", `c${i}`) }));
  const messages = Array.from({ length: 5153 }, (_, i) => ({
    migrationId: `mig_messages_m${i}`,
    sourceOriginalId: `m${i}`,
    characterRef: chars[i % 4].migrationId,
    conversationRef: conversations[i % 4].migrationId,
    role: i % 3 === 0 ? "user" : "assistant",
    content: `message ${i}`,
    messageType: i === 0 ? "image" : i === 1 ? "vr_card" : "text",
    ...(i === 0 ? { media: [{ assetId: "asset-0", packagePath: "assets/files/asset-0.bin", mediaType: "image/png", byteLength: 3, source: source("assets", "asset-0") }] } : {}),
    createdAt: new Date(Date.parse("2026-08-20T00:00:00.000Z") + i * 1000).toISOString(),
    source: source("messages", `m${i}`),
    sourceMetadata: i === 1 ? { card: { kind: "vr" } } : {},
  }));

  const moments = Array.from({ length: 9 }, (_, i) => {
    const comments = i === 0 ? Array.from({ length: 14 }, (_, j) => ({ id: `comment-${j}`, authorName: `npc-${j}`, authorType: "stranger", content: `comment ${j}`, likes: j })) : [];
    const count = i < 8 ? 3000 : 5906;
    return {
      migrationId: `mig_moments_p${i}`,
      authorRef: chars[i % 4].migrationId,
      content: `post ${i}`,
      likes: [{ count }],
      comments,
      createdAt: new Date(Date.parse("2026-08-25T00:00:00.000Z") + i * 1000).toISOString(),
      source: source("socialPosts", `p${i}`),
      metadata: { likes: count, isLiked: i < 3 },
    };
  });

  const memories = [];
  for (let i = 0; i < 250; i++) {
    memories.push({
      migrationId: `mig_memories_active-${i}`, sourceOriginalId: `active-${i}`,
      characterRef: chars[i % 4].migrationId, content: `active memory ${i}`,
      room: i < 4 ? "windowsill" : "bedroom", archived: false, importance: 7,
      createdAt: "2026-08-20T12:00:00.000Z", source: source("memoryNodes", `active-${i}`), metadata: {},
    });
  }
  for (let i = 0; i < 147; i++) {
    memories.push({
      migrationId: `mig_memories_archived-${i}`, sourceOriginalId: `archived-${i}`,
      characterRef: chars[i % 4].migrationId, content: `archived memory ${i}`,
      room: i < 5 ? "windowsill" : "study", archived: true, importance: 5,
      createdAt: "2026-08-19T12:00:00.000Z", source: source("memoryNodes", `archived-${i}`), metadata: {},
    });
  }
  const futureIntents = [
    ...Array.from({ length: 4 }, (_, i) => ({ migrationId: `mig_future_active-${i}`, characterRef: chars[i % 4].migrationId, content: `plan active ${i}`, timeExpression: "以后", timePrecision: "vague", status: "unknown", sourceMemoryRef: `mig_memories_active-${i}`, source: source("memoryNodes", `active-${i}`), metadata: { sourceRoom: "windowsill" } })),
    ...Array.from({ length: 5 }, (_, i) => ({ migrationId: `mig_future_archived-${i}`, characterRef: chars[i % 4].migrationId, content: `plan archived ${i}`, timeExpression: "以后", timePrecision: "vague", status: "unknown", sourceMemoryRef: `mig_memories_archived-${i}`, source: source("memoryNodes", `archived-${i}`), metadata: { sourceRoom: "windowsill" } })),
  ];
  const memoryLinks = Array.from({ length: 32667 }, (_, i) => ({
    migrationId: `mig_link_${i}`,
    fromMemoryRef: memories[i % memories.length].migrationId,
    toMemoryRef: memories[(i + 1) % memories.length].migrationId,
    type: i % 2 ? "temporal" : "emotional",
    weight: 1,
    source: source("memoryLinks", `link-${i}`),
  }));

  const assets = Array.from({ length: 79 }, (_, i) => ({
    assetId: `asset-${i}`, packagePath: `assets/files/asset-${i}.bin`, mediaType: i < 5 ? "image/png" : "application/octet-stream", byteLength: 3,
    source: source("assets", `asset-${i}`),
  }));
  chars[0].avatar = assets[1];
  const identities = [{ migrationId: "mig_identities_me", kind: "user", displayName: "Tester", avatar: assets[2], source: source("metadata.userProfile", "me"), metadata: { bio: "bio" } }];
  const relationships = Array.from({ length: 4 }, (_, i) => ({
    migrationId: `mig_relationships_${i}`, characterRef: chars[i % 4].migrationId,
    state: { fromRef: chars[i % 4].migrationId, toRef: chars[(i + 1) % 4].migrationId, value: -2 },
    source: source("worlds.relationships", `world-0:${i}`),
  }));
  const worlds = [{ migrationId: "mig_worlds_world-0", title: "现实", content: "北京", source: source("worlds", "world-0"), metadata: { memberIds: ["c0", "c1", "c2", "c3"] } }];
  const worldbooks = Array.from({ length: 14 }, (_, i) => ({ migrationId: `mig_worldbooks_wb${i}`, title: `WB${i}`, content: `content ${i}`, keys: [`k${i}`], source: source("worldbooks", `wb${i}`), settings: { constant: true, position: 0, order: 100, createdAt: 1787246160586, updatedAt: 1787246160586 } }));
  const diaries = [{ migrationId: "mig_diaries_d0", date: "2026-08-25", userContent: { text: "user page" }, characterContent: { text: "character page" }, createdAt: "2026-08-24T17:51:03.684Z", source: source("diaries", "d0"), metadata: { charId: "c0" } }];
  const schedules = Array.from({ length: 11 }, (_, i) => ({ migrationId: `mig_schedules_s${i}`, characterRef: chars[i % 4].migrationId, date: `2026-08-${String(21 + (i % 7)).padStart(2, "0")}`, content: { slots: [{ startTime: "09:00", activity: `slot ${i}`, description: "desc" }] }, source: source("dailySchedules", `s${i}`), metadata: { generatedAt: "2026-08-21T04:45:11.134Z" } }));
  const legacyCharacterMemories = Array.from({ length: 11 }, (_, i) => ({ characterSourceId: `c${i % 4}`, memory: { id: `legacy-${i}`, date: "2026-08-20", summary: `legacy summary ${i}`, mood: "palace" } }));

  const payload = {
    identities, characters: chars, relationships, conversations, messages, moments, diaries, worlds, worldbooks,
    stories: [], games: [], schedules, eventBoxes: [], memories, futureIntents, memoryLinks,
    extended: { legacyCharacterMemories }, compat: [],
    provenance: {
      idMap: { characters: Object.fromEntries(chars.map((_, i) => [`c${i}`, `mig_characters_c${i}`])) },
      normalizationReport: { redactions: { count: 0, paths: [] }, stores: {} }, sourceManifest: {}, metadataRedactions: [], excludedSensitiveStores: {}, excludedRuntimeStores: {},
    },
  };
  const manifest = {
    format: "float_migration", formatVersion: 1, packageId: "pkg-migration-completion-test",
    source: { platform: "sully", format: "sully_v3", formatVersion: 3, backupFingerprint: fingerprint }, createdAt,
    counts: {
      identities: 1, characters: 4, relationships: 4, conversations: 4, messages: 5153, moments: 9, diaries: 1, worlds: 1,
      worldbooks: 14, stories: 0, games: 0, schedules: 11, eventBoxes: 0, memories: 397, futureIntents: 9, memoryLinks: 32667, compatStores: 0,
    }, assets: { count: 79, totalBytes: 237 }, skippedByPolicy: {}, warnings: [],
  };
  const bytes = await writeFloatMigrationPackage({
    manifest, payload,
    binaryAssets: assets.map((ref) => ({ ref, bytes: new Uint8Array([1, 2, 3]) })),
  });

  class FakeStorage {
    kind = "isolated-browser";
    journals = new Map();
    snapshot = { identities: [], characters: [{ id: "preexisting-char", name: "Preexisting", avatar: null, persona: "keep", wechatID: "19900000000", tags: [], createdAt, updatedAt: createdAt }], contacts: [], sessions: [], messages: [], storySessions: [], storyMessages: [], mediaIds: [], moments: [], momentComments: [], diaries: [], worlds: [], worldbooks: [], calendar: [], memories: [] };
    async saveJournal(journal) { this.journals.set(journal.runId, structuredClone(journal)); }
    async readJournal(runId) { const v = this.journals.get(runId); return v ? structuredClone(v) : null; }
    async readSnapshot() { return structuredClone(this.snapshot); }
    async applyCreates(plan, r, pkg) {
      const created = {};
      const add = (key, values, idField = "id") => { if (!values.length) return; this.snapshot[key].push(...structuredClone(values)); created[key] = values.map(v => v[idField]); };
      add("identities", r.identities.create); add("characters", r.characters.create); add("contacts", r.contacts.create); add("sessions", r.sessions.create); add("messages", r.messages.create); add("storySessions", r.storySessions.create); add("storyMessages", r.storyMessages.create);
      if (r.media.create.length) { for (const media of r.media.create) assert.ok(await pkg.getAssetBytes(media.sourceAssetId)); this.snapshot.mediaIds.push(...r.media.create.map(x => x.targetId)); created.media = r.media.create.map(x => x.targetId); }
      add("moments", r.moments.create); add("momentComments", r.momentComments.create); add("diaries", r.diaries.create); add("worlds", r.worlds.create); add("worldbooks", r.worldbooks.create); add("calendar", r.calendar.create); add("memories", r.memories.create);
      if (r.archive === "create") { this.snapshot.archive = structuredClone(plan.archive); created.archive = ["archive"]; }
      if (r.idMap === "create") { this.snapshot.idMap = structuredClone(plan.idMap); created.idMap = ["idmap"]; }
      return { created, warnings: [], failures: [] };
    }
    async rollbackCreated(journal) {
      const rm = (key, ids, idField = "id") => { if (!ids?.length) return; const set = new Set(ids); this.snapshot[key] = this.snapshot[key].filter(v => !set.has(v[idField])); };
      rm("identities", journal.created.identities); rm("characters", journal.created.characters); rm("contacts", journal.created.contacts); rm("sessions", journal.created.sessions); rm("messages", journal.created.messages); rm("storySessions", journal.created.storySessions); rm("storyMessages", journal.created.storyMessages);
      if (journal.created.media?.length) this.snapshot.mediaIds = this.snapshot.mediaIds.filter(id => !new Set(journal.created.media).has(id));
      rm("moments", journal.created.moments); rm("momentComments", journal.created.momentComments); rm("diaries", journal.created.diaries); rm("worlds", journal.created.worlds); rm("worldbooks", journal.created.worldbooks); rm("calendar", journal.created.calendar); rm("memories", journal.created.memories);
      if (journal.created.archive?.length) delete this.snapshot.archive; if (journal.created.idMap?.length) delete this.snapshot.idMap;
      return { warnings: [], failures: [] };
    }
  }

  const storage = new FakeStorage();
  const initial = await dryRunFloatMigrationPackage(bytes, { storage });
  assert.equal(initial.ok, true);
  assert.equal(initial.dryRun.summary.characters, 4);
  assert.equal(initial.dryRun.summary.messages, 5153);
  assert.equal(initial.dryRun.summary.assets, 79);
  assert.equal(initial.dryRun.summary.moments, 9);
  assert.equal(initial.dryRun.summary.comments, 14);
  assert.equal(initial.dryRun.summary.diary, 1);
  assert.equal(initial.dryRun.summary.worldbooks, 14);
  assert.equal(initial.dryRun.summary.activeMemories, 250);
  assert.equal(initial.dryRun.summary.archivedMemories, 147);
  assert.equal(initial.dryRun.summary.activeFutureIntents, 4);
  assert.equal(initial.dryRun.summary.archivedWindowsill, 5);
  assert.equal(initial.dryRun.summary.memoryLinks, 32667);
  assert.equal(initial.dryRun.summary.legacyCoreSummaries, 11);
  assert.equal(initial.dryRun.summary.timelineRecords, 0);
  assert.equal(initial.dryRun.plan.memories.length, 261);
  assert.equal(initial.dryRun.plan.memories.filter(m => m.type === "long_term").length, 250);
  assert.equal(initial.dryRun.plan.memories.filter(m => m.type === "core").length, 11);
  assert.equal(initial.dryRun.plan.memories.filter(m => m.kind === "future_intent").length, 4);
  assert.equal(initial.dryRun.plan.archive.archivedFutureIntents.length, 5);
  assert.equal(initial.dryRun.plan.archive.memoryLinks.length, 32667);
  assert.equal(initial.dryRun.plan.archive.unsupportedRelationships.length, 4);
  assert.equal(initial.dryRun.plan.worlds.flatMap(w => w.relations).length, 0);
  assert.equal(initial.dryRun.plan.archive.diaryUserPages.length, 1);
  assert.equal(initial.dryRun.plan.archive.momentSourceMetadata.reduce((n, m) => n + (m.aggregateLikes || 0), 0), 29906);
  assert.equal(initial.dryRun.plan.moments.reduce((n, p) => n + p.likes.length, 0), 3);
  assert.equal(initial.dryRun.plan.messages[0].createdAt, messages[0].createdAt);
  assert.equal(initial.dryRun.plan.diaries[0].createdAt, diaries[0].createdAt);
  assert.equal(initial.dryRun.plan.messages.filter(m => m.mediaType === "app_card").length > 0, true);
  assert.equal(initial.dryRun.plan.messages.filter(m => m.mediaType === "image").length, 1);

  const stableA = deterministicNativeId("message", fingerprint, "m1");
  const stableB = deterministicNativeId("message", fingerprint, "m1");
  assert.equal(stableA, stableB);
  assert.notEqual(stableA, deterministicNativeId("message", fingerprint, "m2"));

  storage.snapshot.identities.push(structuredClone(initial.dryRun.plan.identities[0].value));
  const first = await applyFloatMigrationPackage(bytes, { storage });
  assert.equal(first.ok, true);
  assert.equal(first.dryRun.reconciliation.identities.reuse.length, 1);
  assert.equal(first.dryRun.reconciliation.totals.conflicts, 0);
  assert.equal(first.postImportReconciliation.totals.create, 0);
  assert.equal(storage.snapshot.messages.length, 5153);
  assert.equal(storage.snapshot.moments.length, 9);
  assert.equal(storage.snapshot.momentComments.length, 14);
  assert.equal(storage.snapshot.memories.filter(m => m.type === "long_term").length, 250);
  assert.equal(storage.snapshot.memories.filter(m => m.kind === "future_intent").length, 4);

  const second = await applyFloatMigrationPackage(bytes, { storage });
  assert.equal(second.ok, true);
  assert.equal(second.expectedVsActual.actualCreates, 0);
  assert.equal(second.dryRun.reconciliation.totals.create, 0);
  assert.equal(second.dryRun.reconciliation.totals.conflicts, 0);
  assert.equal(storage.snapshot.messages.length, 5153);

  const rollback = await rollbackFloatMigrationRun(first.journal.runId, storage);
  assert.equal(rollback.ok, true);
  assert.equal(rollback.journal.status, "rolled_back");
  assert.equal(storage.snapshot.characters.some(c => c.id === "preexisting-char"), true);
  assert.equal(storage.snapshot.identities.some(i => i.id === initial.dryRun.plan.identities[0].value.id), true, "reused identity must survive rollback");
  assert.equal(storage.snapshot.messages.length, 0);
  assert.equal(storage.snapshot.moments.length, 0);
  assert.equal(storage.snapshot.memories.length, 0);

  const conflictStorage = new FakeStorage();
  const conflictInitial = await dryRunFloatMigrationPackage(bytes, { storage: conflictStorage });
  const bad = { ...conflictInitial.dryRun.plan.characters[0].value, name: "Changed in Float" };
  conflictStorage.snapshot.characters.push(bad);
  const conflictRun = await dryRunFloatMigrationPackage(bytes, { storage: conflictStorage });
  assert.equal(conflictRun.dryRun.reconciliation.characters.conflicts.length, 1);

  console.log("migration completion pure tests passed");
} finally {
  await runtime.cleanup();
}
