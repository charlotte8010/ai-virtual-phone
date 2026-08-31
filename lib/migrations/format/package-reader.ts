import type { FloatMigrationManifest } from "./types";
import { validateFloatMigrationManifest } from "./validate-package";

export interface FloatMigrationPackageScan {
  ok: boolean;
  manifest?: FloatMigrationManifest;
  files: string[];
  warnings: string[];
  errors: string[];
}

type ZipEntryLike = { dir?: boolean; async(type: "string"): Promise<string> };
type ZipLike = { files: Record<string, ZipEntryLike>; file(path: string): ZipEntryLike | null };
type ZipLoader = (input: ArrayBuffer | Uint8Array) => Promise<ZipLike>;

function unsafeZipPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.startsWith("/") || normalized.split("/").some((part) => part === "..");
}

async function defaultZipLoader(input: ArrayBuffer | Uint8Array): Promise<ZipLike> {
  const module = await import("jszip");
  return module.default.loadAsync(input) as unknown as ZipLike;
}

export async function scanFloatMigrationPackage(
  input: ArrayBuffer | Uint8Array,
  options: { zipLoader?: ZipLoader } = {},
): Promise<FloatMigrationPackageScan> {
  const warnings: string[] = [];
  const errors: string[] = [];
  try {
    const zip = await (options.zipLoader ?? defaultZipLoader)(input);
    const files = Object.entries(zip.files).filter(([, entry]) => !entry.dir).map(([path]) => path).sort();
    const unsafe = files.filter(unsafeZipPath);
    if (unsafe.length) errors.push(`package contains unsafe paths: ${unsafe.join(", ")}`);
    const manifestFile = zip.file("manifest.json");
    if (!manifestFile) return { ok: false, files, warnings, errors: [...errors, "manifest.json is missing"] };
    let manifest: unknown;
    try { manifest = JSON.parse(await manifestFile.async("string")); }
    catch { return { ok: false, files, warnings, errors: [...errors, "manifest.json is not valid JSON"] }; }
    const validation = validateFloatMigrationManifest(manifest);
    errors.push(...validation.errors);
    return { ok: errors.length === 0, manifest: validation.valid ? manifest as FloatMigrationManifest : undefined, files, warnings, errors };
  } catch (error) {
    return { ok: false, files: [], warnings, errors: [`unable to read migration package: ${error instanceof Error ? error.message : "unknown error"}`] };
  }
}
