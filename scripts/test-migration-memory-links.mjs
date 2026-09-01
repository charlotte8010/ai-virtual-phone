import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compileMigrationModules } from "./migration-ts-loader.mjs";

const runtime = await compileMigrationModules();
try {
  const { writeFloatMigrationPackage } = runtime.requireModule("format/package-writer.js");
  const { buildNativeMigrationPlan } = runtime.requireModule("native/mapper.js");
  const { deterministicNativeId } = runtime.requireModule("native/id.js");
  const { reconcileNativeMigrationPlan } = runtime.requireModule("native/reconcile.js");
  const { dryRunFloatMigrationPackage } = runtime.requireModule("native/importer.js");
  const storageSource = await readFile(new URL("../lib/migrations/native/storage.ts", import.meta.url), "utf8");
  const memoryStorageSource = await readFile(new URL("../lib/memory-storage.ts", import.meta.url), "utf8");

  const fingerprint = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  const createdAt = "2026-09-01T00:00:00.000Z";
  const source = (store, originalId) => ({
    platform: "sully", backupFormat: "sully_v3", backupFormatVersion: 3,
    backupFingerprint: fingerprint, store, originalId,
  });
  const characters = [
    { migrationId: "char-a", kind: "character", displayName: "A", persona: "A", source: source("characters", "a") },
    { migrationId: "char-b", kind: "character", displayName: "B", persona: "B", source: source("characters", "b") },
  ];
  const memories = [
    { migrationId: "memory-a", characterRef: "char-a", content: "A", createdAt, source: source("memoryNodes", "a") },
    { migrationId: "memory-b", characterRef: "char-a", content: "B", createdAt, source: source("memoryNodes", "b") },
    { migrationId: "memory-c", characterRef: "char-a", content: "C", createdAt, source: source("memoryNodes", "c") },
    { migrationId: "memory-d", characterRef: "char-b", content: "D", createdAt, source: source("memoryNodes", "d") },
    { migrationId: "memory-archived-a", characterRef: "char-a", content: "Archived A", archived: true, createdAt, source: source("memoryNodes", "archived-a") },
    { migrationId: "memory-archived-b", characterRef: "char-a", content: "Archived B", archived: true, createdAt, source: source("memoryNodes", "archived-b") },
  ];
  const memoryLinks = [
    { migrationId: "link-emotion", fromMemoryRef: "memory-a", toMemoryRef: "memory-b", type: "emotional", weight: 0.4, source: source("memoryLinks", "emotion") },
    { migrationId: "link-temporal", fromMemoryRef: "memory-b", toMemoryRef: "memory-c", type: "temporal", weight: 0.8, source: source("memoryLinks", "temporal") },
    { migrationId: "link-future", fromMemoryRef: "memory-a", toMemoryRef: "memory-c", type: "future_custom_relation", weight: 0.7, source: source("memoryLinks", "future") },
    { migrationId: "link-one-archived", fromMemoryRef: "memory-a", toMemoryRef: "memory-archived-a", type: "temporal", weight: 0.9, source: source("memoryLinks", "one-archived") },
    { migrationId: "link-both-archived", fromMemoryRef: "memory-archived-a", toMemoryRef: "memory-archived-b", type: "temporal", weight: 0.9, source: source("memoryLinks", "both-archived") },
    { migrationId: "link-cross", fromMemoryRef: "memory-c", toMemoryRef: "memory-d", type: "temporal", weight: 0.9, source: source("memoryLinks", "cross") },
  ];
  const payload = {
    identities: [], characters, relationships: [], conversations: [], messages: [], moments: [], diaries: [], worlds: [], worldbooks: [],
    stories: [], games: [], schedules: [], eventBoxes: [], memories, futureIntents: [], memoryLinks,
    extended: {}, compat: [],
    provenance: { idMap: {}, normalizationReport: {}, sourceManifest: {}, metadataRedactions: [], excludedSensitiveStores: {}, excludedRuntimeStores: {} },
  };
  const manifest = {
    format: "float_migration", formatVersion: 1, packageId: "pkg-memory-links-test",
    source: { platform: "sully", format: "sully_v3", formatVersion: 3, backupFingerprint: fingerprint }, createdAt,
    counts: { identities: 0, characters: 2, relationships: 0, conversations: 0, messages: 0, moments: 0, diaries: 0, worlds: 0, worldbooks: 0, stories: 0, games: 0, schedules: 0, eventBoxes: 0, memories: 6, futureIntents: 0, memoryLinks: memoryLinks.length, compatStores: 0 },
    assets: { count: 0, totalBytes: 0 }, skippedByPolicy: {}, warnings: [],
  };
  const plan = buildNativeMigrationPlan(manifest, payload, []);
  assert.equal(plan.archive.memoryLinks.length, 6);
  assert.equal(plan.memoryLinks.length, 3);
  assert.deepEqual(plan.memoryLinkAudit, {
    sourceLinksTotal: 6,
    bothEndpointsActive: 3,
    oneEndpointArchived: 1,
    bothEndpointsArchived: 1,
    crossCharacter: 1,
    brokenRef: 0,
    unresolvableEndpoint: 0,
    invalidStrength: 0,
    invalidType: 0,
    invalidStrengthSamples: [],
      sourceTypeCounts: { emotional: 1, temporal: 4, future_custom_relation: 1 },
    activeTypeCounts: { emotion: 1, temporal: 1, future_custom_relation: 1 },
  });
  assert.equal(plan.memoryLinks.find((link) => link.id === plan.idMap.memoryLinks["link-emotion"]).type, "emotion");
  assert.equal(plan.memoryLinks.find((link) => link.id === plan.idMap.memoryLinks["link-future"]).type, "future_custom_relation");
  assert.equal(plan.memoryLinks.find((link) => link.id === plan.idMap.memoryLinks["link-emotion"]).strength, 0.4);

  const terminalPayload = structuredClone(payload);
  terminalPayload.futureIntents = [{
    migrationId: "intent-terminal",
    characterRef: "char-a",
    content: "已经完成的计划",
    timePrecision: "unknown",
    status: "fulfilled",
    sourceMemoryRef: "memory-c",
    source: source("futureIntents", "terminal"),
  }];
  terminalPayload.memoryLinks.push({
    migrationId: "link-terminal-malformed",
    fromMemoryRef: "memory-a",
    toMemoryRef: "memory-c",
    source: source("memoryLinks", "terminal-malformed"),
  });
  const terminalPlan = buildNativeMigrationPlan(manifest, terminalPayload, []);
  assert.equal(terminalPlan.memories.find((entry) => entry.metadata?.migrationId === "memory-c").futureIntent?.status, "fulfilled");
  assert.equal(terminalPlan.memoryLinkAudit.bothEndpointsActive, 1);
  assert.equal(terminalPlan.memoryLinkAudit.invalidStrength, 0);
  assert.equal(terminalPlan.memoryLinkAudit.invalidType, 0);
  assert.equal(terminalPlan.memoryLinks.length, 1);
  assert.equal(terminalPlan.memoryLinks.some((link) => link.fromMemoryId === terminalPlan.idMap.memories["memory-a"] && link.toMemoryId === terminalPlan.idMap.memories["memory-c"]), false);
  assert.equal(terminalPlan.memoryLinks.some((link) => link.fromMemoryId === terminalPlan.idMap.memories["memory-b"] && link.toMemoryId === terminalPlan.idMap.memories["memory-c"]), false);

  const terminalBytes = await writeFloatMigrationPackage({
    manifest: { ...manifest, counts: { ...manifest.counts, memoryLinks: terminalPayload.memoryLinks.length } },
    payload: terminalPayload,
    binaryAssets: [],
  });
  const terminalRun = await dryRunFloatMigrationPackage(terminalBytes, { storage: { kind: "isolated-browser", async readSnapshot() { throw new Error("snapshot should not be read"); } } });
  assert.equal(terminalRun.ok, true, terminalRun.ok ? "" : terminalRun.errors.join("\n"));

  const brokenPayload = structuredClone(payload);
  brokenPayload.memoryLinks = [{
    migrationId: "link-broken",
    fromMemoryRef: "missing-memory",
    toMemoryRef: "memory-a",
    type: "temporal",
    weight: 0.5,
    source: source("memoryLinks", "broken"),
  }];
  const brokenManifest = { ...manifest, counts: { ...manifest.counts, memoryLinks: 1 } };
  const brokenBytes = await writeFloatMigrationPackage({ manifest: brokenManifest, payload: brokenPayload, binaryAssets: [] });
  const brokenRun = await dryRunFloatMigrationPackage(brokenBytes, { storage: { kind: "isolated-browser", async readSnapshot() { throw new Error("snapshot should not be read"); } } });
  assert.equal(brokenRun.ok, false);
  assert.match(brokenRun.errors.join("\n"), /orphan migration|missing memory nodes/);

  const invalidStrengthPayload = structuredClone(payload);
  invalidStrengthPayload.memoryLinks = [{
    migrationId: "link-invalid-strength",
    fromMemoryRef: "memory-a",
    toMemoryRef: "memory-b",
    type: "temporal",
    source: source("memoryLinks", "invalid-strength"),
  }];
  const invalidStrengthManifest = { ...manifest, counts: { ...manifest.counts, memoryLinks: 1 } };
  const invalidStrengthBytes = await writeFloatMigrationPackage({ manifest: invalidStrengthManifest, payload: invalidStrengthPayload, binaryAssets: [] });
  const invalidStrengthRun = await dryRunFloatMigrationPackage(invalidStrengthBytes, { storage: { kind: "isolated-browser", async readSnapshot() { throw new Error("snapshot should not be read"); } } });
  assert.equal(invalidStrengthRun.ok, false);
  assert.match(invalidStrengthRun.errors.join("\n"), /invalid strength/);

  const existingMemoryLinks = [
    {
      id: "existing-semantic", characterId: plan.memories.find((entry) => entry.metadata?.migrationId === "memory-a").characterId,
      fromMemoryId: plan.idMap.memories["memory-a"], toMemoryId: plan.idMap.memories["memory-b"], type: "emotion", strength: 0.2,
      createdAt, updatedAt: createdAt,
    },
    {
      id: deterministicNativeId("memory_link", fingerprint, "link-temporal"), characterId: plan.memories.find((entry) => entry.metadata?.migrationId === "memory-b").characterId,
      fromMemoryId: plan.idMap.memories["memory-b"], toMemoryId: plan.idMap.memories["memory-c"], type: "temporal", strength: 0.1,
      createdAt, updatedAt: createdAt,
    },
  ];
  const emptySnapshot = {
    identities: [], characters: [], contacts: [], sessions: [], messages: [], storySessions: [], storyMessages: [], mediaIds: [],
    moments: [], momentComments: [], diaries: [], worlds: [], worldbooks: [], calendar: [], memories: plan.memories,
    memoryLinks: existingMemoryLinks,
  };
  const reconciliation = reconcileNativeMigrationPlan(plan, emptySnapshot);
  assert.equal(reconciliation.memoryLinks.create.length, 1);
  assert.equal(reconciliation.memoryLinks.reuse.length, 1);
  assert.equal(reconciliation.memoryLinks.conflicts.length, 1);
  assert.equal(reconciliation.resolvedIdMap.memoryLinks["link-emotion"], "existing-semantic");
  assert.equal(Object.hasOwn(reconciliation.resolvedIdMap.memoryLinks, "link-temporal"), false);

  assert.match(storageSource, /saveMemoryEntries\([\s\S]*suppressMemoryLinkLifecycle:\s*true/);
  assert.match(storageSource, /saveMemoryLinks/);
  assert.match(storageSource, /loadMemoryLinks/);
  assert.match(storageSource, /deleteMemoryLinks\(journal\.created\.memoryLinks\)[\s\S]*deleteMemoryEntriesWithoutLinkCleanup\(journal\.created\.memories\)/);
  assert.doesNotMatch(storageSource, /deleteMemoryEntries\(journal\.created\.memories\)/);
  assert.match(memoryStorageSource, /export async function deleteMemoryEntriesWithoutLinkCleanup/);

  console.log("migration memory link mapping tests passed");
} finally {
  await runtime.cleanup();
}
