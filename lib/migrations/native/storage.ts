import Dexie from "dexie";
import type { Table } from "dexie";
import type { Character } from "../../character-types";
import type { ChatContact, ChatMessage, ChatSession } from "../../chat-storage";
import type { StoryMessage, StorySession } from "../../story-storage";
import { chatDb } from "../../chat-db";
import type { MomentComment, MomentPost } from "../../moments-types";
import { momentsDb } from "../../moments-db";
import type { DiaryEntry } from "../../diary-entry-types";
import type { CharacterWorldGroup } from "../../character-world-storage";
import type { WorldBookConfig } from "../../settings-types";
import type { CalendarWeekPlan } from "../../calendar-types";
import type { MemoryEntry, MemoryLink } from "../../memory-types";
import { deleteMemoryEntriesWithoutLinkCleanup, deleteMemoryLinks, loadMemoryEntries, loadMemoryLinks, saveMemoryEntries, saveMemoryLinks } from "../../memory-storage";
import { isKvHydrated, kvGet, kvRemove, kvSetAsync } from "../../kv-db";
import { listMediaCacheSummaries } from "../../media-cache-storage";
import type { UserIdentity } from "../../../components/settings/user-identity";
import type { ReadFloatMigrationPackageSuccess } from "../format/read-package";
import { migrationKvSuffix } from "./id";
import { loadMigrationJournals, saveMigrationJournal } from "./journal";
import type {
  MigrationRunJournal,
  NativeMigrationArchive,
  NativeMigrationPlan,
  NativeMigrationReconciliation,
  NativeMigrationSnapshot,
} from "./types";

const IDENTITIES_KEY = "ai_phone_user_identities_v1";
const CHARACTERS_KEY = "ai_phone_characters_v1";
const DIARY_KEY = "ai_phone_diary_entries_v1";
const WORLDS_KEY = "ai_phone_character_worlds_v1";
const CALENDAR_KEY = "ai_phone_calendar_plans_v1";
const ARCHIVE_KEY_PREFIX = "ai_phone_migration_archive_v1:";
const ID_MAP_KEY_PREFIX = "ai_phone_migration_id_map_v1:";

function archiveKey(fingerprint: string): string {
  return `${ARCHIVE_KEY_PREFIX}${migrationKvSuffix(fingerprint)}`;
}

function idMapKey(fingerprint: string): string {
  return `${ID_MAP_KEY_PREFIX}${migrationKvSuffix(fingerprint)}`;
}

function parseArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value as T[] : [];
  } catch {
    return [];
  }
}

function parseObject<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" ? value as T : undefined;
  } catch {
    return undefined;
  }
}

function mediaCategory(mime = ""): "audio" | "image" | "video" | "file" {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

/** Copy into an ArrayBuffer-backed view so DOM BlobPart typing never sees SharedArrayBuffer. */
function blobFromBytes(bytes: Uint8Array, mimeType: string): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: mimeType });
}

interface MediaCacheEntry {
  id: string;
  blob: Blob;
  mimeType: string;
  mediaCategory: "audio" | "image" | "video" | "file";
  createdAt: number;
}

class MigrationMediaDatabase extends Dexie {
  entries!: Table<MediaCacheEntry, string>;
  constructor(name = "AiPhoneMediaCacheDB") {
    super(name);
    this.version(1).stores({ entries: "id, createdAt" });
  }
}

class MigrationSettingsDatabase extends Dexie {
  worldBooks!: Table<WorldBookConfig, string>;
  constructor(name = "AiPhoneSettingsDB") {
    super(name);
    this.version(1).stores({ presets: "id", worldBooks: "id", regexes: "id" });
  }
}

class MigrationKvDatabase extends Dexie {
  entries!: Table<{ key: string; value: string }, string>;
  constructor(name = "AiPhoneKvDB") {
    super(name);
    this.version(1).stores({ entries: "key" });
  }
}

class MigrationStoryDatabase extends Dexie {
  sessions!: Table<StorySession, string>;
  messages!: Table<StoryMessage, string>;

  constructor(name = "AiPhoneStoryDB") {
    super(name);
    this.version(1).stores({
      sessions: "id, characterId, updatedAt",
      messages: "id, sessionId, createdAt",
    });
  }
}

export interface NativeMigrationApplyStorageResult {
  created: MigrationRunJournal["created"];
  warnings: string[];
  failures: string[];
}

export interface NativeMigrationStorage {
  readonly kind: "production" | "isolated-browser";
  readSnapshot(plan: NativeMigrationPlan): Promise<NativeMigrationSnapshot>;
  applyCreates(
    plan: NativeMigrationPlan,
    reconciliation: NativeMigrationReconciliation,
    pkg: ReadFloatMigrationPackageSuccess,
  ): Promise<NativeMigrationApplyStorageResult>;
  rollbackCreated(journal: MigrationRunJournal): Promise<{ warnings: string[]; failures: string[] }>;
  saveJournal(journal: MigrationRunJournal): Promise<void>;
  readJournal(runId: string): Promise<MigrationRunJournal | null>;
  dispose?(): Promise<void>;
}

function ids<T>(values: T[], idOf: (value: T) => string): string[] {
  return values.map(idOf);
}

export class ProductionNativeMigrationStorage implements NativeMigrationStorage {
  readonly kind = "production" as const;

  private requireHydratedKv(): void {
    if (!isKvHydrated()) {
      throw new Error("Float KV storage must be hydrated before migration dry-run/apply");
    }
  }

  async saveJournal(journal: MigrationRunJournal): Promise<void> {
    await saveMigrationJournal(journal);
  }

  async readJournal(runId: string): Promise<MigrationRunJournal | null> {
    return loadMigrationJournals().find((entry) => entry.runId === runId) ?? null;
  }

  async readSnapshot(plan: NativeMigrationPlan): Promise<NativeMigrationSnapshot> {
    this.requireHydratedKv();
    const calendarStore = parseObject<{ plans?: CalendarWeekPlan[] }>(kvGet(CALENDAR_KEY));
    const settingsDb = new MigrationSettingsDatabase();
    const storyDb = new MigrationStoryDatabase();
    const [contacts, sessions, messages, storySessions, storyMessages, moments, momentComments, media, worldbooks] = await Promise.all([
      chatDb.contacts.toArray(),
      chatDb.sessions.toArray(),
      chatDb.messages.toArray(),
      storyDb.sessions.toArray(),
      storyDb.messages.toArray(),
      momentsDb.posts.toArray(),
      momentsDb.comments.toArray(),
      listMediaCacheSummaries(),
      settingsDb.worldBooks.toArray().catch(() => [] as WorldBookConfig[]),
    ]);
    settingsDb.close();
    storyDb.close();

    const memoryCharacterIds = [...new Set([
      ...plan.memories.map((entry) => entry.characterId),
      ...plan.memoryLinks.map((entry) => entry.characterId),
    ])];
    const memories: MemoryEntry[] = [];
    const memoryLinks: MemoryLink[] = [];
    for (const characterId of memoryCharacterIds) {
      memories.push(...await loadMemoryEntries(characterId));
      memoryLinks.push(...await loadMemoryLinks(characterId));
    }

    return {
      identities: parseArray<UserIdentity>(kvGet(IDENTITIES_KEY)),
      characters: parseArray<Character>(kvGet(CHARACTERS_KEY)),
      contacts,
      sessions,
      messages,
      storySessions,
      storyMessages,
      mediaIds: media.map((entry) => entry.id),
      moments,
      momentComments,
      diaries: parseArray<DiaryEntry>(kvGet(DIARY_KEY)),
      worlds: parseArray<CharacterWorldGroup>(kvGet(WORLDS_KEY)),
      worldbooks,
      calendar: Array.isArray(calendarStore?.plans) ? calendarStore.plans : [],
      memories,
      memoryLinks,
      archive: parseObject<NativeMigrationArchive>(kvGet(archiveKey(plan.sourceFingerprint))),
      idMap: parseObject<Record<string, Record<string, string>>>(kvGet(idMapKey(plan.sourceFingerprint))),
    };
  }

  async applyCreates(
    plan: NativeMigrationPlan,
    reconciliation: NativeMigrationReconciliation,
    pkg: ReadFloatMigrationPackageSuccess,
  ): Promise<NativeMigrationApplyStorageResult> {
    this.requireHydratedKv();
    const created: MigrationRunJournal["created"] = {};
    const warnings: string[] = [];
    const failures: string[] = [];
    const before = await this.readSnapshot(plan);

    const writeKvArray = async <T>(
      key: string,
      current: T[],
      additions: T[],
      domain: keyof typeof created,
      idOf: (value: T) => string,
    ): Promise<void> => {
      if (!additions.length) return;
      await kvSetAsync(key, JSON.stringify([...current, ...additions]));
      created[domain] = ids(additions, idOf);
    };

    try {
      await writeKvArray(IDENTITIES_KEY, before.identities, reconciliation.identities.create, "identities", (entry) => entry.id);
      await writeKvArray(CHARACTERS_KEY, before.characters, reconciliation.characters.create, "characters", (entry) => entry.id);

      if (reconciliation.contacts.create.length || reconciliation.sessions.create.length || reconciliation.messages.create.length) {
        await chatDb.transaction("rw", chatDb.contacts, chatDb.sessions, chatDb.messages, async () => {
          if (reconciliation.contacts.create.length) await chatDb.contacts.bulkPut(reconciliation.contacts.create);
          if (reconciliation.sessions.create.length) await chatDb.sessions.bulkPut(reconciliation.sessions.create);
          if (reconciliation.messages.create.length) await chatDb.messages.bulkPut(reconciliation.messages.create);
        });
        if (reconciliation.contacts.create.length) created.contacts = ids(reconciliation.contacts.create, (entry) => entry.id);
        if (reconciliation.sessions.create.length) created.sessions = ids(reconciliation.sessions.create, (entry) => entry.id);
        if (reconciliation.messages.create.length) created.messages = ids(reconciliation.messages.create, (entry) => entry.id);
      }

      if (reconciliation.storySessions.create.length || reconciliation.storyMessages.create.length) {
        const db = new MigrationStoryDatabase();
        await db.transaction("rw", db.sessions, db.messages, async () => {
          if (reconciliation.storySessions.create.length) await db.sessions.bulkPut(reconciliation.storySessions.create);
          if (reconciliation.storyMessages.create.length) await db.messages.bulkPut(reconciliation.storyMessages.create);
        });
        if (reconciliation.storySessions.create.length) created.storySessions = ids(reconciliation.storySessions.create, (entry) => entry.id);
        if (reconciliation.storyMessages.create.length) created.storyMessages = ids(reconciliation.storyMessages.create, (entry) => entry.id);
        db.close();
      }

      if (reconciliation.media.create.length) {
        const db = new MigrationMediaDatabase();
        const rows: MediaCacheEntry[] = [];
        for (const media of reconciliation.media.create) {
          const bytes = await pkg.getAssetBytes(media.sourceAssetId);
          if (!bytes) {
            failures.push(`asset bytes unavailable for ${media.sourceAssetId}`);
            continue;
          }
          const mimeType = media.source.mediaType || "application/octet-stream";
          rows.push({
            id: media.targetId,
            blob: blobFromBytes(bytes, mimeType),
            mimeType,
            mediaCategory: mediaCategory(mimeType),
            createdAt: Date.parse(plan.manifest.createdAt),
          });
        }
        if (rows.length) {
          await db.entries.bulkPut(rows);
          created.media = rows.map((row) => row.id);
        }
        db.close();
      }

      if (reconciliation.moments.create.length || reconciliation.momentComments.create.length) {
        await momentsDb.transaction("rw", momentsDb.posts, momentsDb.comments, async () => {
          if (reconciliation.moments.create.length) await momentsDb.posts.bulkPut(reconciliation.moments.create);
          if (reconciliation.momentComments.create.length) await momentsDb.comments.bulkPut(reconciliation.momentComments.create);
        });
        if (reconciliation.moments.create.length) created.moments = ids(reconciliation.moments.create, (entry) => entry.id);
        if (reconciliation.momentComments.create.length) created.momentComments = ids(reconciliation.momentComments.create, (entry) => entry.id);
      }

      await writeKvArray(DIARY_KEY, before.diaries, reconciliation.diaries.create, "diaries", (entry) => entry.id);
      await writeKvArray(WORLDS_KEY, before.worlds, reconciliation.worlds.create, "worlds", (entry) => entry.id);

      if (reconciliation.worldbooks.create.length) {
        const db = new MigrationSettingsDatabase();
        await db.worldBooks.bulkPut(reconciliation.worldbooks.create);
        db.close();
        created.worldbooks = ids(reconciliation.worldbooks.create, (entry) => entry.id);
      }

      if (reconciliation.calendar.create.length) {
        await kvSetAsync(CALENDAR_KEY, JSON.stringify({ plans: [...before.calendar, ...reconciliation.calendar.create] }));
        created.calendar = ids(reconciliation.calendar.create, (entry) => entry.id);
      }

      if (reconciliation.memories.create.length) {
        await saveMemoryEntries(reconciliation.memories.create, {
          suppressMemoryLinkLifecycle: true,
          strictDurability: true,
        });
        created.memories = ids(reconciliation.memories.create, (entry) => entry.id);
      }
      if (reconciliation.memoryLinks.create.length) {
        await saveMemoryLinks(reconciliation.memoryLinks.create, { strictDurability: true });
        created.memoryLinks = ids(reconciliation.memoryLinks.create, (entry) => entry.id);
      }

      if (reconciliation.archive === "create") {
        const key = archiveKey(plan.sourceFingerprint);
        await kvSetAsync(key, JSON.stringify(plan.archive));
        created.archive = [key];
      }
      if (reconciliation.idMap === "create") {
        const key = idMapKey(plan.sourceFingerprint);
        await kvSetAsync(key, JSON.stringify(reconciliation.resolvedIdMap));
        created.idMap = [key];
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "unknown native storage write failure");
    }

    return { created, warnings, failures };
  }

  async rollbackCreated(journal: MigrationRunJournal): Promise<{ warnings: string[]; failures: string[] }> {
    this.requireHydratedKv();
    const warnings: string[] = [];
    const failures: string[] = [];

    const removeFromKvArray = async <T extends { id: string }>(key: string, idsToRemove: string[]): Promise<void> => {
      if (!idsToRemove.length) return;
      const remove = new Set(idsToRemove);
      await kvSetAsync(key, JSON.stringify(parseArray<T>(kvGet(key)).filter((entry) => !remove.has(entry.id))));
    };

    try {
      await removeFromKvArray<UserIdentity>(IDENTITIES_KEY, journal.created.identities ?? []);
      await removeFromKvArray<Character>(CHARACTERS_KEY, journal.created.characters ?? []);

      if ((journal.created.contacts?.length ?? 0) || (journal.created.sessions?.length ?? 0) || (journal.created.messages?.length ?? 0)) {
        await chatDb.transaction("rw", chatDb.contacts, chatDb.sessions, chatDb.messages, async () => {
          if (journal.created.contacts?.length) await chatDb.contacts.bulkDelete(journal.created.contacts);
          if (journal.created.sessions?.length) await chatDb.sessions.bulkDelete(journal.created.sessions);
          if (journal.created.messages?.length) await chatDb.messages.bulkDelete(journal.created.messages);
        });
      }

      if ((journal.created.storySessions?.length ?? 0) || (journal.created.storyMessages?.length ?? 0)) {
        const db = new MigrationStoryDatabase();
        await db.transaction("rw", db.sessions, db.messages, async () => {
          if (journal.created.storyMessages?.length) await db.messages.bulkDelete(journal.created.storyMessages);
          if (journal.created.storySessions?.length) await db.sessions.bulkDelete(journal.created.storySessions);
        });
        db.close();
      }

      if (journal.created.media?.length) {
        const db = new MigrationMediaDatabase();
        await db.entries.bulkDelete(journal.created.media);
        db.close();
      }

      if ((journal.created.moments?.length ?? 0) || (journal.created.momentComments?.length ?? 0)) {
        await momentsDb.transaction("rw", momentsDb.posts, momentsDb.comments, async () => {
          if (journal.created.moments?.length) await momentsDb.posts.bulkDelete(journal.created.moments);
          if (journal.created.momentComments?.length) await momentsDb.comments.bulkDelete(journal.created.momentComments);
        });
      }

      await removeFromKvArray<DiaryEntry>(DIARY_KEY, journal.created.diaries ?? []);
      await removeFromKvArray<CharacterWorldGroup>(WORLDS_KEY, journal.created.worlds ?? []);

      if (journal.created.worldbooks?.length) {
        const db = new MigrationSettingsDatabase();
        await db.worldBooks.bulkDelete(journal.created.worldbooks);
        db.close();
      }

      if (journal.created.calendar?.length) {
        const remove = new Set(journal.created.calendar);
        const store = parseObject<{ plans?: CalendarWeekPlan[] }>(kvGet(CALENDAR_KEY));
        await kvSetAsync(CALENDAR_KEY, JSON.stringify({ plans: (store?.plans ?? []).filter((entry) => !remove.has(entry.id)) }));
      }

      if (journal.created.memoryLinks?.length) {
        await deleteMemoryLinks(journal.created.memoryLinks);
      }
      if (journal.created.memories?.length) {
        await deleteMemoryEntriesWithoutLinkCleanup(journal.created.memories);
      }

      const durableKv = new MigrationKvDatabase();
      for (const key of [...(journal.created.archive ?? []), ...(journal.created.idMap ?? [])]) {
        kvRemove(key);
        await durableKv.entries.delete(key);
      }
      durableKv.close();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "unknown rollback failure");
    }

    return { warnings, failures };
  }
}

// This adapter is intentionally self-contained and never opens an AiPhone* database.
class IsolatedMigrationDatabase extends Dexie {
  identities!: Table<UserIdentity, string>;
  characters!: Table<Character, string>;
  contacts!: Table<ChatContact, string>;
  sessions!: Table<ChatSession, string>;
  messages!: Table<ChatMessage, string>;
  storySessions!: Table<StorySession, string>;
  storyMessages!: Table<StoryMessage, string>;
  media!: Table<MediaCacheEntry, string>;
  moments!: Table<MomentPost, string>;
  momentComments!: Table<MomentComment, string>;
  diaries!: Table<DiaryEntry, string>;
  worlds!: Table<CharacterWorldGroup, string>;
  worldbooks!: Table<WorldBookConfig, string>;
  calendar!: Table<CalendarWeekPlan, string>;
  memories!: Table<MemoryEntry, string>;
  memoryLinks!: Table<MemoryLink, string>;
  meta!: Table<{ key: string; value: string }, string>;

  constructor(name: string) {
    super(name);
    this.version(1).stores({
      identities: "id",
      characters: "id",
      contacts: "id, characterId",
      sessions: "id, contactId",
      messages: "id, sessionId, createdAt",
      storySessions: "id, characterId, updatedAt",
      storyMessages: "id, sessionId, createdAt",
      media: "id, createdAt",
      moments: "id, authorId, createdAt",
      momentComments: "id, postId, createdAt",
      diaries: "id, characterId, createdAt",
      worlds: "id",
      worldbooks: "id",
      calendar: "id, ownerId, weekStart",
      memories: "id, characterId, type",
      memoryLinks: "id, characterId, fromMemoryId, toMemoryId, type",
      meta: "key",
    });
  }
}

export class IsolatedBrowserNativeMigrationStorage implements NativeMigrationStorage {
  readonly kind = "isolated-browser" as const;
  readonly databaseName: string;
  private readonly db: IsolatedMigrationDatabase;

  constructor(namespace: string) {
    const safe = namespace.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "test";
    this.databaseName = `FloatMigrationIsolation_${safe}`;
    this.db = new IsolatedMigrationDatabase(this.databaseName);
  }

  async seedForIntegration(snapshot: Partial<NativeMigrationSnapshot>): Promise<void> {
    if (snapshot.identities?.length) await this.db.identities.bulkPut(snapshot.identities);
    if (snapshot.characters?.length) await this.db.characters.bulkPut(snapshot.characters);
    if (snapshot.contacts?.length) await this.db.contacts.bulkPut(snapshot.contacts);
    if (snapshot.sessions?.length) await this.db.sessions.bulkPut(snapshot.sessions);
    if (snapshot.messages?.length) await this.db.messages.bulkPut(snapshot.messages);
    if (snapshot.storySessions?.length) await this.db.storySessions.bulkPut(snapshot.storySessions);
    if (snapshot.storyMessages?.length) await this.db.storyMessages.bulkPut(snapshot.storyMessages);
    if (snapshot.moments?.length) await this.db.moments.bulkPut(snapshot.moments);
    if (snapshot.momentComments?.length) await this.db.momentComments.bulkPut(snapshot.momentComments);
    if (snapshot.diaries?.length) await this.db.diaries.bulkPut(snapshot.diaries);
    if (snapshot.worlds?.length) await this.db.worlds.bulkPut(snapshot.worlds);
    if (snapshot.worldbooks?.length) await this.db.worldbooks.bulkPut(snapshot.worldbooks);
    if (snapshot.calendar?.length) await this.db.calendar.bulkPut(snapshot.calendar);
    if (snapshot.memories?.length) await this.db.memories.bulkPut(snapshot.memories);
    if (snapshot.memoryLinks?.length) await this.db.memoryLinks.bulkPut(snapshot.memoryLinks);
  }

  async saveJournal(journal: MigrationRunJournal): Promise<void> {
    await this.db.meta.put({ key: `journal:${journal.runId}`, value: JSON.stringify(journal) });
  }

  async readJournal(runId: string): Promise<MigrationRunJournal | null> {
    const row = await this.db.meta.get(`journal:${runId}`);
    return row ? JSON.parse(row.value) as MigrationRunJournal : null;
  }

  async readSnapshot(plan: NativeMigrationPlan): Promise<NativeMigrationSnapshot> {
    const [
      identities, characters, contacts, sessions, messages, storySessions, storyMessages, media, moments, momentComments,
      diaries, worlds, worldbooks, calendar, memories, memoryLinks, archiveRow, idMapRow,
    ] = await Promise.all([
      this.db.identities.toArray(),
      this.db.characters.toArray(),
      this.db.contacts.toArray(),
      this.db.sessions.toArray(),
      this.db.messages.toArray(),
      this.db.storySessions.toArray(),
      this.db.storyMessages.toArray(),
      this.db.media.toArray(),
      this.db.moments.toArray(),
      this.db.momentComments.toArray(),
      this.db.diaries.toArray(),
      this.db.worlds.toArray(),
      this.db.worldbooks.toArray(),
      this.db.calendar.toArray(),
      this.db.memories.toArray(),
      this.db.memoryLinks.toArray(),
      this.db.meta.get(archiveKey(plan.sourceFingerprint)),
      this.db.meta.get(idMapKey(plan.sourceFingerprint)),
    ]);

    return {
      identities,
      characters,
      contacts,
      sessions,
      messages,
      storySessions,
      storyMessages,
      mediaIds: media.map((entry) => entry.id),
      moments,
      momentComments,
      diaries,
      worlds,
      worldbooks,
      calendar,
      memories,
      memoryLinks,
      archive: archiveRow ? JSON.parse(archiveRow.value) as NativeMigrationArchive : undefined,
      idMap: idMapRow ? JSON.parse(idMapRow.value) as Record<string, Record<string, string>> : undefined,
    };
  }

  async applyCreates(
    plan: NativeMigrationPlan,
    reconciliation: NativeMigrationReconciliation,
    pkg: ReadFloatMigrationPackageSuccess,
  ): Promise<NativeMigrationApplyStorageResult> {
    const created: MigrationRunJournal["created"] = {};
    const warnings: string[] = [];
    const failures: string[] = [];

    try {
      await this.db.transaction(
        "rw",
        [
          this.db.identities, this.db.characters, this.db.contacts, this.db.sessions, this.db.messages,
          this.db.storySessions, this.db.storyMessages,
          this.db.moments, this.db.momentComments, this.db.diaries, this.db.worlds, this.db.worldbooks,
          this.db.calendar, this.db.memories, this.db.memoryLinks, this.db.meta,
        ],
        async () => {
          const put = async <T extends { id: string }>(table: Table<T, string>, values: T[], domain: keyof typeof created): Promise<void> => {
            if (!values.length) return;
            await table.bulkPut(values);
            created[domain] = values.map((entry) => entry.id);
          };

          await put(this.db.identities, reconciliation.identities.create, "identities");
          await put(this.db.characters, reconciliation.characters.create, "characters");
          await put(this.db.contacts, reconciliation.contacts.create, "contacts");
          await put(this.db.sessions, reconciliation.sessions.create, "sessions");
          await put(this.db.messages, reconciliation.messages.create, "messages");
          await put(this.db.storySessions, reconciliation.storySessions.create, "storySessions");
          await put(this.db.storyMessages, reconciliation.storyMessages.create, "storyMessages");
          await put(this.db.moments, reconciliation.moments.create, "moments");
          await put(this.db.momentComments, reconciliation.momentComments.create, "momentComments");
          await put(this.db.diaries, reconciliation.diaries.create, "diaries");
          await put(this.db.worlds, reconciliation.worlds.create, "worlds");
          await put(this.db.worldbooks, reconciliation.worldbooks.create, "worldbooks");
          await put(this.db.calendar, reconciliation.calendar.create, "calendar");
          await put(this.db.memories, reconciliation.memories.create, "memories");
          await put(this.db.memoryLinks, reconciliation.memoryLinks.create, "memoryLinks");

          if (reconciliation.archive === "create") {
            const key = archiveKey(plan.sourceFingerprint);
            await this.db.meta.put({ key, value: JSON.stringify(plan.archive) });
            created.archive = [key];
          }
          if (reconciliation.idMap === "create") {
            const key = idMapKey(plan.sourceFingerprint);
            await this.db.meta.put({ key, value: JSON.stringify(reconciliation.resolvedIdMap) });
            created.idMap = [key];
          }
        },
      );

      if (reconciliation.media.create.length) {
        const rows: MediaCacheEntry[] = [];
        for (const media of reconciliation.media.create) {
          const bytes = await pkg.getAssetBytes(media.sourceAssetId);
          if (!bytes) {
            failures.push(`asset bytes unavailable for ${media.sourceAssetId}`);
            continue;
          }
          const mimeType = media.source.mediaType || "application/octet-stream";
          rows.push({
            id: media.targetId,
            blob: blobFromBytes(bytes, mimeType),
            mimeType,
            mediaCategory: mediaCategory(mimeType),
            createdAt: Date.parse(plan.manifest.createdAt),
          });
        }
        if (rows.length) {
          await this.db.media.bulkPut(rows);
          created.media = rows.map((entry) => entry.id);
        }
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "isolated browser apply failed");
    }

    return { created, warnings, failures };
  }

  async rollbackCreated(journal: MigrationRunJournal): Promise<{ warnings: string[]; failures: string[] }> {
    const failures: string[] = [];

    try {
      await this.db.transaction(
        "rw",
        [
          this.db.identities, this.db.characters, this.db.contacts, this.db.sessions, this.db.messages,
          this.db.storySessions, this.db.storyMessages,
          this.db.media, this.db.moments, this.db.momentComments, this.db.diaries, this.db.worlds,
          this.db.worldbooks, this.db.calendar, this.db.memories, this.db.memoryLinks, this.db.meta,
        ],
        async () => {
          const del = async <T>(table: Table<T, string>, values?: string[]): Promise<void> => {
            if (values?.length) await table.bulkDelete(values);
          };

          await del(this.db.identities, journal.created.identities);
          await del(this.db.characters, journal.created.characters);
          await del(this.db.contacts, journal.created.contacts);
          await del(this.db.sessions, journal.created.sessions);
          await del(this.db.messages, journal.created.messages);
          await del(this.db.storyMessages, journal.created.storyMessages);
          await del(this.db.storySessions, journal.created.storySessions);
          await del(this.db.media, journal.created.media);
          await del(this.db.moments, journal.created.moments);
          await del(this.db.momentComments, journal.created.momentComments);
          await del(this.db.diaries, journal.created.diaries);
          await del(this.db.worlds, journal.created.worlds);
          await del(this.db.worldbooks, journal.created.worldbooks);
          await del(this.db.calendar, journal.created.calendar);
          await del(this.db.memoryLinks, journal.created.memoryLinks);
          await del(this.db.memories, journal.created.memories);

          for (const key of [...(journal.created.archive ?? []), ...(journal.created.idMap ?? [])]) {
            await this.db.meta.delete(key);
          }
        },
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : "isolated browser rollback failed");
    }

    return { warnings: [], failures };
  }

  async dispose(): Promise<void> {
    this.db.close();
    await Dexie.delete(this.databaseName);
  }
}

export const migrationStorageKeys = { archiveKey, idMapKey };
