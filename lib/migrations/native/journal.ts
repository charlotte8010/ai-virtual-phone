import { kvGet, kvSetAsync } from "../../kv-db";
import type { MigrationRunJournal } from "./types";

const JOURNAL_KEY = "ai_phone_migration_journal_v1";

function parseJournals(raw: string | null): MigrationRunJournal[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as MigrationRunJournal[] : [];
  } catch {
    return [];
  }
}

export function loadMigrationJournals(): MigrationRunJournal[] {
  return parseJournals(kvGet(JOURNAL_KEY));
}

export async function saveMigrationJournal(journal: MigrationRunJournal): Promise<void> {
  const all = loadMigrationJournals();
  const index = all.findIndex((entry) => entry.runId === journal.runId);
  if (index >= 0) all[index] = journal;
  else all.push(journal);
  await kvSetAsync(JOURNAL_KEY, JSON.stringify(all));
}

export function createMigrationRunJournal(packageId: string, sourceFingerprint: string): MigrationRunJournal {
  const now = new Date().toISOString();
  const entropy = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return {
    runId: `migration_run_${entropy}`,
    packageId,
    sourceFingerprint,
    status: "planned",
    startedAt: now,
    created: {},
    reused: {},
    skipped: {},
    conflicts: {},
    warnings: [],
    failures: [],
  };
}

export async function markMigrationJournalRolledBack(runId: string): Promise<MigrationRunJournal | null> {
  const journal = loadMigrationJournals().find((entry) => entry.runId === runId);
  if (!journal) return null;
  journal.status = "rolled_back";
  journal.rolledBackAt = new Date().toISOString();
  await saveMigrationJournal(journal);
  return journal;
}
