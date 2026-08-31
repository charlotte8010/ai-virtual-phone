import type { MigrationSourceRef } from "../format/types";

export interface MigrationCompatRecord {
  migrationId: string;
  category: string;
  source: MigrationSourceRef;
  payload: unknown;
  notes?: string[];
}

export interface MigrationCompatCollection {
  records: MigrationCompatRecord[];
  warnings: string[];
}
