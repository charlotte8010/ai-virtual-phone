import type {
  FloatMigrationManifest,
  FloatMigrationPackagePayload,
  MigrationAssetRef,
} from "./types";
import { scanFloatMigrationPackage } from "./package-reader";
import { verifyFloatMigrationPackage, type FloatMigrationPackageVerification } from "./verify-package";

export interface MigrationZipEntryLike {
  dir?: boolean;
  async(type: "string"): Promise<string>;
  async(type: "uint8array"): Promise<Uint8Array>;
}
export interface MigrationZipLike {
  files: Record<string, MigrationZipEntryLike>;
  file(path: string): MigrationZipEntryLike | null;
}
export type MigrationZipLoader = (input: ArrayBuffer | Uint8Array) => Promise<MigrationZipLike>;

async function defaultZipLoader(input: ArrayBuffer | Uint8Array): Promise<MigrationZipLike> {
  const module = await import("jszip");
  const JSZip = (module as { default?: { loadAsync(value: ArrayBuffer | Uint8Array): Promise<unknown> }; loadAsync?: (value: ArrayBuffer | Uint8Array) => Promise<unknown> }).default ?? module;
  return (JSZip as { loadAsync(value: ArrayBuffer | Uint8Array): Promise<unknown> }).loadAsync(input) as Promise<MigrationZipLike>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJson(zip: MigrationZipLike, path: string, errors: string[]): Promise<unknown> {
  const entry = zip.file(path);
  if (!entry) {
    errors.push(`required package file is missing: ${path}`);
    return undefined;
  }
  try {
    return JSON.parse(await entry.async("string"));
  } catch {
    errors.push(`package file is not valid JSON: ${path}`);
    return undefined;
  }
}

function arrayValue<T>(value: unknown, path: string, errors: string[]): T[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  return value as T[];
}

function reconstructProvenance(
  idMap: unknown,
  normalizationReport: unknown,
  sourceManifest: unknown,
): FloatMigrationPackagePayload["provenance"] {
  const report = isRecord(normalizationReport) ? normalizationReport : {};
  const redactions = isRecord(report.redactions) && Array.isArray(report.redactions.paths)
    ? report.redactions.paths.filter((entry): entry is string => typeof entry === "string")
    : [];
  const excludedSensitiveStores: Record<string, number> = {};
  const stores = isRecord(report.stores) ? report.stores : {};
  for (const [name, raw] of Object.entries(stores)) {
    if (!isRecord(raw) || raw.classification !== "sensitive-config") continue;
    const count = typeof raw.parsedCount === "number" && Number.isFinite(raw.parsedCount) ? raw.parsedCount : 0;
    excludedSensitiveStores[name] = count;
  }
  const excludedRuntimeStores: Record<string, number> = {};
  if (isRecord(stores.assets) && typeof stores.assets.parsedCount === "number") excludedRuntimeStores.assets = stores.assets.parsedCount;
  return {
    idMap: isRecord(idMap) ? idMap as Record<string, Record<string, string>> : {},
    normalizationReport,
    sourceManifest,
    metadataRedactions: redactions,
    excludedSensitiveStores,
    excludedRuntimeStores,
  };
}

export interface ReadFloatMigrationPackageSuccess {
  ok: true;
  manifest: FloatMigrationManifest;
  payload: FloatMigrationPackagePayload;
  assets: MigrationAssetRef[];
  files: string[];
  warnings: string[];
  verification: FloatMigrationPackageVerification;
  getAssetBytes(asset: string | MigrationAssetRef): Promise<Uint8Array | null>;
}

export interface ReadFloatMigrationPackageFailure {
  ok: false;
  errors: string[];
  warnings: string[];
  files: string[];
  verification?: FloatMigrationPackageVerification;
}

export type ReadFloatMigrationPackageResult = ReadFloatMigrationPackageSuccess | ReadFloatMigrationPackageFailure;

export async function readFloatMigrationPackage(
  input: ArrayBuffer | Uint8Array,
  options: { zipLoader?: MigrationZipLoader } = {},
): Promise<ReadFloatMigrationPackageResult> {
  const zipLoader = options.zipLoader ?? defaultZipLoader;
  const scan = await scanFloatMigrationPackage(input, { zipLoader });
  if (!scan.ok || !scan.manifest) {
    return { ok: false, errors: scan.errors, warnings: scan.warnings, files: scan.files };
  }

  const verification = await verifyFloatMigrationPackage(input, { zipLoader });
  if (!verification.ok || !verification.manifest) {
    return {
      ok: false,
      errors: verification.errors,
      warnings: [...scan.warnings, ...verification.warnings],
      files: scan.files,
      verification,
    };
  }

  const errors: string[] = [];
  try {
    const zip = await zipLoader(input);
    const [
      identitiesRaw, charactersRaw, relationshipsRaw, chatsRaw, momentsRaw, diariesRaw,
      worldsRaw, worldbooksRaw, storiesRaw, gamesRaw, schedulesRaw, eventBoxesRaw,
      memoriesRaw, futureIntentsRaw, memoryLinksRaw, extendedRaw, compatRaw,
      idMapRaw, normalizationReport, sourceManifest, assetsRaw,
    ] = await Promise.all([
      readJson(zip, "data/identities.json", errors),
      readJson(zip, "data/characters.json", errors),
      readJson(zip, "data/relationships.json", errors),
      readJson(zip, "data/chats.json", errors),
      readJson(zip, "data/moments.json", errors),
      readJson(zip, "data/diaries.json", errors),
      readJson(zip, "data/worlds.json", errors),
      readJson(zip, "data/worldbooks.json", errors),
      readJson(zip, "data/stories.json", errors),
      readJson(zip, "data/games.json", errors),
      readJson(zip, "data/schedules.json", errors),
      readJson(zip, "data/event-boxes.json", errors),
      readJson(zip, "data/memories.json", errors),
      readJson(zip, "data/future-intents.json", errors),
      readJson(zip, "data/memory-links.json", errors),
      readJson(zip, "data/extended.json", errors),
      readJson(zip, "compat/stores.json", errors),
      readJson(zip, "provenance/id-map.json", errors),
      readJson(zip, "provenance/normalization-report.json", errors),
      readJson(zip, "provenance/source-manifest.json", errors),
      readJson(zip, "assets/index.json", errors),
    ]);

    const chats = isRecord(chatsRaw) ? chatsRaw : {};
    if (!isRecord(chatsRaw)) errors.push("data/chats.json must be an object");
    if (!isRecord(extendedRaw)) errors.push("data/extended.json must be an object");

    const assets = arrayValue<MigrationAssetRef>(assetsRaw, "assets/index.json", errors);
    const payload: FloatMigrationPackagePayload = {
      identities: arrayValue(identitiesRaw, "data/identities.json", errors),
      characters: arrayValue(charactersRaw, "data/characters.json", errors),
      relationships: arrayValue(relationshipsRaw, "data/relationships.json", errors),
      conversations: arrayValue(chats.conversations, "data/chats.json conversations", errors),
      messages: arrayValue(chats.messages, "data/chats.json messages", errors),
      moments: arrayValue(momentsRaw, "data/moments.json", errors),
      diaries: arrayValue(diariesRaw, "data/diaries.json", errors),
      worlds: arrayValue(worldsRaw, "data/worlds.json", errors),
      worldbooks: arrayValue(worldbooksRaw, "data/worldbooks.json", errors),
      stories: arrayValue(storiesRaw, "data/stories.json", errors),
      games: arrayValue(gamesRaw, "data/games.json", errors),
      schedules: arrayValue(schedulesRaw, "data/schedules.json", errors),
      eventBoxes: arrayValue(eventBoxesRaw, "data/event-boxes.json", errors),
      memories: arrayValue(memoriesRaw, "data/memories.json", errors),
      futureIntents: arrayValue(futureIntentsRaw, "data/future-intents.json", errors),
      memoryLinks: arrayValue(memoryLinksRaw, "data/memory-links.json", errors),
      extended: isRecord(extendedRaw) ? extendedRaw : {},
      compat: arrayValue(compatRaw, "compat/stores.json", errors),
      provenance: reconstructProvenance(idMapRaw, normalizationReport, sourceManifest),
    };

    if (errors.length) {
      return { ok: false, errors, warnings: [...scan.warnings, ...verification.warnings], files: scan.files, verification };
    }

    const assetById = new Map(assets.map((asset) => [asset.assetId, asset]));
    return {
      ok: true,
      manifest: verification.manifest,
      payload,
      assets,
      files: scan.files,
      warnings: [...scan.warnings, ...verification.warnings],
      verification,
      async getAssetBytes(assetOrId: string | MigrationAssetRef): Promise<Uint8Array | null> {
        const asset = typeof assetOrId === "string" ? assetById.get(assetOrId) : assetOrId;
        if (!asset || asset.missing || !asset.packagePath) return null;
        const entry = zip.file(asset.packagePath);
        if (!entry) return null;
        try { return await entry.async("uint8array"); }
        catch { return null; }
      },
    };
  } catch (error) {
    return {
      ok: false,
      errors: [`unable to read migration package payload: ${error instanceof Error ? error.message : "unknown error"}`],
      warnings: [...scan.warnings, ...verification.warnings],
      files: scan.files,
      verification,
    };
  }
}
