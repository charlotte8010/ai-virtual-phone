export const FLOAT_MIGRATION_FORMAT = "float_migration" as const;
export const FLOAT_MIGRATION_FORMAT_VERSION = 1 as const;

export interface MigrationSourceRef {
  platform: string;
  backupFormat?: string;
  backupFormatVersion?: number | string;
  backupFingerprint: string;
  store?: string;
  originalId?: string;
}

export interface FloatMigrationManifest {
  format: typeof FLOAT_MIGRATION_FORMAT;
  formatVersion: typeof FLOAT_MIGRATION_FORMAT_VERSION;
  packageId: string;
  source: {
    platform: string;
    format?: string;
    formatVersion?: number | string;
    backupFingerprint: string;
  };
  createdAt: string;
  counts: Record<string, number>;
  assets: { count: number; totalBytes?: number };
  skippedByPolicy: Record<string, number>;
  warnings?: string[];
}

export interface MigrationAssetRef {
  assetId: string;
  sourceOriginalId?: string;
  mediaType?: string;
  fileName?: string;
  byteLength?: number;
  sha256?: string;
  packagePath?: string;
  missing?: boolean;
  source: MigrationSourceRef;
}

export interface MigrationIdentity {
  migrationId: string;
  kind: "user" | "character" | "other";
  displayName?: string;
  avatar?: MigrationAssetRef;
  timezone?: string;
  locale?: string;
  source: MigrationSourceRef;
  metadata?: Record<string, unknown>;
}

export interface MigrationCharacter extends MigrationIdentity {
  kind: "character";
  persona?: string;
  systemPrompt?: string;
  personality?: unknown;
  relationshipRef?: string;
}

export interface MigrationRelationship {
  migrationId: string;
  userRef?: string;
  characterRef?: string;
  state?: unknown;
  createdAt?: string;
  updatedAt?: string;
  source: MigrationSourceRef;
}

export interface MigrationConversation {
  migrationId: string;
  characterRef?: string;
  title?: string;
  startedAt?: string;
  endedAt?: string;
  source: MigrationSourceRef;
  metadata?: Record<string, unknown>;
}

export interface MigrationMessage {
  migrationId: string;
  sourceOriginalId?: string;
  characterRef?: string;
  conversationRef?: string;
  role: "user" | "assistant" | "system" | "other";
  content?: string;
  messageType?: string;
  media?: MigrationAssetRef[];
  createdAt?: string;
  replyTo?: string;
  source: MigrationSourceRef;
  sourceMetadata?: Record<string, unknown>;
}

export interface MigrationMoment {
  migrationId: string;
  authorRef?: string;
  content?: string;
  images?: MigrationAssetRef[];
  likes?: unknown[];
  comments?: unknown[];
  createdAt?: string;
  source: MigrationSourceRef;
  metadata?: Record<string, unknown>;
}

export interface MigrationDiary {
  migrationId: string;
  date?: string;
  userContent?: unknown;
  characterContent?: unknown;
  createdAt?: string;
  source: MigrationSourceRef;
  metadata?: Record<string, unknown>;
}

export interface MigrationWorld {
  migrationId: string;
  title?: string;
  content?: unknown;
  source: MigrationSourceRef;
  metadata?: Record<string, unknown>;
}

export interface MigrationWorldbook {
  migrationId: string;
  worldRef?: string;
  title?: string;
  content?: string;
  keys?: string[];
  source: MigrationSourceRef;
  settings?: Record<string, unknown>;
}

export interface MigrationStory {
  migrationId: string;
  kind?: string;
  title?: string;
  content?: unknown;
  createdAt?: string;
  source: MigrationSourceRef;
  metadata?: Record<string, unknown>;
}

export interface MigrationGame {
  migrationId: string;
  kind?: string;
  title?: string;
  state?: unknown;
  createdAt?: string;
  source: MigrationSourceRef;
  metadata?: Record<string, unknown>;
}

export interface MigrationSchedule {
  migrationId: string;
  characterRef?: string;
  date?: string;
  content?: unknown;
  source: MigrationSourceRef;
  metadata?: Record<string, unknown>;
}

export interface MigrationEventBox {
  migrationId: string;
  characterRef?: string;
  name?: string;
  tags?: string[];
  summary?: string;
  liveMemoryRefs?: string[];
  archiveMemoryRefs?: string[];
  predecessorRef?: string;
  createdAt?: string;
  updatedAt?: string;
  source: MigrationSourceRef;
  metadata?: Record<string, unknown>;
}

export interface MigrationMemory {
  migrationId: string;
  sourceOriginalId?: string;
  characterRef?: string;
  content: string;
  tags?: string[];
  importance?: number;
  mood?: unknown;
  room?: string;
  createdAt?: string;
  lastAccessedAt?: string;
  accessCount?: number;
  origin?: unknown;
  eventBoxRef?: string;
  valence?: number;
  arousal?: number;
  archived?: boolean;
  source: MigrationSourceRef;
  metadata?: Record<string, unknown>;
}

export interface MigrationFutureIntent {
  migrationId: string;
  characterRef?: string;
  content: string;
  timeExpression?: string;
  timePrecision: "exact" | "day" | "range" | "vague" | "unknown";
  status?: "pending" | "fulfilled" | "cancelled" | "unknown";
  sourceMemoryRef?: string;
  source: MigrationSourceRef;
  metadata?: Record<string, unknown>;
}

export interface MigrationMemoryLink {
  migrationId: string;
  characterRef?: string;
  fromMemoryRef: string;
  toMemoryRef: string;
  type: string;
  weight?: number;
  createdAt?: string;
  source: MigrationSourceRef;
  metadata?: Record<string, unknown>;
}

export interface FloatMigrationPackagePayload {
  identities: MigrationIdentity[];
  characters: MigrationCharacter[];
  relationships: MigrationRelationship[];
  conversations: MigrationConversation[];
  messages: MigrationMessage[];
  moments: MigrationMoment[];
  diaries: MigrationDiary[];
  worlds: MigrationWorld[];
  worldbooks: MigrationWorldbook[];
  stories: MigrationStory[];
  games: MigrationGame[];
  schedules: MigrationSchedule[];
  eventBoxes: MigrationEventBox[];
  memories: MigrationMemory[];
  futureIntents: MigrationFutureIntent[];
  memoryLinks: MigrationMemoryLink[];
  extended: Record<string, unknown>;
  compat: Array<{ store: string; records: unknown[] }>;
  provenance: {
    idMap: Record<string, Record<string, string>>;
    normalizationReport: unknown;
    sourceManifest: unknown;
    metadataRedactions: string[];
    excludedSensitiveStores: Record<string, number>;
    excludedRuntimeStores: Record<string, number>;
  };
}
