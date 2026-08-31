import type { FloatMigrationManifest, FloatMigrationPackagePayload, MigrationAssetRef } from "./types";

interface ZipBuilderLike {
  file(path: string, data: string | Uint8Array): ZipBuilderLike;
  generateAsync(options: { type: "uint8array"; compression: "DEFLATE"; compressionOptions: { level: number } }): Promise<Uint8Array>;
}

type ZipFactory = () => Promise<ZipBuilderLike>;

async function defaultZipFactory(): Promise<ZipBuilderLike> {
  const module = await import("jszip");
  const JSZip = (module as any).default ?? module;
  return new JSZip() as ZipBuilderLike;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

export interface MigrationPackageBinaryAsset {
  ref: MigrationAssetRef;
  bytes?: Uint8Array;
}

export interface WriteFloatMigrationPackageInput {
  manifest: FloatMigrationManifest;
  payload: FloatMigrationPackagePayload;
  binaryAssets: MigrationPackageBinaryAsset[];
  zipFactory?: ZipFactory;
}

export async function writeFloatMigrationPackage(input: WriteFloatMigrationPackageInput): Promise<Uint8Array> {
  const zip = await (input.zipFactory ?? defaultZipFactory)();
  zip.file("manifest.json", json(input.manifest));

  zip.file("data/identities.json", json(input.payload.identities));
  zip.file("data/characters.json", json(input.payload.characters));
  zip.file("data/relationships.json", json(input.payload.relationships));
  zip.file("data/chats.json", json({ conversations: input.payload.conversations, messages: input.payload.messages }));
  zip.file("data/moments.json", json(input.payload.moments));
  zip.file("data/diaries.json", json(input.payload.diaries));
  zip.file("data/worlds.json", json(input.payload.worlds));
  zip.file("data/worldbooks.json", json(input.payload.worldbooks));
  zip.file("data/stories.json", json(input.payload.stories));
  zip.file("data/games.json", json(input.payload.games));
  zip.file("data/schedules.json", json(input.payload.schedules));
  zip.file("data/event-boxes.json", json(input.payload.eventBoxes));
  zip.file("data/memories.json", json(input.payload.memories));
  zip.file("data/future-intents.json", json(input.payload.futureIntents));
  zip.file("data/memory-links.json", json(input.payload.memoryLinks));
  zip.file("data/extended.json", json(input.payload.extended));

  zip.file("compat/stores.json", json(input.payload.compat));
  zip.file("provenance/id-map.json", json(input.payload.provenance.idMap));
  zip.file("provenance/normalization-report.json", json(input.payload.provenance.normalizationReport));
  zip.file("provenance/source-manifest.json", json(input.payload.provenance.sourceManifest));
  zip.file("assets/index.json", json(input.binaryAssets.map((entry) => entry.ref)));

  for (const asset of input.binaryAssets) {
    if (!asset.ref.packagePath || !asset.bytes) continue;
    zip.file(asset.ref.packagePath, asset.bytes);
  }

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", compressionOptions: { level: 6 } });
}
