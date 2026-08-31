const SECRET_FIELD_NAMES = new Set([
  "apikey", "accesstoken", "refreshtoken", "authtoken", "password", "passwd",
  "cookie", "cookies", "masterkey", "clientsecret", "apisecret", "authorization",
  "bearertoken", "privatekey", "vapidprivatekey", "secretkey", "token", "secret",
]);

export interface MigrationManifestValidationResult {
  valid: boolean;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function scanForSecretFields(value: unknown, path = "manifest"): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => scanForSecretFields(entry, `${path}[${index}]`));
  }
  if (!isRecord(value)) return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const childPath = `${path}.${key}`;
    if (SECRET_FIELD_NAMES.has(normalized)) found.push(childPath);
    found.push(...scanForSecretFields(child, childPath));
  }
  return found;
}

export function validateFloatMigrationManifest(input: unknown): MigrationManifestValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { valid: false, errors: ["manifest must be an object"] };
  if (input.format !== "float_migration") errors.push("format must be float_migration");
  if (input.formatVersion !== 1) errors.push("formatVersion must be 1");
  if (typeof input.packageId !== "string" || !input.packageId.trim()) errors.push("packageId is required");
  if (typeof input.createdAt !== "string" || Number.isNaN(Date.parse(input.createdAt))) errors.push("createdAt must be an ISO date string");

  if (!isRecord(input.source)) {
    errors.push("source is required");
  } else {
    if (typeof input.source.platform !== "string" || !input.source.platform.trim()) errors.push("source.platform is required");
    if (typeof input.source.backupFingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(input.source.backupFingerprint)) {
      errors.push("source.backupFingerprint must be sha256:<64 hex>");
    }
  }

  for (const key of ["counts", "skippedByPolicy"] as const) {
    if (!isRecord(input[key])) errors.push(`${key} must be an object`);
    else for (const [name, value] of Object.entries(input[key])) {
      if (!isNonNegativeInteger(value)) errors.push(`${key}.${name} must be a non-negative integer`);
    }
  }

  if (!isRecord(input.assets)) errors.push("assets must be an object");
  else {
    if (!isNonNegativeInteger(input.assets.count)) errors.push("assets.count must be a non-negative integer");
    if (input.assets.totalBytes !== undefined && !isNonNegativeInteger(input.assets.totalBytes)) errors.push("assets.totalBytes must be a non-negative integer");
  }

  if (input.warnings !== undefined && (!Array.isArray(input.warnings) || input.warnings.some((value) => typeof value !== "string"))) {
    errors.push("warnings must be an array of strings");
  }

  for (const path of scanForSecretFields(input)) errors.push(`secret-like manifest field is forbidden: ${path}`);
  return { valid: errors.length === 0, errors };
}
