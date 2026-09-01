import assert from "node:assert/strict";
import JSZip from "jszip";
import { compileMigrationModules } from "./migration-ts-loader.mjs";

const runtime = await compileMigrationModules();
try {
  const { writeFloatMigrationPackage } = runtime.requireModule("format/package-writer.js");
  const { readFloatMigrationPackage } = runtime.requireModule("format/read-package.js");
  const { dryRunFloatMigrationPackage } = runtime.requireModule("native/importer.js");

  const fingerprint = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
  const createdAt = "2026-09-01T00:00:00.000Z";
  const source = (store, originalId) => ({ platform: "sully", backupFormat: "sully_v3", backupFormatVersion: 3, backupFingerprint: fingerprint, store, originalId });
  const character = { migrationId: "char-1", kind: "character", displayName: "Character", persona: "Persona", source: source("characters", "c1"), metadata: {} };
  const conversation = { migrationId: "conv-1", characterRef: "char-1", source: source("messages", "c1") };
  const asset = { assetId: "asset-1", packagePath: "assets/files/asset-1.bin", mediaType: "image/png", byteLength: 3, source: source("assets", "a1") };
  const message = { migrationId: "msg-1", sourceOriginalId: "m1", characterRef: "char-1", conversationRef: "conv-1", role: "assistant", content: "正文必须保留", messageType: "image", media: [asset], createdAt: "2026-08-20T12:00:00.000Z", source: source("messages", "m1"), sourceMetadata: {} };
  const payload = {
    identities: [], characters: [character], relationships: [], conversations: [conversation], messages: [message], moments: [], diaries: [], worlds: [], worldbooks: [], stories: [], games: [], schedules: [], eventBoxes: [], memories: [], futureIntents: [], memoryLinks: [], extended: {}, compat: [],
    provenance: { idMap: { characters: { c1: "char-1" } }, normalizationReport: { redactions: { count: 0, paths: [] }, stores: {} }, sourceManifest: {}, metadataRedactions: [], excludedSensitiveStores: {}, excludedRuntimeStores: {} },
  };
  const counts = { identities: 0, characters: 1, relationships: 0, conversations: 1, messages: 1, moments: 0, diaries: 0, worlds: 0, worldbooks: 0, stories: 0, games: 0, schedules: 0, eventBoxes: 0, memories: 0, futureIntents: 0, memoryLinks: 0, compatStores: 0 };
  const manifest = { format: "float_migration", formatVersion: 1, packageId: "pkg-negative-reader", source: { platform: "sully", format: "sully_v3", formatVersion: 3, backupFingerprint: fingerprint }, createdAt, counts, assets: { count: 1, totalBytes: 3 }, skippedByPolicy: {}, warnings: [] };
  const validBytes = await writeFloatMigrationPackage({ manifest, payload, binaryAssets: [{ ref: asset, bytes: new Uint8Array([1, 2, 3]) }] });

  async function mutate(bytes, fn) {
    const zip = await JSZip.loadAsync(bytes);
    await fn(zip);
    return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
  }
  async function expectDiagnostic(bytes, pattern, options) {
    const result = await readFloatMigrationPackage(bytes, options);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((entry) => pattern.test(entry)), `expected ${pattern} in ${JSON.stringify(result.errors)}`);
  }

  await expectDiagnostic(await mutate(validBytes, zip => zip.remove("manifest.json")), /manifest\.json is missing|required package file is missing: manifest\.json/);
  await expectDiagnostic(await mutate(validBytes, zip => zip.file("manifest.json", "{")), /manifest\.json is not valid JSON|package file is not valid JSON: manifest\.json/);
  await expectDiagnostic(await mutate(validBytes, zip => zip.remove("data/memories.json")), /required package file is missing: data\/memories\.json/);
  await expectDiagnostic(await mutate(validBytes, zip => zip.file("data/memories.json", "{")), /package file is not valid JSON: data\/memories\.json/);

  const missingAssetBytes = await writeFloatMigrationPackage({ manifest, payload, binaryAssets: [{ ref: asset }] });
  await expectDiagnostic(missingAssetBytes, /packaged asset paths are missing|asset paths are missing/);

  const unsafeLoader = async (input) => {
    const zip = await JSZip.loadAsync(input);
    const fakeUnsafe = { dir: false, async: async (type) => type === "uint8array" ? new Uint8Array() : "" };
    return {
      files: { ...zip.files, "../escape.txt": fakeUnsafe },
      file(path) { return zip.file(path); },
    };
  };
  await expectDiagnostic(validBytes, /unsafe paths/, { zipLoader: unsafeLoader });

  const wrongFormat = await mutate(validBytes, async zip => {
    const raw = JSON.parse(await zip.file("manifest.json").async("string"));
    raw.format = "not_float_migration";
    zip.file("manifest.json", JSON.stringify(raw));
  });
  await expectDiagnostic(wrongFormat, /format/);
  const wrongVersion = await mutate(validBytes, async zip => {
    const raw = JSON.parse(await zip.file("manifest.json").async("string"));
    raw.formatVersion = 99;
    zip.file("manifest.json", JSON.stringify(raw));
  });
  await expectDiagnostic(wrongVersion, /formatVersion|version/);

  // A source backup may already declare an asset missing. This is not a corrupt package:
  // the text record must remain importable while the media ref stays unresolved.
  const declaredMissingAsset = { ...asset, missing: true, packagePath: undefined, byteLength: undefined };
  const missingMediaMessage = { ...message, media: [declaredMissingAsset] };
  const missingMediaPayload = { ...payload, messages: [missingMediaMessage] };
  const missingMediaManifest = { ...manifest, assets: { count: 0, totalBytes: 0 } };
  const declaredMissingBytes = await writeFloatMigrationPackage({ manifest: missingMediaManifest, payload: missingMediaPayload, binaryAssets: [{ ref: declaredMissingAsset }] });
  const fakeStorage = {
    kind: "isolated-browser",
    async readSnapshot() { return { identities: [], characters: [], contacts: [], sessions: [], messages: [], mediaIds: [], moments: [], momentComments: [], diaries: [], worlds: [], worldbooks: [], calendar: [], memories: [] }; },
    async applyCreates() { throw new Error("not used"); }, async rollbackCreated() { throw new Error("not used"); }, async saveJournal() {}, async readJournal() { return null; },
  };
  const dry = await dryRunFloatMigrationPackage(declaredMissingBytes, { storage: fakeStorage });
  assert.equal(dry.ok, true);
  assert.equal(dry.dryRun.plan.messages.length, 1);
  assert.equal(dry.dryRun.plan.messages[0].content, "正文必须保留");
  assert.equal(dry.dryRun.plan.messages[0].mediaUrl, undefined);
  assert.equal(dry.dryRun.plan.media.length, 0);

  console.log("migration package reader negative tests passed");
} finally {
  await runtime.cleanup();
}
