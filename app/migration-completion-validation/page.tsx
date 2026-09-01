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

function countBy<T>(values: T[], pick: (value: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) {
    const key = pick(value);
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function snapshotCounts(snapshot: NativeMigrationSnapshot): Record<string, number> {
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

function countCreated(created: Record<string, string[] | undefined>): number {
  return Object.values(created).reduce((sum, values) => sum + (values?.length ?? 0), 0);
}

function residualImportedRecords(snapshot: NativeMigrationSnapshot): number {
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

function closeForReopen(storage: IsolatedBrowserNativeMigrationStorage): void {
  const internal = storage as unknown as { db: { close(): void } };
  internal.db.close();
}

function assertRealPackage(plan: NativeMigrationPlan): void {
  const expected: Record<string, number> = {
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
  const actual: Record<string, number> = {
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
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) throw new Error(`real package ${key}: expected ${value}, got ${actual[key]}`);
  }
  if (plan.timelineRecords.length !== 0) throw new Error("timeline records must stay derived");
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

  const originalXhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, ...args: Parameters<XMLHttpRequest["send"]>): void {
    counts.externalXhrCalls += 1;
    originalXhrSend.apply(this, args);
  };

  const originalIndexedDbOpen = indexedDB.open.bind(indexedDB);
  indexedDB.open = ((name: string, version?: number) => {
    if (!name.startsWith(`FloatMigrationIsolation_${namespace}`)) counts.productionIndexedDbOpens.push(name);
    return version === undefined ? originalIndexedDbOpen(name) : originalIndexedDbOpen(name, version);
  }) as typeof indexedDB.open;

  const originalPut = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey): IDBRequest<IDBValidKey> {
    if (this.name === "memories" && this.transaction.db.name === "ai_phone_memory_db_v1") {
      counts.productionMemoryWrites += 1;
    }
    return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
  };

  const notificationDescriptor = Object.getOwnPropertyDescriptor(window, "Notification");
  const originalNotification = window.Notification;
  try {
    const SpyNotification = function () {
      counts.notificationCalls += 1;
      throw new Error("Notification is forbidden during historical migration validation");
    } as unknown as typeof Notification;
    Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: SpyNotification });
  } catch {
    // Browser may expose a non-configurable constructor; other probes remain active.
  }

  return {
    counts,
    restore() {
      window.removeEventListener("chat-message-pushed", onChatPush);
      window.removeEventListener("chat-request-reply", onReply);
      window.fetch = originalFetch;
      XMLHttpRequest.prototype.send = originalXhrSend;
      indexedDB.open = originalIndexedDbOpen;
      IDBObjectStore.prototype.put = originalPut;
      try {
        if (notificationDescriptor) Object.defineProperty(window, "Notification", notificationDescriptor);
        else Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: originalNotification });
      } catch {
        // Validation-only cleanup.
      }
    },
  };
}

export default function MigrationCompletionValidationPage() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [running, setRunning] = useState(false);

  async function run(): Promise<void> {
    if (!file) return;
    setRunning(true);
    setResult(null);
    setError("");

    const bytes = new Uint8Array(await file.arrayBuffer());
    const namespace = `real_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const conflictNamespace = `${namespace}_conflict`;
    let storage = new IsolatedBrowserNativeMigrationStorage(namespace);
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
      if (!("journal" in first) || !first.ok) throw new Error(`first apply failed: ${JSON.stringify(first)}`);

      closeForReopen(storage);
      storage = new IsolatedBrowserNativeMigrationStorage(namespace);
      const firstSnapshot = await storage.readSnapshot(first.dryRun.plan);
      const firstCounts = snapshotCounts(firstSnapshot);
      const expectedFirst: Record<string, number> = {
        characters: 4, messages: 5153, assets: 79, moments: 9, comments: 14, diary: 1, worldbooks: 14,
        activeMemoryPalace: 250, legacyCore: 11, activeFutureIntents: 4, archivedMemories: 147,
        archivedWindowsill: 5, memoryLinks: 32667,
      };
      for (const [key, value] of Object.entries(expectedFirst)) {
        if (firstCounts[key] !== value) throw new Error(`post-write ${key}: expected ${value}, got ${firstCounts[key]}`);
      }

      const roles = countBy(firstSnapshot.messages, (message) => message.role);
      if (roles.assistant !== 3510 || roles.user !== 1575 || roles.system !== 68) throw new Error(`role mismatch ${JSON.stringify(roles)}`);
      const richTypes = countBy(firstSnapshot.messages, (message) => message.mediaType ?? "text");
      if ((richTypes.text ?? 0) === 5153) throw new Error("all rich messages were flattened to text");

      const plannedMessages = new Map(first.dryRun.plan.messages.map((message) => [message.id, message]));
      const timestampMismatches = firstSnapshot.messages.filter((message) => plannedMessages.get(message.id)?.createdAt !== message.createdAt).length;
      const orderMismatches = firstSnapshot.messages.filter((message) => plannedMessages.get(message.id)?.order !== message.order).length;
      if (timestampMismatches || orderMismatches) throw new Error(`history mismatch timestamps=${timestampMismatches} order=${orderMismatches}`);

      const mediaRefs = firstSnapshot.messages.flatMap((message) => {
        const refs: string[] = [];
        if (message.mediaUrl) refs.push(message.mediaUrl);
        const layout = message.mediaData?.appCardLayout;
        if (layout && typeof layout.mediaRef === "string") refs.push(layout.mediaRef);
        return refs;
      });
      const badMediaRefs = mediaRefs.filter((ref) => !/^media-store:\/\/fm_media_[a-z0-9]+$/u.test(ref));
      if (badMediaRefs.length) throw new Error(`non-deterministic media refs: ${badMediaRefs.slice(0, 3).join(", ")}`);

      if (spies.counts.liveChatPushEvents !== 0) throw new Error(`live chat path fired ${spies.counts.liveChatPushEvents} times`);
      if (spies.counts.autonomousReplyEvents !== 0) throw new Error(`autonomous reply fired ${spies.counts.autonomousReplyEvents} times`);
      if (spies.counts.notificationCalls !== 0) throw new Error(`notifications fired ${spies.counts.notificationCalls} times`);
      if (spies.counts.externalFetchCalls !== 0 || spies.counts.externalXhrCalls !== 0) throw new Error(`external API activity fetch=${spies.counts.externalFetchCalls} xhr=${spies.counts.externalXhrCalls}`);
      if (spies.counts.productionIndexedDbOpens.length) throw new Error(`production IndexedDB opened: ${spies.counts.productionIndexedDbOpens.join(", ")}`);
      if (spies.counts.productionMemoryWrites !== 0) throw new Error(`production memory writes=${spies.counts.productionMemoryWrites}`);

      const beforeSecond = firstCounts;
      const second = await applyFloatMigrationPackage(bytes, { storage });
      if (!("journal" in second) || !second.ok) throw new Error(`second apply failed: ${JSON.stringify(second)}`);
      closeForReopen(storage);
      storage = new IsolatedBrowserNativeMigrationStorage(namespace);
      const secondSnapshot = await storage.readSnapshot(second.dryRun.plan);
      const secondCounts = snapshotCounts(secondSnapshot);
      const duplicateDelta = Object.fromEntries(Object.keys(beforeSecond).map((key) => [key, secondCounts[key] - beforeSecond[key]]));
      if (Object.values(duplicateDelta).some((value) => value !== 0)) throw new Error(`duplicate delta ${JSON.stringify(duplicateDelta)}`);
      if (second.dryRun.reconciliation.totals.create !== 0 || second.expectedVsActual.actualCreates !== 0) {
        throw new Error(`second apply created records ${JSON.stringify(second.expectedVsActual)}`);
      }

      const conflictSetup = await dryRunFloatMigrationPackage(bytes, { storage: conflictStorage });
      if (!conflictSetup.ok) throw new Error(`conflict setup failed: ${conflictSetup.errors.join(" | ")}`);
      const target = conflictSetup.dryRun.plan.characters[0].value;
      const conflictingCharacter = { ...target, name: `${target.name} [preexisting edit]` };
      await conflictStorage.seedForIntegration({ characters: [conflictingCharacter] });
      const conflict = await dryRunFloatMigrationPackage(bytes, { storage: conflictStorage });
      if (!conflict.ok) throw new Error(`conflict test failed: ${conflict.errors.join(" | ")}`);
      if (conflict.dryRun.reconciliation.characters.conflicts.length !== 1) throw new Error("expected one stable-id character conflict");
      const conflictSnapshot = await conflictStorage.readSnapshot(conflict.dryRun.plan);
      if (conflictSnapshot.characters.find((entry) => entry.id === target.id)?.name !== conflictingCharacter.name) {
        throw new Error("conflict test overwrote pre-existing record");
      }

      const rollback = await rollbackFloatMigrationRun(first.journal.runId, storage);
      if (!rollback.ok || rollback.journal?.status !== "rolled_back") throw new Error(`rollback failed ${JSON.stringify(rollback)}`);
      closeForReopen(storage);
      storage = new IsolatedBrowserNativeMigrationStorage(namespace);
      const rollbackSnapshot = await storage.readSnapshot(first.dryRun.plan);
      const rolledJournal = await storage.readJournal(first.journal.runId);
      const baselinePreserved = rollbackSnapshot.identities.some((entry) => entry.id === BASELINE_IDENTITY.id);
      const residual = residualImportedRecords(rollbackSnapshot);
      if (!baselinePreserved) throw new Error("rollback removed pre-existing Float identity");
      if (residual !== 0) throw new Error(`rollback residual imported records=${residual}`);
      if (rolledJournal?.status !== "rolled_back") throw new Error(`journal after reopen=${rolledJournal?.status ?? "missing"}`);

      const firstActualCreate = countCreated(first.journal.created as Record<string, string[] | undefined>);
      const secondActualCreate = countCreated(second.journal.created as Record<string, string[] | undefined>);
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
          roles,
          richTypes,
          mediaRefCount: mediaRefs.length,
          nondeterministicMediaRefs: badMediaRefs.length,
          timestampMismatches,
          orderMismatches,
          timelineRecords: first.dryRun.plan.timelineRecords.length,
        },
        sideEffects: {
          cognitiveExtractionCalls: spies.counts.productionMemoryWrites,
          futureIntentDetectorLivePathCalls: spies.counts.liveChatPushEvents,
          pushChatMessageLivePathCalls: spies.counts.liveChatPushEvents,
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
          conflicts: conflict.dryRun.reconciliation.characters.conflicts.length,
          originalPreserved: true,
          preexistingId: target.id,
        },
        rollback: {
          ok: rollback.ok,
          journalStatus: rolledJournal?.status,
          baselineIdentityPreserved: baselinePreserved,
          removed: firstActualCreate,
          residualImportedRecords: residual,
          remainingSnapshot: snapshotCounts(rollbackSnapshot),
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
      <p>Client-only isolated IndexedDB harness. The selected package is never uploaded.</p>
      <input id="migration-package" type="file" accept=".zip,.float-migration.zip" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
      <button id="run-validation" type="button" disabled={!file || running} onClick={() => void run()} style={{ marginLeft: 12 }}>
        {running ? "Running…" : "Run isolated validation"}
      </button>
      {error ? <pre id="validation-error" style={{ whiteSpace: "pre-wrap", color: "crimson" }}>{error}</pre> : null}
      {result ? <pre id="validation-result" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(result, null, 2)}</pre> : null}
    </main>
  );
}
