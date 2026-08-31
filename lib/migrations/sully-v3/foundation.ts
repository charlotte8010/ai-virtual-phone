import type { SullyAssetDescriptor, SullyMigrationIdMap, SullyNormalizationReport, SullyStoreClassification, SullyStoreParseResult, SullyV3Manifest, SullyV3ParseResult } from "./types";

const OBSERVED_SULLY_V3_STORES = new Set([
  "apiPresets","availableModels","appearancePresets","roomCustomAssets","mediaAssets","collaborationSessions","collaborationMessages","collaborationCategories","collaborationAssetIndex","characters","characterGroups","messages","customThemes","savedEmojis","emojiCategories","assets","galleryImages","diaries","tasks","anniversaries","roomTodos","roomNotes","groups","savedJournalStickers","socialPosts","courses","games","worldbooks","storyTheaters","storyTheaterPresets","storyTheaterMasks","novels","songs","bankTransactions","xhsActivities","xhsStockImages","quizSessions","guidebookSessions","scheduledMessages","handbooks","trackers","trackerEntries","hotNewsSnapshots","memoryNodes","memoryLinks","topicBoxes","anticipations","eventBoxes","roomPlates","digestReports","dailySchedules","memoryBatches","pixelHomeAssets","pixelHomeLayouts","vrNovels","vrAnnotations","customCreatorParts","vrLetters","vrSettings","vrScripts","vrStagedPlays","vrPresets","worlds","worldEpisodes","lifeRecords","medPlans","lifeRecordSettings",
]);

const CANONICAL_STORES = new Set([
  "characters","messages","diaries","socialPosts","games","worldbooks","worlds","worldEpisodes","memoryNodes","memoryLinks","eventBoxes","dailySchedules","vrNovels","vrAnnotations","vrLetters","vrScripts","vrStagedPlays","lifeRecords","roomNotes","roomTodos","galleryImages","assets",
]);
const SENSITIVE_CONFIG_STORES = new Set(["apiConfig","apiPresets","syncConfig","cloudBackupMetadata","vrSettings"]);
const POLICY_SKIP_STORES = new Set(["pixelHomeAssets","pixelHomeLayouts","roomState","roomCustomAssets","hotNewsSnapshots","vrRecordings"]);
const SECRET_FIELD_NAMES = new Set(["apikey","accesstoken","refreshtoken","authtoken","password","passwd","cookie","cookies","masterkey","clientsecret","apisecret","authorization","bearertoken","privatekey","vapidprivatekey","secretkey","token","secret"]);
const SECRET_CONTEXT = /(api|auth|credential|cloud|vapid|token|secret|password|cookie|sync)/i;

export const SULLY_V3_OBSERVED_STORES = Object.freeze([...OBSERVED_SULLY_V3_STORES]);

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function normalizedKey(key: string): string { return key.replace(/[^a-z0-9]/gi, "").toLowerCase(); }
function toIso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return undefined;
}
function recordId(value: unknown): string | undefined { return isRecord(value) && (typeof value.id === "string" || typeof value.id === "number") ? String(value.id) : undefined; }

export function classifySullyStore(name: string): SullyStoreClassification {
  if (POLICY_SKIP_STORES.has(name)) return "policy-skip";
  if (SENSITIVE_CONFIG_STORES.has(name)) return "sensitive-config";
  if (CANONICAL_STORES.has(name)) return "canonical";
  if (OBSERVED_SULLY_V3_STORES.has(name)) return "compat";
  return "unknown";
}

export function sanitizeMigrationValue(value: unknown, options: { rootPath?: string } = {}): { value: unknown; redactedPaths: string[] } {
  const redactedPaths: string[] = [];
  const walk = (current: unknown, path: string, contexts: string[]): unknown => {
    if (Array.isArray(current)) return current.map((entry, index) => walk(entry, `${path}[${index}]`, contexts));
    if (!isRecord(current)) return current;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(current)) {
      const childPath = path ? `${path}.${key}` : key;
      const nk = normalizedKey(key);
      const hasSensitiveContext = contexts.some((part) => SECRET_CONTEXT.test(part)) || SECRET_CONTEXT.test(path);
      const isGenericKeySecret = nk === "key" && hasSensitiveContext;
      if (SECRET_FIELD_NAMES.has(nk) || isGenericKeySecret) {
        redactedPaths.push(childPath);
        continue;
      }
      output[key] = walk(child, childPath, [...contexts, key]);
    }
    return output;
  };
  return { value: walk(value, options.rootPath ?? "", []), redactedPaths };
}

export async function sha256Fingerprint(input: ArrayBuffer | Uint8Array | Blob): Promise<string> {
  const bytes = input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input instanceof Uint8Array ? input : new Uint8Array(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const ID_MAP_KEYS = ["characters","messages","moments","memories","assets","diaries","worlds","worldbooks","stories","games","schedules","eventBoxes"] as const;
export function createEmptySullyMigrationIdMap(): SullyMigrationIdMap {
  return Object.fromEntries(ID_MAP_KEYS.map((key) => [key, {}])) as SullyMigrationIdMap;
}
export function mapSullyId(map: SullyMigrationIdMap, collection: string, sourceId: string, allocate: (collection: string, sourceId: string) => string = (c, s) => `mig_${c}_${s}`): string {
  const bucket = map[collection] ?? (map[collection] = {});
  return bucket[sourceId] ?? (bucket[sourceId] = allocate(collection, sourceId));
}

interface ZipEntryLike { dir?: boolean; async(type: "string" | "uint8array"): Promise<any> }
interface ZipLike { files: Record<string, ZipEntryLike>; file(path: string): ZipEntryLike | null }
type ZipLoader = (input: ArrayBuffer | Uint8Array) => Promise<ZipLike>;
async function defaultZipLoader(input: ArrayBuffer | Uint8Array): Promise<ZipLike> {
  const module = await import("jszip");
  return module.default.loadAsync(input) as unknown as ZipLike;
}
async function inputBytes(input: ArrayBuffer | Uint8Array | Blob): Promise<Uint8Array> { return input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input instanceof Uint8Array ? input : new Uint8Array(input); }
async function readJson(entry: ZipEntryLike): Promise<unknown> { return JSON.parse(await entry.async("string")); }
function inferMediaType(path: string): string | undefined {
  const ext = path.split(".").pop()?.toLowerCase();
  return ({ png:"image/png", jpg:"image/jpeg", jpeg:"image/jpeg", webp:"image/webp", gif:"image/gif", mp3:"audio/mpeg", m4a:"audio/mp4", mp4:"video/mp4", wav:"audio/wav" } as Record<string,string>)[ext ?? ""];
}
function bump(target: Record<string, number>, key: string | undefined) { const safe = key || "unknown"; target[safe] = (target[safe] ?? 0) + 1; }

export async function parseSullyV3Backup(input: ArrayBuffer | Uint8Array | Blob, options: { zipLoader?: ZipLoader } = {}): Promise<SullyV3ParseResult> {
  const warnings: string[] = [];
  const errors: string[] = [];
  let fingerprint: string | undefined;
  try { fingerprint = await sha256Fingerprint(input); } catch { errors.push("unable to fingerprint backup"); }
  try {
    const bytes = await inputBytes(input);
    const zip = await (options.zipLoader ?? defaultZipLoader)(bytes);
    const manifestEntry = zip.file("manifest.json");
    if (!manifestEntry) return { ok:false, fingerprint, warnings, errors:[...errors,"manifest.json is missing"] };
    let rawManifest: unknown;
    try { rawManifest = await readJson(manifestEntry); } catch { return { ok:false, fingerprint, warnings, errors:[...errors,"manifest.json is not valid JSON"] }; }
    if (!isRecord(rawManifest)) return { ok:false, fingerprint, warnings, errors:[...errors,"manifest must be an object"] };
    if (rawManifest.formatVersion !== 3) errors.push(`unsupported Sully backup formatVersion: ${String(rawManifest.formatVersion)}`);
    if (rawManifest.mode !== "full") errors.push(`Sully backup mode must be full, got ${String(rawManifest.mode)}`);
    if (!isRecord(rawManifest.stores)) errors.push("manifest.stores must be an object");
    if (errors.length) return { ok:false, fingerprint, warnings, errors };
    const manifest = rawManifest as unknown as SullyV3Manifest;
    const parsedStores: Record<string, SullyStoreParseResult> = {};
    const compat: Array<{ store:string; records:unknown[] }> = [];
    const skippedByPolicy: Record<string, number> = {};
    const unknownStores: string[] = [];
    const redactedPaths: string[] = [];
    const messageTypes: Record<string, number> = {};
    const memoryRooms: Record<string, number> = {};
    const memoryLinkTypes: Record<string, number> = {};

    for (const [name, rawInfo] of Object.entries(manifest.stores)) {
      const info: Record<string, unknown> = isRecord(rawInfo) ? rawInfo : {};
      const declaredParts = Number(info.parts ?? 0);
      const declaredCount = Number(info.count ?? 0);
      const classification = classifySullyStore(name);
      const storeWarnings: string[] = [];
      const records: unknown[] = [];
      let observedCount = 0;
      if (classification === "policy-skip") {
        for (let index = 0; index < declaredParts; index++) {
          const path = `stores/${name}.${String(index).padStart(3,"0")}.json`;
          const entry = zip.file(path);
          if (!entry) { storeWarnings.push(`missing declared store part ${path}`); continue; }
          try {
            const parsed = await readJson(entry);
            if (!Array.isArray(parsed)) { storeWarnings.push(`${path} must contain an array`); continue; }
            observedCount += parsed.length;
          } catch { storeWarnings.push(`unable to parse ${path}`); }
        }
        skippedByPolicy[name] = observedCount;
      } else {
        for (let index = 0; index < declaredParts; index++) {
          const path = `stores/${name}.${String(index).padStart(3,"0")}.json`;
          const entry = zip.file(path);
          if (!entry) { storeWarnings.push(`missing declared store part ${path}`); continue; }
          try {
            const parsed = await readJson(entry);
            if (!Array.isArray(parsed)) { storeWarnings.push(`${path} must contain an array`); continue; }
            observedCount += parsed.length;
            for (const item of parsed) {
              const sanitized = sanitizeMigrationValue(item, { rootPath:`stores.${name}` });
              redactedPaths.push(...sanitized.redactedPaths);
              records.push(sanitized.value);
            }
          } catch { storeWarnings.push(`unable to parse ${path}`); }
        }
      }
      if (observedCount !== declaredCount) storeWarnings.push(`declared ${declaredCount} records but parsed ${observedCount}`);
      if (classification === "unknown") { unknownStores.push(name); warnings.push(`unknown Sully store preserved in compat: ${name}`); }
      if (classification === "compat" || classification === "unknown") compat.push({ store:name, records });
      warnings.push(...storeWarnings.map((message) => `${name}: ${message}`));
      parsedStores[name] = { name, classification, declaredCount, declaredParts, parsedCount: observedCount, records, warnings:storeWarnings };
      if (name === "messages") for (const item of records) if (isRecord(item)) bump(messageTypes, String(item.type ?? item.messageType ?? "unknown"));
      if (name === "memoryNodes") for (const item of records) if (isRecord(item)) bump(memoryRooms, typeof item.room === "string" ? item.room : "unknown");
      if (name === "memoryLinks") for (const item of records) if (isRecord(item)) bump(memoryLinkTypes, typeof item.type === "string" ? item.type : "unknown");
    }

    const declaredStoreNames = new Set(Object.keys(manifest.stores));
    const undeclaredParts = new Map<string, string[]>();
    for (const path of Object.keys(zip.files)) {
      const match = /^stores\/(.+)\.(\d{3})\.json$/.exec(path);
      if (match && !declaredStoreNames.has(match[1])) {
        const paths = undeclaredParts.get(match[1]) ?? [];
        paths.push(path);
        undeclaredParts.set(match[1], paths);
      }
    }
    for (const [name, paths] of undeclaredParts) {
      const records: unknown[] = [];
      for (const path of paths.sort()) {
        const entry = zip.file(path);
        if (!entry) continue;
        try {
          const parsed = await readJson(entry);
          if (!Array.isArray(parsed)) { warnings.push(`undeclared store part is not an array: ${path}`); continue; }
          for (const item of parsed) {
            const sanitized = sanitizeMigrationValue(item, { rootPath:`stores.${name}` });
            redactedPaths.push(...sanitized.redactedPaths);
            records.push(sanitized.value);
          }
        } catch { warnings.push(`unable to parse undeclared store part: ${path}`); }
      }
      unknownStores.push(name);
      compat.push({ store:name, records });
      warnings.push(`undeclared Sully store preserved in compat: ${name}`);
      parsedStores[name] = { name, classification:"unknown", declaredCount:0, declaredParts:0, parsedCount:records.length, records, warnings:["store was not declared in manifest"] };
    }

    const assets: SullyAssetDescriptor[] = [];
    let totalBytes = 0;
    for (const [path, entry] of Object.entries(zip.files)) {
      if (entry.dir || !path.startsWith("assets/")) continue;
      try {
        const value = await entry.async("uint8array") as Uint8Array;
        totalBytes += value.byteLength;
        assets.push({ sourcePath:path, sourceOriginalId:path.slice("assets/".length), kind:"asset", mediaType:inferMediaType(path), byteLength:value.byteLength });
      } catch { warnings.push(`unable to inspect asset ${path}`); }
    }

    const missingBlobs: string[] = [];
    const blobIndexEntry = zip.file("blobs/index.json");
    let blobIndex: unknown[] = [];
    if (blobIndexEntry) {
      try { const parsed = await readJson(blobIndexEntry); if (Array.isArray(parsed)) blobIndex = parsed; else warnings.push("blobs/index.json must contain an array"); }
      catch { warnings.push("unable to parse blobs/index.json"); }
    }
    for (const item of blobIndex) {
      if (!isRecord(item) || typeof item.id !== "string") { warnings.push("blobs/index.json contains an invalid entry"); continue; }
      const path = `blobs/${item.id}`;
      const entry = zip.file(path);
      if (!entry) { missingBlobs.push(item.id); assets.push({sourcePath:path,sourceOriginalId:item.id,kind:"blob",mediaType:typeof item.type === "string"?item.type:undefined,byteLength:typeof item.size === "number"?item.size:undefined,missing:true}); continue; }
      const bytes = await entry.async("uint8array") as Uint8Array;
      totalBytes += bytes.byteLength;
      if (typeof item.size === "number" && item.size !== bytes.byteLength) warnings.push(`blob size mismatch for ${item.id}`);
      assets.push({sourcePath:path,sourceOriginalId:item.id,kind:"blob",mediaType:typeof item.type === "string"?item.type:undefined,byteLength:bytes.byteLength});
    }
    const indexedBlobIds = new Set(blobIndex.filter(isRecord).map((item) => typeof item.id === "string" ? item.id : "").filter(Boolean));
    const actualBlobPaths = Object.keys(zip.files).filter((path) => path.startsWith("blobs/") && path !== "blobs/index.json" && !zip.files[path].dir);
    for (const path of actualBlobPaths) if (!indexedBlobIds.has(path.slice("blobs/".length))) {
      const entry = zip.file(path);
      if (!entry) continue;
      const bytes = await entry.async("uint8array") as Uint8Array;
      totalBytes += bytes.byteLength;
      assets.push({sourcePath:path,sourceOriginalId:path.slice("blobs/".length),kind:"blob",byteLength:bytes.byteLength});
      warnings.push(`unindexed blob file preserved for investigation: ${path}`);
    }

    let vectorIndexEntries = 0; const vectorModels = new Set<string>(); const vectorDimensions = new Set<number>();
    const vectorIndexEntry = zip.file("stores/memory_vectors.index.json");
    if (vectorIndexEntry) {
      try {
        const parsed = await readJson(vectorIndexEntry);
        if (Array.isArray(parsed)) {
          vectorIndexEntries = parsed.length;
          for (const item of parsed) if (isRecord(item)) {
            if (typeof item.model === "string") vectorModels.add(item.model);
            if (typeof item.dimensions === "number") vectorDimensions.add(item.dimensions);
          }
        } else warnings.push("memory vector index must contain an array");
      } catch { warnings.push("unable to parse memory vector index"); }
    }

    const report: SullyNormalizationReport = {
      source:{format:"sully_v3",formatVersion:3,mode:"full",createdAt:toIso(manifest.createdAt),backupFingerprint:fingerprint!},
      stores:Object.fromEntries(Object.entries(parsedStores).map(([name,store]) => [name,{classification:store.classification,declaredCount:store.declaredCount,parsedCount:store.parsedCount,declaredParts:store.declaredParts}])),
      counts:Object.fromEntries(Object.entries(manifest.stores).map(([name,info]) => [name, Number((info as any).count ?? 0)])),
      skippedByPolicy, unknownStores, redactions:{count:redactedPaths.length,paths:[...new Set(redactedPaths)].sort()},
      assets:{assetFiles:assets.filter((a) => a.kind === "asset").length,blobFiles:assets.filter((a) => a.kind === "blob" && !a.missing).length,totalBytes,missingBlobs},
      vectors:{count:Number(manifest.vectors?.count ?? 0),byteLength:typeof manifest.vectors?.byteLength === "number"?manifest.vectors.byteLength:undefined,indexEntries:vectorIndexEntries,models:[...vectorModels].sort(),dimensions:[...vectorDimensions].sort((a,b)=>a-b),activeEmbeddingReusable:false},
      distributions:{messageTypes,memoryRooms,memoryLinkTypes}, warnings:[...warnings], errors:[],
    };
    return { ok:true, manifest, fingerprint:fingerprint!, stores:parsedStores, compat, assets, report };
  } catch (error) {
    return { ok:false, fingerprint, warnings, errors:[...errors,`unable to parse Sully backup: ${error instanceof Error ? error.message : "unknown error"}`] };
  }
}
