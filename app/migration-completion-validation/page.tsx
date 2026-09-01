"use client";

import { useState } from "react";
import {
  applyFloatMigrationPackage,
  dryRunFloatMigrationPackage,
  rollbackFloatMigrationRun,
} from "@/lib/migrations/native/importer";
import { IsolatedBrowserNativeMigrationStorage } from "@/lib/migrations/native/storage";
import type { NativeMigrationPlan, NativeMigrationSnapshot } from "@/lib/migrations/native/types";
import type { UserIdentity } from "@/components/settings/user-identity";

const BASELINE_IDENTITY: UserIdentity = {
  id: "validation-preexisting-identity",
  name: "Pre-existing Float identity",
  bio: "Must survive migration rollback",
  gender: "",
  age: "",
  occupation: "",
  customSettings: "",
};

type SideEffectCounts = {
  liveChatPushEvents: number;
  autonomousReplyEvents: number;
  notificationCalls: number;
  externalFetchCalls: number;
  externalXhrCalls: number;
  productionIndexedDbOpens: string[];
  productionMemoryWrites: number;
};

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  const output: Record<string, number> = {};
  for (const value of values) {
    const item = key(value);
    output[item] = (output[item] ?? 0) + 1;
  }
  return output;
}

function importedSnapshotCounts(snapshot: NativeMigrationSnapshot): Record<string, number> {
  return {
    characters: snapshot.characters.length,
    messages: snapshot.messages.length,
    assets: snapshot.mediaIds.length,
    moments: snapshot.moments.length,
    comments: snapshot.momentComments.length,
    diary: snapshot.diaries.length,
    worldbooks: snapshot.worldbooks.length,
    activeMemoryPalace: snapshot.memories.filter((entry) => entry.type === "long_term").length,
    legacyCore: snapshot.memories.filter((entry) => entry.type === "core").length,
    activeFutureIntents: snapshot.memories.filter((entry) => entry.kind === "future_intent").length,
    archivedMemories: snapshot.archive?.archivedMemories.length ?? 0,
    archivedWindowsill: snapshot.archive?.archivedMemories.filter((entry) => entry.room === "windowsill").length ?? 0,
    memoryLinks: snapshot.archive?.memoryLinks.length ?? 0,
  };
}

function createdCount(created: Record<string, string[] | undefined>): number {
  return Object.values(created).reduce((total, values) => total + (values?.length ?? 0), 0);
}

function importedResidualCount(snapshot: NativeMigrationSnapshot): number {
  return snapshot.characters.length
    + snapshot.contacts.length
    + snapshot.sessions.length
    + snapshot.messages.length
    + snapshot.mediaIds.length
    + snapshot.moments.length
    + snapshot.momentComments.length
    + snapshot.diaries.length
    + snapshot.worlds.length
    + snapshot.worldbooks.length
    + snapshot.calendar.length
    + snapshot.memories.length
    + (snapshot.archive ? 1 : 0)
    + (snapshot.idMap ? 1 : 0);
}

function closeStorageConnection(storage: IsolatedBrowserNativeMigrationStorage): void {
  // Validation-only close/reopen assertion. `private` is a TypeScript boundary; no production API is exposed for this test page.
  const internal = storage as unknown as { db: { close(): void } };
  internal.db.close();
}

function installSideEffectSpies(namespace: string): { counts: SideEffectCounts; restore(): void } {
  const counts: SideEffectCounts = {
    liveChatPushEvents: 0,
    autonomousReplyEvents: 0,
    notificationCalls: 0,
    externalFetchCalls: 0,
    externalXhrCalls: 0,
    productionIndexedDbOpens: [],
    productionMemoryWrites: 0,
  };

  const onChatPush = () => { counts.liveChatPushEvents += 1; };
  const onReply = () => { counts.autonomousReplyEvents += 1; };
  window.addEventListener("chat-message-pushed", onChatPush);
  window.addEventListener("chat-request-reply", onReply);

  const originalFetch = window.fetch;
  window.fetch = (async (...args: Parameters<typeof fetch>) => {
    counts.externalFetchCalls += 1;
    return originalFetch(...args);
  }) as typeof fetch;

  const originalXhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args: Parameters<XMLHttpRequest["open"]>) {
    counts.externalXhrCalls += 1;
    return originalXhrOpen.apply(this, args);
  } as XMLHttpRequest["open"];

  const originalOpen = indexedDB.open.bind(indexedDB);
  indexedDB.open = ((name: string, version?: number) => {
    if (!name.startsWith(`FloatMigrationIsolation_${namespace}`)) {
      counts.productionIndexedDbOpens.push(name);
    }
    return version === undefined ? originalOpen(name) : originalOpen(name, version);
  }) as typeof indexedDB.open;

  const objectStorePut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore["put"]>) {
    try {
      if (this.name === "memories") {
        const dbName = this.transaction.db.name;
        if (dbName === "ai_phone_memory_db_v1") counts.productionMemoryWrites += 1;
      }
    } catch {
      // Probe failure must never change the migration operation.
    }
    return objectStorePut.apply(this, args);
  } as IDBObjectStore["put"];

  const notificationDescriptor = Object.getOwnPropertyDescriptor(window, "Notification");
  const originalNotification = window.Notification;
  try {
    const SpyNotification = function () {
      counts.notificationCalls += 1;
      throw new Error("Notification is forbidden during historical migration validation");
    } as unknown as typeof Notification;
    Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: SpyNotification });
  } catch {
    // Some browsers expose a non-configurable Notification constructor; the event/API probes still run.
  }

  return {
    counts,
    restore() {
      window.removeEventListener("chat-message-pushed", onChatPush);
      window.removeEventListener("chat-request-reply", onReply);
      window.fetch = originalFetch;
      XMLHttpRequest.prototype.open = originalXhrOpen;
      indexedDB.open = originalOpen;
      IDBObjectStore.prototype.put = objectStorePut;
      try {
        if (notificationDescriptor) Object.defineProperty(window, "Notification", notificationDescriptor);
        else Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: originalNotification });
      } catch {
        // Ignore restore failure in the validation page only.
      }
    },
  };
}

function assertRealPackage(plan: NativeMigrationPlan): void {
  const expected = {
    characters: 4,
    messages: 5153,
    assets: 79,
    moments: 9,
    comments: 14,
    diary: 1,
    worldbooks: 14,
    activeMemories: 250,
    archivedMemories: 147,
    activeFutureIntents: 4,
    archivedWindowsill: 5,
    memoryLinks: 32667,
    legacyCoreSummaries: 11,
  };
  const actual = {
    characters: plan.characters.length,
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
    legacyCoreSummaries: plan.legacyCoreMemoryCount,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (actual[key as keyof typeof actual] !== expectedValue) {
      throw new Error(`real package count mismatch ${key}: expected ${expectedValue}, got ${actual[key as keyof typeof actual]}`);
    }
  }
  if (plan.timelineRecords.length !== 0) throw new Error("timeline records must remain derived, not imported");
}

export default function MigrationCompletionValidationPage() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string>("");
  const [running, setRunning] = useState(false);

  async function run(): Promise<void> {
    if (!file) return;
    setRunning(true);
    setError("");
    setResult(null);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const namespace = `real_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    let storage = new IsolatedBrowserNativeMigrationStorage(namespace);
    const conflictNamespace = `${namespace}_conflict`;
    const conflictStorage = new IsolatedBrowserNativeMigrationStorage(conflictNamespace);

    try {
      await storage.seedForIntegration({ identities: [BASELINE_IDENTITY] });
      const dry = await dryRunFloatMigrationPackage(bytes, { storage });
      if (!dry.ok) throw new Error(`dry-run failed: ${dry.errors.join(" | ")}`);
      assertRealPackage(dry.dryRun.plan);

      const spies = installSideEffectSpies(namespace);
      let first;
      try {
        first = await applyFloatMigrationPackage(bytes, { storage });
      } finally {
        spies.restore();
      }
      if (!("journal" in first) || !first.ok) {
        throw new Error(`first apply failed: ${"errors" in first ? first.errors.join(" | ") : JSON.stringify(first)}`);
      }

      closeStorageConnection(storage);
      storage = new IsolatedBrowserNativeMigrationStorage(namespace);
      const firstSnapshot = await storage.readSnapshot(first.dryRun.plan);
      const firstCounts = importedSnapshotCounts(firstSnapshot);
      const firstRoles = countBy(firstSnapshot.messages, (message) => message.role);
      const richTypes = countBy(firstSnapshot.messages, (message) => message.mediaType ?? "text");
      const planMessageById = new Map(first.dryRun.plan.messages.map((message) => [message.id, message]));
      const timestampMismatches = firstSnapshot.messages.filter((message) => planMessageById.get(message.id)?.createdAt !== message.createdAt).length;
      const orderMismatches = firstSnapshot.messages.filter((message) => planMessageById.get(message.id)?.order !== message.order).length;
      const mediaRefs = firstSnapshot.messages.flatMap((message) => {
        const refs: string[] = [];
        if (message.mediaUrl) refs.push(message.mediaUrl);
        const layout = message.mediaData?.appCardLayout;
        if (layout && typeof layout.mediaRef === "string") refs.push(layout.mediaRef);
        return refs;
      });
      const nondeterministicMediaRefs = mediaRefs.filter((ref) => !/^media-store:\/\/fm_media_[a-z0-9]+$/u.test(ref));

      const expectedFirstCounts = { characters: 4, messages: 5153, assets: 79, moments: 9, comments: 14, diary: 1, worldbooks: 14, activeMemoryPalace: 250, legacyCore: 11, activeFutureIntents: 4, archivedMemories: 147, archivedWindowsill: 5, memoryLinks: 32667 };
      for (const [key, expectedValue] of Object.entries(expectedFirstCounts)) {
        if (firstCounts[key] !== expectedValue) throw new Error(`first post-write count mismatch ${key}: expected ${expectedValue}, got ${firstCounts[key]}`);
      }
      if (firstRoles.assistant !== 3510 || firstRoles.user !== 1575 || firstRoles.system !== 68) throw new Error(`role distribution mismatch: ${JSON.stringify(firstRoles)}`);
      if ((richTypes.text ?? 0) === 5153) throw new Error("rich messages were flattened to text");
      if (timestampMismatches || orderMismatches) throw new Error(`historical ordering mismatch timestamps=${timestampMismatches} order=${orderMismatches}`);
      if (nondeterministicMediaRefs.length) throw new Error(`non-deterministic media refs: ${nondeterministicMediaRefs.slice(0, 3).join(", ")}`);
      if (spies.counts.liveChatPushEvents !== 0) throw new Error(`pushChatMessage/live chat events fired ${spies.counts.liveChatPushEvents} times`);
      if (spies.counts.autonomousReplyEvents !== 0) throw new Error(`autonomous reply events fired ${spies.counts.autonomousReplyEvents} times`);
      if (spies.counts.notificationCalls !== 0) throw new Error(`notifications fired ${spies.counts.notificationCalls} times`);
      if (spies.counts.externalFetchCalls !== 0 || spies.counts.externalXhrCalls !== 0) throw new Error(`external API activity fetch=${spies.counts.externalFetchCalls} xhr=${spies.counts.externalXhrCalls}`);
      if (spies.counts.productionIndexedDbOpens.length !== 0) throw new Error(`production IndexedDB opened during isolated apply: ${spies.counts.productionIndexedDbOpens.join(", ")}`);
      if (spies.counts.productionMemoryWrites !== 0) throw new Error(`production memory writes observed: ${spies.counts.productionMemoryWrites}`);

      const beforeSecond = importedSnapshotCounts(firstSnapshot);
      const second = await applyFloatMigrationPackage(bytes, { storage });
      if (!("journal" in second) || !second.ok) throw new Error(`second apply failed: ${JSON.stringify(second)}`);
      closeStorageConnection(storage);
      storage = new IsolatedBrowserNativeMigrationStorage(namespace);
      const secondSnapshot = await storage.readSnapshot(second.dryRun.plan);
      const secondCounts = importedSnapshotCounts(secondSnapshot);
      const duplicateDelta = Object.fromEntries(Object.keys(beforeSecond).map((key) => [key, secondCounts[key] - beforeSecond[key]]));
      if (Object.values(duplicateDelta).some((value) => value !== 0)) throw new Error(`duplicate delta is not zero: ${JSON.stringify(duplicateDelta)}`);
      if (second.expectedVsActual.actualCreates !== 0 || second.dryRun.reconciliation.totals.create !== 0) throw new Error(`second apply unexpectedly created records: ${JSON.stringify(second.expectedVsActual)}`);

      const conflictDry = await dryRunFloatMigrationPackage(bytes, { storage: conflictStorage });
      if (!conflictDry.ok) throw new Error(`conflict setup dry-run failed: ${conflictDry.errors.join(" | ")}`);
      const targetCharacter = conflictDry.dryRun.plan.characters[0].value;
      const conflictingCharacter = { ...targetCharacter, name: `${targetCharacter.name} [preexisting Float edit]` };
      await conflictStorage.seedForIntegration({ characters: [conflictingCharacter] });
      const conflictCheck = await dryRunFloatMigrationPackage(bytes, { storage: conflictStorage });
      if (!conflictCheck.ok) throw new Error(`conflict dry-run failed: ${conflictCheck.errors.join(" | ")}`);
      if (conflictCheck.dryRun.reconciliation.characters.conflicts.length !== 1) throw new Error(`expected one character conflict, observed ${conflictCheck.dryRun.reconciliation.characters.conflicts.length}`);
      const conflictSnapshot = await conflictStorage.readSnapshot(conflictCheck.dryRun.plan);
      if (conflictSnapshot.characters.find((entry) => entry.id === conflictingCharacter.id)?.name !== conflictingCharacter.name) throw new Error("conflict test overwrote pre-existing Float record");

      const rollback = await rollbackFloatMigrationRun(first.journal.runId, storage);
      if (!rollback.ok || rollback.journal?.status !== "rolled_back") throw new Error(`rollback failed: ${JSON.stringify(rollback)}`);
      closeStorageConnection(storage);
      storage = new IsolatedBrowserNativeMigrationStorage(namespace);
      const rollbackSnapshot = await storage.readSnapshot(first.dryRun.plan);
      const rolledJournal = await storage.readJournal(first.journal.runId);
      const baselinePreserved = rollbackSnapshot.identities.some((entry) => entry.id === BASELINE_IDENTITY.id);
      const residualImportedRecords = importedResidualCount(rollbackSnapshot);
      if (!baselinePreserved) throw new Error("rollback deleted pre-existing Float identity");
      if (residualImportedRecords !== 0) throw new Error(`rollback left ${residualImportedRecords} imported native/archive records`);
      if (rolledJournal?.status !== "rolled_back") throw new Error(`journal status after reopen is ${rolledJournal?.status ?? "missing"}`);

      const firstActualCreate = createdCount(first.journal.created as Record<string, string[] | undefined>);
      const secondActualCreate = createdCount(second.journal.created as Record<string, string[] | undefined>);
      setResult({
        namespace,
        databaseName: storage.databaseName,
        dryRun: dry.dryRun.summary,
        firstApply: {
          plannedCreate: first.dryRun.reconciliation.totals.create,
          actualCreate: firstActualCreate,
          reuse: first.dryRun.reconciliation.totals.reuse,
          skip: first.dryRun.reconciliation.totals.skip,
          conflict: first.dryRun.reconciliation.totals.conflicts,
          warning: first.journal.warnings.length,
          failed: first.journal.failures.length,
          postReconciliation: first.expectedVsActual,
        },
        firstPostWriteReread: {
          counts: firstCounts,
          roles: firstRoles,
          richTypes,
          mediaRefCount: mediaRefs.length,
          nondeterministicMediaRefs: nondeterministicMediaRefs.length,
          timestampMismatches,
          orderMismatches,
          timelineRecords: first.dryRun.plan.timelineRecords.length,
        },
        sideEffects: {
          cognitiveExtractionCalls: spies.counts.productionMemoryWrites,
          futureIntentDetectorCalls: spies.counts.liveChatPushEvents,
          pushChatMessageCalls: spies.counts.liveChatPushEvents,
          autonomousReplyCalls: spies.counts.autonomousReplyEvents,
          notificationCalls: spies.counts.notificationCalls,
          externalApiCalls: spies.counts.externalFetchCalls + spies.counts.externalXhrCalls,
          productionIndexedDbOpens: spies.counts.productionIndexedDbOpens,
        },
        secondApply: {
          plannedCreate: second.dryRun.reconciliation.totals.create,
          actualCreate: secondActualCreate,
          reuse: second.dryRun.reconciliation.totals.reuse,
          skip: second.dryRun.reconciliation.totals.skip,
          conflict: second.dryRun.reconciliation.totals.conflicts,
          warning: second.journal.warnings.length,
          failed: second.journal.failures.length,
          actualCounts: secondCounts,
          duplicateDelta,
          postReconciliation: second.expectedVsActual,
        },
        conflict: {
          conflicts: conflictCheck.dryRun.reconciliation.characters.conflicts.length,
          originalPreserved: true,
          preexistingId: conflictingCharacter.id,
        },
        rollback: {
          ok: rollback.ok,
          journalStatus: rolledJournal?.status,
          baselineIdentityPreserved: baselinePreserved,
          removed: firstActualCreate,
          residualImportedRecords,
          remainingSnapshot: importedSnapshotCounts(rollbackSnapshot),
        },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.stack || cause.message : String(cause));
    } finally {
      await storage.dispose?.();
      await conflictStorage.dispose?.();
      setRunning(false);
    }
  }

  return (
    <main style={{ padding: 24, fontFamily: "monospace", maxWidth: 1100, margin: "0 auto" }}>
      <h1>Migration Completion Validation</h1>
      <p>Client-only test harness. The selected package is never uploaded.</p>
      <input id="migration-package" type="file" accept=".zip,.float-migration.zip" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
      <button id="run-validation" type="button" disabled={!file || running} onClick={() => void run()} style={{ marginLeft: 12 }}>
        {running ? "Running…" : "Run isolated validation"}
      </button>
      {error ? <pre id="validation-error" style={{ whiteSpace: "pre-wrap", color: "crimson" }}>{error}</pre> : null}
      {result ? <pre id="validation-result" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(result, null, 2)}</pre> : null}
    </main>
  );
}
