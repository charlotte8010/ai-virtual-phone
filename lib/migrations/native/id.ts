function hash32(input: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
    hash ^= hash >>> 13;
  }
  return hash.toString(36).padStart(7, "0");
}

function safePrefix(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return (normalized || "record").slice(0, 24);
}

/**
 * Stable across re-runs and across re-packaging of the same source backup.
 * The source fingerprint, not the package id, is the identity scope.
 */
export function deterministicNativeId(kind: string, sourceFingerprint: string, migrationId: string): string {
  const input = `${sourceFingerprint}\u0000${kind}\u0000${migrationId}`;
  return `fm_${safePrefix(kind)}_${hash32(input, 0x811c9dc5)}${hash32(input, 0x9e3779b9)}`;
}

export function migrationKvSuffix(sourceFingerprint: string): string {
  const input = `migration-kv\u0000${sourceFingerprint}`;
  return `${hash32(input, 0x811c9dc5)}${hash32(input, 0x85ebca6b)}`;
}

export function deterministicWechatId(sourceFingerprint: string, migrationId: string): string {
  const input = `${sourceFingerprint}\u0000wechat\u0000${migrationId}`;
  const left = parseInt(hash32(input, 0x27d4eb2d), 36) >>> 0;
  const right = parseInt(hash32(input, 0x165667b1), 36) >>> 0;
  const eight = String((left * 1000003 + right) % 100000000).padStart(8, "0");
  return `199${eight}`;
}
