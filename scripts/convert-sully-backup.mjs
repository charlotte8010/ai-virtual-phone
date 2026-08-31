import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { compileMigrationModules } from "./migration-ts-loader.mjs";

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: node scripts/convert-sully-backup.mjs <Sully_Backup_full.zip> [output.float-migration.zip]");
  process.exit(2);
}

const runtime = await compileMigrationModules();
try {
  const { buildSullyV3MigrationPackage } = runtime.requireModule("sully-v3/convert-package.js");
  const sourceBytes = new Uint8Array(await readFile(inputPath));
  const built = await buildSullyV3MigrationPackage(sourceBytes);
  const outputPath = process.argv[3] ?? join(dirname(inputPath), built.fileName);
  await writeFile(outputPath, built.bytes);
  console.log(JSON.stringify({
    output: outputPath,
    packageId: built.manifest.packageId,
    sourceBackupFingerprint: built.manifest.source.backupFingerprint,
    counts: built.manifest.counts,
    assets: built.manifest.assets,
    skippedByPolicy: built.manifest.skippedByPolicy,
  }, null, 2));
} finally {
  await runtime.cleanup();
}
