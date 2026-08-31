import type { MigrationAssetRef } from "../format/types";
import { writeFloatMigrationPackage, type MigrationPackageBinaryAsset } from "../format/package-writer";
import { validateFloatMigrationManifest } from "../format/validate-package";
import { parseSullyV3Backup, sanitizeMigrationValue } from "./foundation";
import { normalizeSullyV3ToMigrationPackage } from "./normalize";

interface ZipEntryLike { dir?: boolean; async(type: "string" | "uint8array"): Promise<any> }
interface ZipLike { files: Record<string, ZipEntryLike>; file(path: string): ZipEntryLike | null }
type ZipLoader = (input: ArrayBuffer | Uint8Array) => Promise<ZipLike>;

async function defaultZipLoader(input: ArrayBuffer | Uint8Array): Promise<ZipLike> {
  const module = await import("jszip");
  return module.default.loadAsync(input) as unknown as ZipLike;
}

async function bytes(input: ArrayBuffer | Uint8Array | Blob): Promise<Uint8Array> {
  return input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input instanceof Uint8Array ? input : new Uint8Array(input);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface SullyMigrationPackageBuildResult {
  bytes: Uint8Array;
  fileName: string;
  manifest: ReturnType<typeof normalizeSullyV3ToMigrationPackage>["manifest"];
  payload: ReturnType<typeof normalizeSullyV3ToMigrationPackage>["payload"];
}

export interface SullyMigrationPackageBuildOptions {
  packageId?: string;
  createdAt?: string;
  fileStem?: string;
  zipLoader?: ZipLoader;
}

function defaultPackageId(fingerprint: string): string {
  const suffix = fingerprint.replace(/^sha256:/, "").slice(0, 12);
  return `pkg_sully_${Date.now().toString(36)}_${suffix}`;
}

function outputFileName(fileStem: string | undefined, createdAt: string): string {
  const date = createdAt.slice(0, 10);
  const safe = (fileStem ?? "sully-to-float").replace(/[\\/:*?"<>|]+/g, "_").trim() || "sully-to-float";
  return `${safe}_${date}.float-migration.zip`;
}

export async function buildSullyV3MigrationPackage(input: ArrayBuffer | Uint8Array | Blob, options: SullyMigrationPackageBuildOptions = {}): Promise<SullyMigrationPackageBuildResult> {
  const parsed = await parseSullyV3Backup(input, { zipLoader: options.zipLoader });
  if (!parsed.ok) throw new Error(`invalid Sully v3 backup: ${parsed.errors.join("; ")}`);

  const sourceBytes = await bytes(input);
  const zip = await (options.zipLoader ?? defaultZipLoader)(sourceBytes);
  let userProfile: Record<string, unknown> | undefined;
  const metadataRedactions: string[] = [];
  const metadataEntry = zip.file("metadata.json");
  if (metadataEntry) {
    try {
      const raw = JSON.parse(await metadataEntry.async("string"));
      if (isRecord(raw) && isRecord(raw.userProfile)) {
        const selected = {
          id: raw.userProfile.id,
          name: raw.userProfile.name,
          avatar: raw.userProfile.avatar,
          bio: raw.userProfile.bio,
        };
        const sanitized = sanitizeMigrationValue(selected, { rootPath: "metadata.userProfile" });
        if (isRecord(sanitized.value)) userProfile = sanitized.value;
        metadataRedactions.push(...sanitized.redactedPaths);
      }
    } catch {
      parsed.report.warnings.push("unable to parse metadata.json userProfile");
    }
  }

  const createdAt = options.createdAt ?? new Date().toISOString();
  const normalized = normalizeSullyV3ToMigrationPackage(parsed, {
    packageId: options.packageId ?? defaultPackageId(parsed.fingerprint),
    createdAt,
    userProfile,
    metadataRedactions,
  });
  const validation = validateFloatMigrationManifest(normalized.manifest);
  if (!validation.valid) throw new Error(`generated migration manifest is invalid: ${validation.errors.join("; ")}`);

  const binaryAssets: MigrationPackageBinaryAsset[] = [];
  const refBySourcePath = new Map<string, MigrationAssetRef>();
  for (const ref of normalized.assetRefs) {
    const descriptor = parsed.assets.find((entry) => entry.sourceOriginalId === ref.sourceOriginalId);
    if (descriptor) refBySourcePath.set(descriptor.sourcePath, ref);
  }
  for (const descriptor of parsed.assets) {
    const ref = refBySourcePath.get(descriptor.sourcePath);
    if (!ref) continue;
    if (descriptor.missing) { binaryAssets.push({ ref }); continue; }
    const entry = zip.file(descriptor.sourcePath);
    if (!entry) { binaryAssets.push({ ref: { ...ref, missing: true, packagePath: undefined } }); continue; }
    binaryAssets.push({ ref, bytes: await entry.async("uint8array") as Uint8Array });
  }

  const packageBytes = await writeFloatMigrationPackage({ manifest: normalized.manifest, payload: normalized.payload, binaryAssets });
  return {
    bytes: packageBytes,
    fileName: outputFileName(options.fileStem ?? (typeof userProfile?.name === "string" ? `${userProfile.name}_sully-to-float` : undefined), createdAt),
    manifest: normalized.manifest,
    payload: normalized.payload,
  };
}
