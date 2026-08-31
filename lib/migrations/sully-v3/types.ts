export type SullyStoreClassification = "canonical" | "compat" | "policy-skip" | "sensitive-config" | "unknown";

export interface SullyV3StoreManifest { parts: number; count: number }
export interface SullyV3Manifest {
  formatVersion: 3;
  mode: "full";
  createdAt: number | string;
  stores: Record<string, SullyV3StoreManifest>;
  vectors?: { count?: number; byteLength?: number; [key: string]: unknown };
  assetCount?: number;
  [key: string]: unknown;
}

export interface SullyAssetDescriptor {
  sourcePath: string;
  sourceOriginalId: string;
  kind: "asset" | "blob";
  mediaType?: string;
  byteLength?: number;
  missing?: boolean;
}

export interface SullyStoreParseResult {
  name: string;
  classification: SullyStoreClassification;
  declaredCount: number;
  declaredParts: number;
  parsedCount: number;
  records: unknown[];
  warnings: string[];
}

export interface SullyMigrationIdMap {
  characters: Record<string, string>;
  messages: Record<string, string>;
  moments: Record<string, string>;
  memories: Record<string, string>;
  assets: Record<string, string>;
  diaries: Record<string, string>;
  worlds: Record<string, string>;
  worldbooks: Record<string, string>;
  stories: Record<string, string>;
  games: Record<string, string>;
  schedules: Record<string, string>;
  eventBoxes: Record<string, string>;
  [key: string]: Record<string, string>;
}

export interface SullyNormalizationReport {
  source: { format: "sully_v3"; formatVersion: 3; mode: "full"; createdAt?: string; backupFingerprint: string };
  stores: Record<string, { classification: SullyStoreClassification; declaredCount: number; parsedCount: number; declaredParts: number }>;
  counts: Record<string, number>;
  skippedByPolicy: Record<string, number>;
  unknownStores: string[];
  redactions: { count: number; paths: string[] };
  assets: { assetFiles: number; blobFiles: number; totalBytes: number; missingBlobs: string[] };
  vectors: { count: number; byteLength?: number; indexEntries?: number; models?: string[]; dimensions?: number[]; activeEmbeddingReusable: false };
  distributions: { messageTypes: Record<string, number>; memoryRooms: Record<string, number>; memoryLinkTypes: Record<string, number> };
  warnings: string[];
  errors: string[];
}

export interface SullyV3ParseSuccess {
  ok: true;
  manifest: SullyV3Manifest;
  fingerprint: string;
  stores: Record<string, SullyStoreParseResult>;
  compat: Array<{ store: string; records: unknown[] }>;
  assets: SullyAssetDescriptor[];
  report: SullyNormalizationReport;
}
export interface SullyV3ParseFailure { ok: false; fingerprint?: string; warnings: string[]; errors: string[] }
export type SullyV3ParseResult = SullyV3ParseSuccess | SullyV3ParseFailure;
