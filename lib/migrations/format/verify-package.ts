import type { FloatMigrationManifest, MigrationAssetRef } from "./types";
import { validateFloatMigrationManifest } from "./validate-package";

interface ZipEntryLike { dir?: boolean; async(type: "string"): Promise<string> }
interface ZipLike { files: Record<string, ZipEntryLike>; file(path: string): ZipEntryLike | null }
type ZipLoader = (input: ArrayBuffer | Uint8Array) => Promise<ZipLike>;

async function defaultZipLoader(input: ArrayBuffer | Uint8Array): Promise<ZipLike> {
  const module = await import("jszip");
  return module.default.loadAsync(input) as unknown as ZipLike;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJson(zip: ZipLike, path: string, errors: string[]): Promise<unknown> {
  const entry = zip.file(path);
  if (!entry) { errors.push(`required package file is missing: ${path}`); return undefined; }
  try { return JSON.parse(await entry.async("string")); }
  catch { errors.push(`package file is not valid JSON: ${path}`); return undefined; }
}

const SECRET_FIELD_NAMES = new Set([
  "apikey", "accesstoken", "refreshtoken", "authtoken", "password", "passwd", "cookie", "cookies",
  "masterkey", "clientsecret", "apisecret", "authorization", "bearertoken", "privatekey", "vapidprivatekey",
  "secretkey", "token", "secret",
]);

function secretFieldPaths(value: unknown, path: string): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => secretFieldPaths(entry, `${path}[${index}]`));
  if (!isRecord(value)) return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const childPath = `${path}.${key}`;
    if (SECRET_FIELD_NAMES.has(normalized)) found.push(childPath);
    found.push(...secretFieldPaths(child, childPath));
  }
  return found;
}

const REQUIRED_JSON_FILES = [
  "manifest.json",
  "data/identities.json",
  "data/characters.json",
  "data/relationships.json",
  "data/chats.json",
  "data/moments.json",
  "data/diaries.json",
  "data/worlds.json",
  "data/worldbooks.json",
  "data/stories.json",
  "data/games.json",
  "data/schedules.json",
  "data/event-boxes.json",
  "data/memories.json",
  "data/future-intents.json",
  "data/memory-links.json",
  "data/extended.json",
  "compat/stores.json",
  "provenance/id-map.json",
  "provenance/normalization-report.json",
  "provenance/source-manifest.json",
  "assets/index.json",
] as const;

export interface FloatMigrationPackageVerification {
  ok: boolean;
  manifest?: FloatMigrationManifest;
  errors: string[];
  warnings: string[];
  observedCounts: Record<string, number>;
  missingAssetPaths: string[];
  orphanReferences: string[];
}

export async function verifyFloatMigrationPackage(
  input: ArrayBuffer | Uint8Array,
  options: { zipLoader?: ZipLoader } = {},
): Promise<FloatMigrationPackageVerification> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const missingAssetPaths: string[] = [];
  const orphanReferences: string[] = [];
  const observedCounts: Record<string, number> = {};

  try {
    const zip = await (options.zipLoader ?? defaultZipLoader)(input);
    for (const path of REQUIRED_JSON_FILES) if (!zip.file(path)) errors.push(`required package file is missing: ${path}`);
    if (errors.length) return { ok:false, errors, warnings, observedCounts, missingAssetPaths, orphanReferences };

    const manifestRaw = await readJson(zip, "manifest.json", errors);
    const validation = validateFloatMigrationManifest(manifestRaw);
    errors.push(...validation.errors);
    const manifest = validation.valid ? manifestRaw as FloatMigrationManifest : undefined;

    const arrays: Record<string, unknown> = {
      identities: await readJson(zip, "data/identities.json", errors),
      characters: await readJson(zip, "data/characters.json", errors),
      relationships: await readJson(zip, "data/relationships.json", errors),
      moments: await readJson(zip, "data/moments.json", errors),
      diaries: await readJson(zip, "data/diaries.json", errors),
      worlds: await readJson(zip, "data/worlds.json", errors),
      worldbooks: await readJson(zip, "data/worldbooks.json", errors),
      stories: await readJson(zip, "data/stories.json", errors),
      games: await readJson(zip, "data/games.json", errors),
      schedules: await readJson(zip, "data/schedules.json", errors),
      eventBoxes: await readJson(zip, "data/event-boxes.json", errors),
      memories: await readJson(zip, "data/memories.json", errors),
      futureIntents: await readJson(zip, "data/future-intents.json", errors),
      memoryLinks: await readJson(zip, "data/memory-links.json", errors),
    };
    const chats = await readJson(zip, "data/chats.json", errors);
    const extended = await readJson(zip, "data/extended.json", errors);
    const compat = await readJson(zip, "compat/stores.json", errors);
    const assetIndex = await readJson(zip, "assets/index.json", errors);

    for (const [name, value] of Object.entries(arrays)) {
      if (!Array.isArray(value)) errors.push(`${name} package data must be an array`);
      else observedCounts[name] = value.length;
    }
    if (!isRecord(chats) || !Array.isArray(chats.conversations) || !Array.isArray(chats.messages)) {
      errors.push("data/chats.json must contain conversations[] and messages[]");
    } else {
      observedCounts.conversations = chats.conversations.length;
      observedCounts.messages = chats.messages.length;
    }
    if (!Array.isArray(compat)) errors.push("compat/stores.json must be an array");
    else observedCounts.compatStores = compat.length;
    if (!Array.isArray(assetIndex)) errors.push("assets/index.json must be an array");
    else observedCounts.assets = assetIndex.filter((entry) => isRecord(entry) && !entry.missing).length;

    if (manifest) {
      for (const [name, expected] of Object.entries(manifest.counts)) {
        if (observedCounts[name] !== undefined && observedCounts[name] !== expected) {
          errors.push(`manifest count mismatch for ${name}: expected ${expected}, observed ${observedCounts[name]}`);
        }
      }
      if (observedCounts.assets !== undefined && observedCounts.assets !== manifest.assets.count) {
        errors.push(`manifest asset count mismatch: expected ${manifest.assets.count}, observed ${observedCounts.assets}`);
      }
    }

    const migrationIds = (value: unknown): Set<string> => new Set(Array.isArray(value) ? value.filter(isRecord).map((entry) => typeof entry.migrationId === "string" ? entry.migrationId : "").filter(Boolean) : []);
    const characterIds = migrationIds(arrays.characters);
    const conversationIds = isRecord(chats) ? migrationIds(chats.conversations) : new Set<string>();
    const messageIds = isRecord(chats) ? migrationIds(chats.messages) : new Set<string>();
    const memoryIds = migrationIds(arrays.memories);
    const eventBoxIds = migrationIds(arrays.eventBoxes);

    if (isRecord(chats) && Array.isArray(chats.messages)) for (const message of chats.messages) {
      if (!isRecord(message)) continue;
      if (typeof message.characterRef === "string" && !characterIds.has(message.characterRef)) orphanReferences.push(`message ${String(message.migrationId)} characterRef ${message.characterRef}`);
      if (typeof message.conversationRef === "string" && !conversationIds.has(message.conversationRef)) orphanReferences.push(`message ${String(message.migrationId)} conversationRef ${message.conversationRef}`);
      if (typeof message.replyTo === "string" && !messageIds.has(message.replyTo)) orphanReferences.push(`message ${String(message.migrationId)} replyTo ${message.replyTo}`);
    }
    if (Array.isArray(arrays.memories)) for (const memory of arrays.memories) {
      if (!isRecord(memory)) continue;
      if (typeof memory.characterRef === "string" && !characterIds.has(memory.characterRef)) orphanReferences.push(`memory ${String(memory.migrationId)} characterRef ${memory.characterRef}`);
      if (typeof memory.eventBoxRef === "string" && !eventBoxIds.has(memory.eventBoxRef)) orphanReferences.push(`memory ${String(memory.migrationId)} eventBoxRef ${memory.eventBoxRef}`);
    }
    if (Array.isArray(arrays.memoryLinks)) for (const link of arrays.memoryLinks) {
      if (!isRecord(link)) continue;
      if (typeof link.fromMemoryRef !== "string" || !memoryIds.has(link.fromMemoryRef)) orphanReferences.push(`memory link ${String(link.migrationId)} fromMemoryRef ${String(link.fromMemoryRef)}`);
      if (typeof link.toMemoryRef !== "string" || !memoryIds.has(link.toMemoryRef)) orphanReferences.push(`memory link ${String(link.migrationId)} toMemoryRef ${String(link.toMemoryRef)}`);
    }
    if (Array.isArray(arrays.futureIntents)) for (const intent of arrays.futureIntents) {
      if (!isRecord(intent)) continue;
      if (typeof intent.sourceMemoryRef === "string" && !memoryIds.has(intent.sourceMemoryRef)) orphanReferences.push(`future intent ${String(intent.migrationId)} sourceMemoryRef ${intent.sourceMemoryRef}`);
    }
    if (Array.isArray(arrays.eventBoxes)) for (const box of arrays.eventBoxes) {
      if (!isRecord(box)) continue;
      for (const field of ["liveMemoryRefs", "archiveMemoryRefs"] as const) {
        if (!Array.isArray(box[field])) continue;
        for (const ref of box[field] as unknown[]) if (typeof ref === "string" && !memoryIds.has(ref)) orphanReferences.push(`event box ${String(box.migrationId)} ${field} ${ref}`);
      }
    }

    if (Array.isArray(assetIndex)) for (const raw of assetIndex) {
      if (!isRecord(raw)) continue;
      const asset = raw as unknown as MigrationAssetRef;
      if (asset.missing) continue;
      if (!asset.packagePath || !zip.file(asset.packagePath)) missingAssetPaths.push(asset.packagePath ?? `(asset ${asset.assetId} has no packagePath)`);
    }

    if (Array.isArray(compat)) for (const entry of compat) {
      if (!isRecord(entry)) continue;
      if (["apiPresets", "vrSettings", "assets"].includes(String(entry.store))) errors.push(`forbidden sensitive/runtime compat store included: ${String(entry.store)}`);
    }

    const secretScanTargets: Array<[string, unknown]> = [["chats", chats], ["extended", extended], ["compat", compat], ...Object.entries(arrays)];
    const secretPaths = secretScanTargets.flatMap(([name, value]) => secretFieldPaths(value, name));
    if (secretPaths.length) errors.push(`secret-like fields found in migration payload: ${secretPaths.slice(0, 8).join(", ")}${secretPaths.length > 8 ? "…" : ""}`);

    if (orphanReferences.length) errors.push(`${orphanReferences.length} orphan migration references detected`);
    if (missingAssetPaths.length) errors.push(`${missingAssetPaths.length} packaged asset paths are missing`);
    return { ok: errors.length === 0, manifest, errors, warnings, observedCounts, missingAssetPaths, orphanReferences };
  } catch (error) {
    errors.push(`unable to verify migration package: ${error instanceof Error ? error.message : "unknown error"}`);
    return { ok:false, errors, warnings, observedCounts, missingAssetPaths, orphanReferences };
  }
}
