"use client";

import { useRef, useState } from "react";
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

type ValidationStageStatus = "running" | "completed" | "failed" | "timed_out";

type ValidationStageEntry = {
  stage: string;
  status: ValidationStageStatus;
  elapsedMs: number;
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
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  const [lastCompletedStage, setLastCompletedStage] = useState<string | null>(null);
  const lastCompletedStageRef = useRef<string | null>(null);
  const [stageEntries, setStageEntries] = useState<ValidationStageEntry[]>([]);

  async function runStage<T>(stage: string, timeoutMs: number, action: () => Promise<T>): Promise<T> {
    const startedAt = performance.now();
    let timedOut = false;
    setCurrentStage(stage);
    setStageEntries((entries) => [...entries, { stage, status: "running", elapsedMs: 0 }]);

    const update = (status: ValidationStageStatus) => {
      const elapsedMs = Math.round(performance.now() - startedAt);
      setStageEntries((entries) => entries.map((entry, index) =>
        index === entries.length - 1 ? { stage, status, elapsedMs } : entry
      ));
      return elapsedMs;
    };

    const intervalId = window.setInterval(() => update("running"), 1000);
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      const elapsedMs = update("timed_out");
      setError(`validation timeout at stage "${stage}" after ${elapsedMs}ms; last completed stage: ${lastCompletedStageRef.current ?? "none"}`);
    }, timeoutMs);

    try {
      const value = await action();
      if (timedOut) {
        throw new Error(`validation timeout at stage "${stage}"; last completed stage: ${lastCompletedStage ?? "none"}`);
      }
      update("completed");
      lastCompletedStageRef.current = stage;
      setLastCompletedStage(stage);
      return value;
    } catch (cause) {
      if (!timedOut) update("failed");
      throw cause;
    } finally {
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
    }
  }

  async function run(): Promise<void> {
    if (!file) return;
    setRunning(true);
    setResult(null);
    setError("");
    setCurrentStage(null);
    lastCompletedStageRef.current = null;
    setLastCompletedStage(null);
    setStageEntries([]);

    const namespace = `real_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const conflictNamespace = `${namespace}_conflict`;
    let storage = new IsolatedBrowserNativeMigrationStorage(namespace);
    const conflictStorage = new IsolatedBrowserNativeMigrationStorage(conflictNamespace);

    try {
      const bytes = await runStage("read package", 120_000, async () =>
        new Uint8Array(await file.arrayBuffer())
      );

      const dry = await runStage("dry-run", 300_000, async () => {
        await storage.seedForIntegration({ identities: [BASELINE_IDENTITY] });
        const value = await dryRunFloatMigrationPackage(bytes, { storage });
        if (!value.ok) throw new Error(`dry-run failed: ${value.errors.join(" | ")}`);
        assertRealPackage(value.dryRun.plan);
        return value;
      });

      const spies = installSideEffectSpies(namespace);
      const first = await runStage("first apply", 600_000, async () => {
        try {
          const value = await applyFloatMigrationPackage(bytes, { storage });
          if (!("journal" in value) || !value.ok) throw new Error(`first apply failed: ${JSON.stringify(value)}`);
          return value;
        } finally {
          spies.restore();
        }
      });

      await runStage("close/reopen", 30_000, async () => {
        closeForReopen(storage);
        storage = new IsolatedBrowserNativeMigrationStorage(namespace);
      });

      const firstSnapshot = await runStage("first reread", 180_000, async () =>
        storage.readSnapshot(first.dryRun.plan)
      );
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
      const plannedMediaRefs = new Set(first.dryRun.plan.media.map((entry) => entry.targetRef));
      const badMediaRefs = mediaRefs.filter((ref) => !plannedMediaRefs.has(ref));
      if (badMediaRefs.length) throw new Error(`non-deterministic media refs: ${badMediaRefs.slice(0, 3).join(", ")}`);

      if (spies.counts.liveChatPushEvents !== 0) throw new Error(`live chat path fired ${spies.counts.liveChatPushEvents} times`);
      if (spies.counts.autonomousReplyEvents !== 0) throw new Error(`autonomous reply fired ${spies.counts.autonomousReplyEvents} times`);
      if (spies.counts.notificationCalls !== 0) throw new Error(`notifications fired ${spies.counts.notificationCalls} times`);
      if (spies.counts.externalFetchCalls !== 0 || spies.counts.externalXhrCalls !== 0) throw new Error(`external API activity fetch=${spies.counts.externalFetchCalls} xhr=${spies.counts.externalXhrCalls}`);
      if (spies.counts.productionIndexedDbOpens.length) throw new Error(`production IndexedDB opened: ${spies.counts.productionIndexedDbOpens.join(", ")}`);
      if (spies.counts.productionMemoryWrites !== 0) throw new Error(`production memory writes=${spies.counts.productionMemoryWrites}`);

      const beforeSecond = firstCounts;
      const second = await runStage("second apply", 600_000, async () => {
        const value = await applyFloatMigrationPackage(bytes, { storage });
        if (!("journal" in value) || !value.ok) throw new Error(`second apply failed: ${JSON.stringify(value)}`);
        return value;
      });

      const secondSnapshot = await runStage("second reread", 180_000, async () => {
        closeForReopen(storage);
        storage = new IsolatedBrowserNativeMigrationStorage(namespace);
        return storage.readSnapshot(second.dryRun.plan);
      });
      const secondCounts = snapshotCounts(secondSnapshot);
      const duplicateDelta = Object.fromEntries(Object.keys(beforeSecond).map((key) => [key, secondCounts[key] - beforeSecond[key]]));
      if (Object.values(duplicateDelta).some((value) => value !== 0)) throw new Error(`duplicate delta ${JSON.stringify(duplicateDelta)}`);
      if (second.dryRun.reconciliation.totals.create !== 0 || second.expectedVsActual.actualCreates !== 0) {
        throw new Error(`second apply created records ${JSON.stringify(second.expectedVsActual)}`);
      }

      const conflict = await runStage("conflict", 300_000, async () => {
        const setup = await dryRunFloatMigrationPackage(bytes, { storage: conflictStorage });
        if (!setup.ok) throw new Error(`conflict setup failed: ${setup.errors.join(" | ")}`);
        const target = setup.dryRun.plan.characters[0].value;
        const conflictingCharacter = { ...target, name: `${target.name} [preexisting edit]` };
        await conflictStorage.seedForIntegration({ characters: [conflictingCharacter] });
        const value = await dryRunFloatMigrationPackage(bytes, { storage: conflictStorage });
        if (!value.ok) throw new Error(`conflict test failed: ${value.errors.join(" | ")}`);
        if (value.dryRun.reconciliation.characters.conflicts.length !== 1) throw new Error("expected one stable-id character conflict");
        const snapshot = await conflictStorage.readSnapshot(value.dryRun.plan);
        if (snapshot.characters.find((entry) => entry.id === target.id)?.name !== conflictingCharacter.name) {
          throw new Error("conflict test overwrote pre-existing record");
        }
        return { value, target };
      });

      const rollback = await runStage("rollback", 300_000, async () => {
        const value = await rollbackFloatMigrationRun(first.journal.runId, storage);
        if (!value.ok || value.journal?.status !== "rolled_back") throw new Error(`rollback failed ${JSON.stringify(value)}`);
        return value;
      });

      await runStage("reopen", 30_000, async () => {
        closeForReopen(storage);
        storage = new IsolatedBrowserNativeMigrationStorage(namespace);
      });

      const final = await runStage("final reread", 180_000, async () => {
        const snapshot = await storage.readSnapshot(first.dryRun.plan);
        const journal = await storage.readJournal(first.journal.runId);
        const baselinePreserved = snapshot.identities.some((entry) => entry.id === BASELINE_IDENTITY.id);
        const residual = residualImportedRecords(snapshot);
        if (!baselinePreserved) throw new Error("rollback removed pre-existing Float identity");
        if (residual !== 0) throw new Error(`rollback residual imported records=${residual}`);
        if (journal?.status !== "rolled_back") throw new Error(`journal after reopen=${journal?.status ?? "missing"}`);
        return { snapshot, journal, baselinePreserved, residual };
      });

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
          counts: firstCounts, roles, richTypes, mediaRefCount: mediaRefs.length,
          nondeterministicMediaRefs: badMediaRefs.length, timestampMismatches, orderMismatches,
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
          conflicts: conflict.value.dryRun.reconciliation.characters.conflicts.length,
          originalPreserved: true,
          preexistingId: conflict.target.id,
        },
        rollback: {
          ok: rollback.ok,
          journalStatus: final.journal?.status,
          baselineIdentityPreserved: final.baselinePreserved,
          removed: firstActualCreate,
          residualImportedRecords: final.residual,
          remainingSnapshot: snapshotCounts(final.snapshot),
        },
      });
    } catch (cause) {
      setError((existing) => existing || (cause instanceof Error ? cause.stack || cause.message : String(cause)));
    } finally {
      setRunning(false);
      setCurrentStage(null);
      void Promise.allSettled([storage.dispose?.(), conflictStorage.dispose?.()]);
    }
  }

  return (
    <main style={{ padding: 24, fontFamily: "monospace", maxWidth: 1100, margin: "0 auto" }}>
      <h1>Migration Completion Validation</h1>
      <p>Client-only isolated IndexedDB harness. The selected package is never uploaded.</p>
      <p id="validation-stage">Last completed: {lastCompletedStage ?? "none"} · Current: {currentStage ?? "none"}</p>
      <pre id="validation-stage-timings" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(stageEntries, null, 2)}</pre>
      <input id="migration-package" type="file" accept=".zip,.float-migration.zip" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
      <button id="run-validation" type="button" disabled={!file || running} onClick={() => void run()} style={{ marginLeft: 12 }}>
        {running ? "Running…" : "Run isolated validation"}
      </button>
      {error ? <pre id="validation-error" style={{ whiteSpace: "pre-wrap", color: "crimson" }}>{error}</pre> : null}
      {result ? <pre id="validation-result" style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(result, null, 2)}</pre> : null}
    </main>
  );
}
