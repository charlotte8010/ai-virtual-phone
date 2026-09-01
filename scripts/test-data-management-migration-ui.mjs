import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../components/settings/data-management.tsx", import.meta.url), "utf8");

function functionBody(name, nextName) {
  const start = source.indexOf(`const ${name} =`);
  assert.notEqual(start, -1, `${name} should exist`);
  const end = nextName ? source.indexOf(`const ${nextName} =`, start) : source.length;
  return source.slice(start, end === -1 ? source.length : end);
}

const fileSelection = functionBody("handleMigrationFileSelected", "handleMigrationDryRun");
const dryRun = functionBody("handleMigrationDryRun", "handleMigrationApply");
const apply = functionBody("handleMigrationApply", "handlePersist");
const ordinarySelection = functionBody("handleFileSelected", "handleImport");
const ordinaryImport = functionBody("executeImport", "handlePersist");

assert.match(source, /dryRunFloatMigrationPackage/);
assert.match(source, /applyFloatMigrationPackage/);
assert.match(source, /ProductionNativeMigrationStorage/);
assert.doesNotMatch(fileSelection, /applyFloatMigrationPackage/);
assert.match(fileSelection, /setMigrationState/);
assert.match(dryRun, /arrayBuffer\(\)/);
assert.match(dryRun, /dryRunFloatMigrationPackage/);
assert.doesNotMatch(dryRun, /applyFloatMigrationPackage/);
assert.match(apply, /setConfirmRequest\(\{ type: "migration-apply" \}\)/);
assert.match(source, /type: "migration-apply"/);
assert.match(source, /确认 Apply/);
assert.match(source, /migrationState\.status === "dry-run-success"/);
assert.match(source, /reconciliation\.totals/);

for (const field of [
  "characters", "messages", "assets", "moments", "comments", "diary", "worldbooks",
  "activeMemories", "archivedMemories", "activeFutureIntents", "archivedWindowsill",
  "memoryLinks", "legacyCoreSummaries", "timelineRecords",
]) {
  assert.match(source, new RegExp(`"${field}"`), `dry-run summary should expose ${field}`);
}

for (const field of [
  "plannedCreates", "actualCreates", "reused", "skipped", "conflicts", "failed",
  "warnings", "remainingCreatesAfterApply", "runId",
]) {
  assert.match(source, new RegExp(field), `apply result should expose ${field}`);
}

assert.match(ordinarySelection, /readBackupManifest/);
assert.doesNotMatch(ordinarySelection, /dryRunFloatMigrationPackage|applyFloatMigrationPackage/);
assert.match(ordinaryImport, /importBackupBlob/);

console.log("data management migration UI regression tests passed");
