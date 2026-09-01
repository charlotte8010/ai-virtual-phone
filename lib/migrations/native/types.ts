import type { Character } from "../../character-types";
import type { ChatContact, ChatMessage, ChatSession } from "../../chat-storage";
import type { StoryMessage, StorySession } from "../../story-storage";
import type { CharacterWorldGroup } from "../../character-world-storage";
import type { MomentComment, MomentPost } from "../../moments-types";
import type { DiaryEntry } from "../../diary-entry-types";
import type { CalendarWeekPlan } from "../../calendar-types";
import type { WorldBookConfig } from "../../settings-types";
import type { MemoryEntry } from "../../memory-types";
import type { UserIdentity } from "../../../components/settings/user-identity";
import type {
  FloatMigrationManifest,
  FloatMigrationPackagePayload,
  MigrationAssetRef,
  MigrationFutureIntent,
  MigrationMemory,
  MigrationMemoryLink,
  MigrationRelationship,
} from "../format/types";

export type NativeMigrationDomain =
  | "identities" | "characters" | "contacts" | "sessions" | "messages" | "media"
  | "moments" | "momentComments" | "diaries" | "worlds" | "worldbooks" | "calendar"
  | "memories" | "storySessions" | "storyMessages" | "archive" | "idMap";

export type MigrationDecision = "create" | "reuse" | "skip" | "conflict" | "failed";

export interface NativeIdentityImport {
  sourceMigrationId: string;
  value: UserIdentity;
  avatarAssetId?: string;
}

export interface NativeCharacterImport {
  sourceMigrationId: string;
  value: Character;
  avatarAssetId?: string;
}

export interface NativeMediaImport {
  sourceAssetId: string;
  targetId: string;
  targetRef: string;
  source: MigrationAssetRef;
}

export interface MigrationArchivedIntent {
  intent: MigrationFutureIntent;
  sourceMemory?: MigrationMemory;
}

export interface NativeMigrationArchive {
  archivedMemories: MigrationMemory[];
  archivedFutureIntents: MigrationArchivedIntent[];
  memoryLinks: MigrationMemoryLink[];
  unsupportedRelationships: MigrationRelationship[];
  diaryUserPages: Array<{ diaryMigrationId: string; userContent: unknown; metadata?: Record<string, unknown> }>;
  momentSourceMetadata: Array<{
    momentMigrationId: string;
    aggregateLikes?: number;
    explicitUserLiked: boolean;
    sourceLikes?: unknown[];
    sourceMetadata?: Record<string, unknown>;
  }>;
  messageSourceMetadata: Array<{
    messageMigrationId: string;
    messageType?: string;
    sourceMetadata?: Record<string, unknown>;
  }>;
  scheduleSource: unknown[];
  eventBoxes: FloatMigrationPackagePayload["eventBoxes"];
  stories: FloatMigrationPackagePayload["stories"];
  games: FloatMigrationPackagePayload["games"];
  extended: Record<string, unknown>;
  compat: FloatMigrationPackagePayload["compat"];
  provenance: FloatMigrationPackagePayload["provenance"];
}

export interface NativeMigrationPlan {
  manifest: FloatMigrationManifest;
  sourceFingerprint: string;
  identities: NativeIdentityImport[];
  characters: NativeCharacterImport[];
  contacts: ChatContact[];
  sessions: ChatSession[];
  messages: ChatMessage[];
  storySessions: StorySession[];
  storyMessages: StoryMessage[];
  media: NativeMediaImport[];
  moments: MomentPost[];
  momentComments: MomentComment[];
  diaries: DiaryEntry[];
  worlds: CharacterWorldGroup[];
  worldbooks: WorldBookConfig[];
  calendar: CalendarWeekPlan[];
  memories: MemoryEntry[];
  activeMemoryPalaceCount: number;
  legacyCoreMemoryCount: number;
  activeFutureIntentCount: number;
  archivedWindowsillCount: number;
  archive: NativeMigrationArchive;
  idMap: Record<string, Record<string, string>>;
  warnings: string[];
  timelineRecords: [];
}

export interface NativeMigrationSnapshot {
  identities: UserIdentity[];
  characters: Character[];
  contacts: ChatContact[];
  sessions: ChatSession[];
  messages: ChatMessage[];
  storySessions: StorySession[];
  storyMessages: StoryMessage[];
  mediaIds: string[];
  moments: MomentPost[];
  momentComments: MomentComment[];
  diaries: DiaryEntry[];
  worlds: CharacterWorldGroup[];
  worldbooks: WorldBookConfig[];
  calendar: CalendarWeekPlan[];
  memories: MemoryEntry[];
  archive?: NativeMigrationArchive;
  idMap?: Record<string, Record<string, string>>;
}

export interface DomainReconciliation<T> {
  create: T[];
  reuse: T[];
  skip: T[];
  conflicts: Array<{ planned: T; existing: T; reason: string }>;
}

export interface NativeMigrationReconciliation {
  identities: DomainReconciliation<UserIdentity>;
  characters: DomainReconciliation<Character>;
  contacts: DomainReconciliation<ChatContact>;
  sessions: DomainReconciliation<ChatSession>;
  messages: DomainReconciliation<ChatMessage>;
  media: DomainReconciliation<NativeMediaImport>;
  moments: DomainReconciliation<MomentPost>;
  momentComments: DomainReconciliation<MomentComment>;
  diaries: DomainReconciliation<DiaryEntry>;
  worlds: DomainReconciliation<CharacterWorldGroup>;
  worldbooks: DomainReconciliation<WorldBookConfig>;
  calendar: DomainReconciliation<CalendarWeekPlan>;
  memories: DomainReconciliation<MemoryEntry>;
  storySessions: DomainReconciliation<StorySession>;
  storyMessages: DomainReconciliation<StoryMessage>;
  archive: "create" | "reuse" | "conflict";
  idMap: "create" | "reuse" | "conflict";
  resolvedIdMap: Record<string, Record<string, string>>;
  totals: { create: number; reuse: number; skip: number; conflicts: number };
}

export interface MigrationRunJournal {
  runId: string;
  packageId: string;
  sourceFingerprint: string;
  status: "planned" | "applying" | "applied" | "failed" | "rolled_back";
  startedAt: string;
  completedAt?: string;
  rolledBackAt?: string;
  created: Partial<Record<NativeMigrationDomain, string[]>>;
  reused: Partial<Record<NativeMigrationDomain, string[]>>;
  skipped: Partial<Record<NativeMigrationDomain, string[]>>;
  conflicts: Partial<Record<NativeMigrationDomain, string[]>>;
  warnings: string[];
  failures: string[];
}

export interface NativeMigrationDryRun {
  plan: NativeMigrationPlan;
  reconciliation: NativeMigrationReconciliation;
  summary: {
    characters: number;
    sourceMessages: number;
    chatMessages: number;
    storyMessages: number;
    storySessions: number;
    messages: number;
    assets: number;
    moments: number;
    comments: number;
    diary: number;
    worldbooks: number;
    activeMemories: number;
    archivedMemories: number;
    activeFutureIntents: number;
    archivedWindowsill: number;
    memoryLinks: number;
    legacyCoreSummaries: number;
    timelineRecords: number;
  };
}
