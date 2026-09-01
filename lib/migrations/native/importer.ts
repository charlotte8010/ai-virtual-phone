import type { MigrationAssetRef } from "../format/types";
import {
  readFloatMigrationPackage,
  type MigrationZipLoader,
  type ReadFloatMigrationPackageSuccess,
} from "../format/read-package";
import { buildNativeMigrationPlan } from "./mapper";
import { reconcileNativeMigrationPlan } from "./reconcile";
import type {
  MigrationRunJournal,
  NativeMigrationDryRun,
  NativeMigrationPlan,
  NativeMigrationReconciliation,
} from "./types";
import type { NativeMigrationStorage } from "./storage";

function createMigrationRunJournal(packageId: string, sourceFingerprint: string): MigrationRunJournal {
  const entropy = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return {
    runId: `migration_run_${entropy}`, packageId, sourceFingerprint, status: "planned",
    startedAt: new Date().toISOString(), created: {}, reused: {}, skipped: {}, conflicts: {}, warnings: [], failures: [],
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let output = "";
    const size = 0x8000;
    for (let index = 0; index < bytes.length; index += size) {
      output += String.fromCharCode(...bytes.subarray(index, Math.min(bytes.length, index + size)));
    }
    return btoa(output);
  }
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  throw new Error("base64 encoding is unavailable in this runtime");
}

function dataUrl(bytes: Uint8Array, asset: MigrationAssetRef): string {
  return `data:${asset.mediaType || "application/octet-stream"};base64,${bytesToBase64(bytes)}`;
}

async function materializeInlineAssets(plan: NativeMigrationPlan, pkg: ReadFloatMigrationPackageSuccess): Promise<void> {
  const assetById = new Map(pkg.assets.map((asset) => [asset.assetId, asset]));
  for (const identity of plan.identities) {
    if (!identity.avatarAssetId) continue;
    const asset = assetById.get(identity.avatarAssetId);
    const bytes = asset ? await pkg.getAssetBytes(asset) : null;
    if (!asset || !bytes) {
      plan.warnings.push(`identity avatar asset ${identity.avatarAssetId} could not be resolved`);
      continue;
    }
    identity.value.avatarUrl = dataUrl(bytes, asset);
  }
  for (const character of plan.characters) {
    if (!character.avatarAssetId) continue;
    const asset = assetById.get(character.avatarAssetId);
    const bytes = asset ? await pkg.getAssetBytes(asset) : null;
    if (!asset || !bytes) {
      plan.warnings.push(`character avatar asset ${character.avatarAssetId} could not be resolved`);
      continue;
    }
    character.value.avatar = dataUrl(bytes, asset);
  }
}

function dryRunSummary(plan: NativeMigrationPlan): NativeMigrationDryRun["summary"] {
  return {
    characters: plan.characters.length,
    sourceMessages: plan.messages.length + plan.storyMessages.length,
    chatMessages: plan.messages.length,
    storyMessages: plan.storyMessages.length,
    storySessions: plan.storySessions.length,
    messages: plan.messages.length,
    assets: plan.media.length,
    moments: plan.moments.length,
    comments: plan.momentComments.length,
    diary: plan.diaries.length,
    worldbooks: plan.worldbooks.length,
    activeMemories: plan.activeMemoryPalaceCount,
    archivedMemories: plan.archive.archivedMemories.length,
    activeFutureIntents: plan.activeFutureIntentCount,
    archivedWindowsill: plan.archivedWindowsillCount,
    memoryLinks: plan.archive.memoryLinks.length,
    activeMemoryLinks: plan.memoryLinks.length,
    archiveOnlyMemoryLinks: plan.archive.memoryLinks.length - plan.memoryLinks.length,
    legacyCoreSummaries: plan.legacyCoreMemoryCount,
    timelineRecords: plan.timelineRecords.length,
  };
}

function validateMemoryLinkAudit(plan: NativeMigrationPlan): string[] {
  const audit = plan.memoryLinkAudit;
  const errors: string[] = [];
  if (audit.brokenRef > 0) errors.push(`memory link migration stopped: ${audit.brokenRef} link(s) reference missing memory nodes`);
  if (audit.invalidStrength > 0) errors.push(`memory link migration stopped: ${audit.invalidStrength} activatable link(s) have invalid strength`);
  if (audit.invalidType > 0) errors.push(`memory link migration stopped: ${audit.invalidType} activatable link(s) have invalid type`);
  return errors;
}

export interface PrepareNativeMigrationOptions {
  storage: NativeMigrationStorage;
  zipLoader?: MigrationZipLoader;
}

export interface PrepareNativeMigrationSuccess {
  ok: true;
  pkg: ReadFloatMigrationPackageSuccess;
  dryRun: NativeMigrationDryRun;
}
export interface PrepareNativeMigrationFailure {
  ok: false;
  errors: string[];
  warnings: string[];
}
export type PrepareNativeMigrationResult = PrepareNativeMigrationSuccess | PrepareNativeMigrationFailure;

export async function dryRunFloatMigrationPackage(
  input: ArrayBuffer | Uint8Array,
  options: PrepareNativeMigrationOptions,
): Promise<PrepareNativeMigrationResult> {
  const read = await readFloatMigrationPackage(input, { zipLoader: options.zipLoader });
  if (!read.ok) return { ok: false, errors: read.errors, warnings: read.warnings };
  const plan = buildNativeMigrationPlan(read.manifest, read.payload, read.assets);
  const linkErrors = validateMemoryLinkAudit(plan);
  if (linkErrors.length) return { ok: false, errors: linkErrors, warnings: [...read.warnings, ...plan.warnings] };
  await materializeInlineAssets(plan, read);
  const snapshot = await options.storage.readSnapshot(plan);
  const reconciliation = reconcileNativeMigrationPlan(plan, snapshot);
  return {
    ok: true,
    pkg: read,
    dryRun: { plan, reconciliation, summary: dryRunSummary(plan) },
  };
}

function copyReconciliationToJournal(journal: MigrationRunJournal, r: NativeMigrationReconciliation): void {
  const set = (domain: keyof MigrationRunJournal["reused"], part: { reuse: unknown[]; skip: unknown[]; conflicts: Array<{ planned: unknown }> }, idOf: (value: unknown) => string) => {
    if (part.reuse.length) journal.reused[domain] = part.reuse.map(idOf);
    if (part.skip.length) journal.skipped[domain] = part.skip.map(idOf);
    if (part.conflicts.length) journal.conflicts[domain] = part.conflicts.map((entry) => idOf(entry.planned));
  };
  const id = (value: unknown) => String((value as { id?: unknown }).id ?? "");
  set("identities", r.identities, id);
  set("characters", r.characters, id);
  set("contacts", r.contacts, id);
  set("sessions", r.sessions, id);
  set("messages", r.messages, id);
  set("media", r.media, (value) => String((value as { targetId?: unknown }).targetId ?? ""));
  set("moments", r.moments, id);
  set("momentComments", r.momentComments, id);
  set("diaries", r.diaries, id);
  set("worlds", r.worlds, id);
  set("worldbooks", r.worldbooks, id);
  set("calendar", r.calendar, id);
  set("memories", r.memories, id);
  set("memoryLinks", r.memoryLinks, id);
  set("storySessions", r.storySessions, id);
  set("storyMessages", r.storyMessages, id);
  const archiveKey = `archive:${journal.sourceFingerprint}`;
  const idMapKey = `idmap:${journal.sourceFingerprint}`;
  if (r.archive === "reuse") journal.reused.archive = [archiveKey];
  if (r.archive === "conflict") journal.conflicts.archive = [archiveKey];
  if (r.idMap === "reuse") journal.reused.idMap = [idMapKey];
  if (r.idMap === "conflict") journal.conflicts.idMap = [idMapKey];
}

export interface NativeMigrationApplyResult {
  ok: boolean;
  dryRun: NativeMigrationDryRun;
  journal: MigrationRunJournal;
  postImportReconciliation: NativeMigrationReconciliation;
  expectedVsActual: {
    plannedCreates: number;
    actualCreates: number;
    reused: number;
    skipped: number;
    conflicts: number;
    failed: number;
    warnings: number;
    remainingCreatesAfterApply: number;
  };
}

export async function applyFloatMigrationPackage(
  input: ArrayBuffer | Uint8Array,
  options: PrepareNativeMigrationOptions,
): Promise<NativeMigrationApplyResult | PrepareNativeMigrationFailure> {
  const prepared = await dryRunFloatMigrationPackage(input, options);
  if (!prepared.ok) return prepared;
  const { pkg, dryRun } = prepared;
  const journal = createMigrationRunJournal(pkg.manifest.packageId, pkg.manifest.source.backupFingerprint);
  journal.status = "applying";
  journal.warnings.push(...pkg.warnings, ...dryRun.plan.warnings);
  copyReconciliationToJournal(journal, dryRun.reconciliation);
  await options.storage.saveJournal(journal);

  const storageResult = await options.storage.applyCreates(dryRun.plan, dryRun.reconciliation, pkg);
  journal.created = storageResult.created;
  journal.warnings.push(...storageResult.warnings);
  journal.failures.push(...storageResult.failures);
  journal.status = journal.failures.length ? "failed" : "applied";
  journal.completedAt = new Date().toISOString();
  await options.storage.saveJournal(journal);

  const postSnapshot = await options.storage.readSnapshot(dryRun.plan);
  const postImportReconciliation = reconcileNativeMigrationPlan(dryRun.plan, postSnapshot);
  const actualCreates = Object.values(journal.created).reduce((total, list) => total + (list?.length ?? 0), 0);
  const failed = journal.failures.length;
  const expectedVsActual = {
    plannedCreates: dryRun.reconciliation.totals.create,
    actualCreates,
    reused: dryRun.reconciliation.totals.reuse,
    skipped: dryRun.reconciliation.totals.skip,
    conflicts: dryRun.reconciliation.totals.conflicts,
    failed,
    warnings: journal.warnings.length,
    remainingCreatesAfterApply: postImportReconciliation.totals.create,
  };
  const ok = failed === 0 && postImportReconciliation.totals.create === 0 && postImportReconciliation.totals.conflicts === dryRun.reconciliation.totals.conflicts;
  return { ok, dryRun, journal, postImportReconciliation, expectedVsActual };
}

export interface RollbackMigrationResult {
  ok: boolean;
  journal?: MigrationRunJournal;
  warnings: string[];
  failures: string[];
}

export async function rollbackFloatMigrationRun(runId: string, storage: NativeMigrationStorage): Promise<RollbackMigrationResult> {
  const journal = await storage.readJournal(runId);
  if (!journal) return { ok: false, warnings: [], failures: [`migration journal not found: ${runId}`] };
  if (journal.status === "rolled_back") return { ok: true, journal, warnings: ["migration run is already rolled back"], failures: [] };
  const result = await storage.rollbackCreated(journal);
  journal.warnings.push(...result.warnings);
  journal.failures.push(...result.failures);
  if (result.failures.length === 0) {
    journal.status = "rolled_back";
    journal.rolledBackAt = new Date().toISOString();
  } else {
    journal.status = "failed";
  }
  await storage.saveJournal(journal);
  return { ok: result.failures.length === 0, journal, warnings: result.warnings, failures: result.failures };
}
