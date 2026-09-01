import type { ChatMessage, ChatMessageRole } from "../../chat-storage";
import type { StoryMessage, StoryMessageRole, StorySession } from "../../story-storage";
import type { CalendarColorKey, CalendarScheduleItem, CalendarWeekPlan } from "../../calendar-types";
import type { MemoryEntry, MemoryKind, MemoryMood, CognitiveRoom, FutureIntentMeta } from "../../memory-types";
import type { MigrationAssetRef, MigrationFutureIntent, MigrationMoment, MigrationWorldbook } from "../format/types";
import { deterministicNativeId, deterministicWechatId } from "./id";
import type {
  NativeCharacterImport,
  NativeIdentityImport,
  NativeMediaImport,
  NativeMigrationPlan,
} from "./types";
import { mapNativeMemoryLinks } from "./memory-links";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
function iso(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}
function dateNumber(value: unknown, fallback: string): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return Date.parse(value);
  return Date.parse(fallback);
}
function plainText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try { return JSON.stringify(value); } catch { return String(value); }
}
function mapRole(role: string): ChatMessageRole {
  return role === "user" || role === "assistant" || role === "system" ? role : "system";
}
function isOfflineStoryMessage(message: { sourceMetadata?: Record<string, unknown> }): boolean {
  return message.sourceMetadata?.source === "date";
}
function mapStoryRole(role: string, migrationId: string): StoryMessageRole {
  if (role === "user" || role === "assistant") return role;
  throw new Error(`Sully offline RP mapping stopped: ${migrationId} has unsupported role ${role}`);
}
function safeImportance(value: unknown): number {
  const number = asNumber(value);
  if (number === undefined) return 0.5;
  const normalized = number > 1 ? number / 10 : number;
  return Math.max(0, Math.min(1, normalized));
}

const MEMORY_MOODS = new Set<MemoryMood>([
  "neutral", "happy", "tender", "excited", "sad", "angry", "anxious", "afraid", "jealous", "embarrassed", "lonely", "nostalgic",
]);
const MEMORY_KINDS = new Set<MemoryKind>(["event", "relationship", "user_fact", "self_fact", "knowledge", "future_intent"]);
const COGNITIVE_ROOMS = new Set<CognitiveRoom>(["living_room", "bedroom", "study", "user_room", "self_room", "attic", "windowsill"]);

function targetAssetId(sourceFingerprint: string, assetId: string): string {
  return deterministicNativeId("media", sourceFingerprint, assetId);
}
function targetMediaRef(sourceFingerprint: string, assetId: string): string {
  return `media-store://${targetAssetId(sourceFingerprint, assetId)}`;
}
function firstAssetId(refs: MigrationAssetRef[] | undefined): string | undefined {
  return refs?.find((entry) => !entry.missing)?.assetId;
}

function getSourceCharacterMigrationId(
  sourceId: string | undefined,
  sourceIdMap: Record<string, Record<string, string>>,
): string | undefined {
  if (!sourceId) return undefined;
  return sourceIdMap.characters?.[sourceId];
}

function chatPreview(message: ChatMessage, sourceType?: string): string {
  if (message.mediaType === "image") return message.content ? `[图片] ${message.content}` : "[图片]";
  if (message.mediaType === "app_card") return `[${sourceType || "历史卡片"}]${message.content ? ` ${message.content.slice(0, 80)}` : ""}`;
  return message.content.slice(0, 120);
}

function mapMessageRichType(
  sourceFingerprint: string,
  messageType: string | undefined,
  content: string,
  media: MigrationAssetRef[] | undefined,
  sourceMetadata: Record<string, unknown> | undefined,
): Pick<ChatMessage, "mediaType" | "mediaUrl" | "mediaData"> {
  const asset = media?.find((entry) => !entry.missing);
  if (messageType === "image") {
    return {
      mediaType: "image",
      ...(asset ? { mediaUrl: targetMediaRef(sourceFingerprint, asset.assetId) } : {}),
      mediaData: {
        label: content || undefined,
        ...(asset?.fileName ? { fileName: asset.fileName } : {}),
      },
    };
  }
  if (!messageType || messageType === "text") return {};
  return {
    mediaType: "app_card",
    mediaData: {
      appId: "sully-migration",
      appName: "Sully Migration",
      appCardTitle: messageType,
      appCardBody: content,
      appCardSummary: content.slice(0, 160),
      appCardLayout: {
        sourceMessageType: messageType,
        ...(sourceMetadata ? { sourceMetadata } : {}),
        ...(asset ? { sourceAssetId: asset.assetId, mediaRef: targetMediaRef(sourceFingerprint, asset.assetId) } : {}),
      },
    },
  };
}

function commentAuthor(
  raw: Record<string, unknown>,
  sourceIdMap: Record<string, Record<string, string>>,
  characterTargets: Map<string, string>,
): { authorType: "user" | "character" | "npc"; authorId: string; authorName?: string } {
  const sourceCharId = asString(raw.authorCharId);
  const canonicalRef = getSourceCharacterMigrationId(sourceCharId, sourceIdMap);
  const nativeCharId = canonicalRef ? characterTargets.get(canonicalRef) : undefined;
  if ((raw.isCharacter === true || raw.authorType === "character") && nativeCharId) {
    return { authorType: "character", authorId: nativeCharId, authorName: asString(raw.authorName) };
  }
  if (raw.authorType === "user") return { authorType: "user", authorId: "user", authorName: asString(raw.authorName) };
  const name = asString(raw.authorName) ?? "Sully 用户";
  return { authorType: "npc", authorId: deterministicNativeId("moment_npc", "sully", name), authorName: name };
}

function aggregateLikes(moment: MigrationMoment): number | undefined {
  let total = 0;
  let found = false;
  for (const raw of moment.likes ?? []) {
    if (typeof raw === "number" && Number.isFinite(raw)) { total += raw; found = true; continue; }
    if (isRecord(raw) && typeof raw.count === "number" && Number.isFinite(raw.count)) { total += raw.count; found = true; }
  }
  if (!found && typeof moment.metadata?.likes === "number" && Number.isFinite(moment.metadata.likes)) {
    total = moment.metadata.likes;
    found = true;
  }
  return found ? total : undefined;
}

function explicitUserLiked(moment: MigrationMoment): boolean {
  return moment.metadata?.isLiked === true;
}

function mondayOf(dateText: string): string {
  const parsed = new Date(`${dateText}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return dateText;
  const day = parsed.getUTCDay();
  const delta = day === 0 ? -6 : 1 - day;
  parsed.setUTCDate(parsed.getUTCDate() + delta);
  return parsed.toISOString().slice(0, 10);
}
function weekdayLabel(dateText: string): string {
  const labels = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const parsed = new Date(`${dateText}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? "" : labels[parsed.getUTCDay()];
}
function addMinutes(time: string, minutes: number): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return "23:59";
  const value = Math.min(23 * 60 + 59, Math.max(0, Number(match[1]) * 60 + Number(match[2]) + minutes));
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}
function calendarColor(index: number): CalendarColorKey {
  const colors: CalendarColorKey[] = ["blue", "green", "amber", "rose", "violet", "teal", "slate", "lilac"];
  return colors[index % colors.length];
}

function mapWorldBook(
  sourceFingerprint: string,
  createdAt: string,
  record: MigrationWorldbook,
): import("../../settings-types").WorldBookConfig {
  const settings = record.settings ?? {};
  const id = deterministicNativeId("worldbook", sourceFingerprint, record.migrationId);
  const entryId = deterministicNativeId("worldbook_entry", sourceFingerprint, record.migrationId);
  return {
    id,
    name: record.title || "Sully WorldBook",
    description: asString(settings.category) || undefined,
    createdAt: dateNumber(settings.createdAt, createdAt),
    updatedAt: dateNumber(settings.updatedAt, createdAt),
    entries: [{
      uid: entryId,
      key: (record.keys ?? []).join(","),
      content: record.content ?? "",
      comment: record.title ?? "",
      use_regex: false,
      disable: settings.disable === true,
      constant: settings.constant === true,
      position: typeof settings.position === "number" ? settings.position : 0,
      ...(typeof settings.depth === "number" ? { depth: settings.depth } : {}),
      ...(typeof settings.probability === "number" ? { probability: settings.probability } : {}),
      ...(typeof settings.useProbability === "boolean" ? { useProbability: settings.useProbability } : {}),
      ...(typeof settings.role === "number" ? { role: settings.role } : {}),
      insertion_order: typeof settings.order === "number" ? settings.order : 100,
    }],
  };
}

function futureIntentMeta(intent: MigrationFutureIntent): FutureIntentMeta {
  const status = intent.status === "fulfilled" || intent.status === "cancelled" ? intent.status : "pending";
  return {
    type: "plan",
    status,
    timePrecision: intent.timePrecision,
    ...(intent.timeExpression ? { originalTimeExpression: intent.timeExpression } : {}),
  };
}

export function buildNativeMigrationPlan(
  manifest: import("../format/types").FloatMigrationManifest,
  payload: import("../format/types").FloatMigrationPackagePayload,
  assets: MigrationAssetRef[],
): NativeMigrationPlan {
  const sourceFingerprint = manifest.source.backupFingerprint;
  const fallbackTime = manifest.createdAt;
  const warnings: string[] = [];
  const nativeIdMap: Record<string, Record<string, string>> = {};
  const setMap = (bucket: string, sourceId: string, targetId: string): string => {
    (nativeIdMap[bucket] ??= {})[sourceId] = targetId;
    return targetId;
  };

  const media: NativeMediaImport[] = assets.filter((asset) => !asset.missing).map((asset) => {
    const targetId = setMap("assets", asset.assetId, targetAssetId(sourceFingerprint, asset.assetId));
    return { sourceAssetId: asset.assetId, targetId, targetRef: `media-store://${targetId}`, source: asset };
  });

  const identities: NativeIdentityImport[] = payload.identities
    .filter((identity) => identity.kind === "user")
    .map((identity) => {
      const id = setMap("identities", identity.migrationId, deterministicNativeId("identity", sourceFingerprint, identity.migrationId));
      return {
        sourceMigrationId: identity.migrationId,
        value: {
          id,
          name: identity.displayName || "Sully 用户",
          bio: asString(identity.metadata?.bio) ?? "",
          gender: "",
          age: "",
          occupation: "",
          customSettings: "",
        },
        ...(identity.avatar?.assetId ? { avatarAssetId: identity.avatar.assetId } : {}),
      };
    });

  const characters: NativeCharacterImport[] = payload.characters.map((character) => {
    const id = setMap("characters", character.migrationId, deterministicNativeId("character", sourceFingerprint, character.migrationId));
    const meta = character.metadata ?? {};
    return {
      sourceMigrationId: character.migrationId,
      value: {
        id,
        name: character.displayName || "Sully Character",
        avatar: null,
        persona: character.persona ?? "",
        ...(typeof character.personality === "string" && character.personality.trim() ? { personality: character.personality } : {}),
        ...(character.timezone ? { timeZone: character.timezone } : {}),
        tags: [],
        wechatID: deterministicWechatId(sourceFingerprint, character.migrationId),
        createdAt: iso(meta.createdAt, fallbackTime),
        updatedAt: iso(meta.updatedAt ?? meta.createdAt, fallbackTime),
      },
      ...(character.avatar?.assetId ? { avatarAssetId: character.avatar.assetId } : {}),
    };
  });
  const characterTargets = new Map(characters.map((entry) => [entry.sourceMigrationId, entry.value.id]));
  const characterNames = new Map(characters.map((entry) => [entry.value.id, entry.value.name]));

  const conversationById = new Map(payload.conversations.map((conversation) => [conversation.migrationId, conversation]));
  const sourceCharacterRef = (message: typeof payload.messages[number]): string | undefined =>
    message.characterRef ?? (message.conversationRef ? conversationById.get(message.conversationRef)?.characterRef : undefined);
  const storySourceMessages = payload.messages.filter(isOfflineStoryMessage);
  const unresolvedStoryMessages = storySourceMessages.filter((message) => {
    const sourceRef = sourceCharacterRef(message);
    return !sourceRef || !characterTargets.has(sourceRef);
  });
  if (unresolvedStoryMessages.length) {
    const details = unresolvedStoryMessages.slice(0, 10).map((message) => message.migrationId).join(", ");
    throw new Error(`Sully offline RP mapping stopped: ${unresolvedStoryMessages.length} messages have no resolvable character (${details})`);
  }

  const storyMessagesByCharacter = new Map<string, typeof payload.messages>();
  for (const message of storySourceMessages) {
    const sourceRef = sourceCharacterRef(message)!;
    const list = storyMessagesByCharacter.get(sourceRef) ?? [];
    list.push(message);
    storyMessagesByCharacter.set(sourceRef, list);
  }
  for (const list of storyMessagesByCharacter.values()) {
    list.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.migrationId.localeCompare(b.migrationId));
  }

  const sourceMessagesByConversation = new Map<string, typeof payload.messages>();
  const chatSourceMessages = payload.messages.filter((message) => !isOfflineStoryMessage(message));
  for (const message of chatSourceMessages) {
    if (!message.conversationRef) continue;
    const list = sourceMessagesByConversation.get(message.conversationRef) ?? [];
    list.push(message);
    sourceMessagesByConversation.set(message.conversationRef, list);
  }
  for (const list of sourceMessagesByConversation.values()) list.sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.migrationId.localeCompare(b.migrationId));

  const contacts = [] as NativeMigrationPlan["contacts"];
  const sessions = [] as NativeMigrationPlan["sessions"];
  const sessionByConversation = new Map<string, string>();
  for (const conversation of payload.conversations) {
    const list = sourceMessagesByConversation.get(conversation.migrationId) ?? [];
    if (!list.length) continue;
    const sourceCharacter = conversation.characterRef ?? list[0]?.characterRef;
    const characterId = sourceCharacter ? characterTargets.get(sourceCharacter) : undefined;
    if (!characterId) {
      warnings.push(`conversation ${conversation.migrationId} has no resolvable character; its Chat messages will be skipped`);
      continue;
    }
    const resolvedSourceCharacter = sourceCharacter!;
    const contactId = setMap("contacts", resolvedSourceCharacter, deterministicNativeId("contact", sourceFingerprint, resolvedSourceCharacter));
    const sessionId = setMap("sessions", conversation.migrationId, deterministicNativeId("session", sourceFingerprint, conversation.migrationId));
    sessionByConversation.set(conversation.migrationId, sessionId);
    const earliest = list[0]?.createdAt ?? conversation.startedAt ?? fallbackTime;
    const latest = list[list.length - 1]?.createdAt ?? conversation.endedAt ?? earliest;
    contacts.push({ id: contactId, characterId, addedAt: iso(earliest, fallbackTime) });
    sessions.push({
      id: sessionId,
      contactId: characterId,
      unreadCount: 0,
      updatedAt: iso(latest, fallbackTime),
      isPinned: false,
      bilingualTranslationEnabled: true,
      collapseBilingualTranslation: true,
    });
  }

  const storySessions: StorySession[] = [];
  const storySessionByCharacter = new Map<string, string>();
  for (const sourceCharacter of [...storyMessagesByCharacter.keys()].sort()) {
    const characterId = characterTargets.get(sourceCharacter);
    if (!characterId) continue;
    const sourceMessages = storyMessagesByCharacter.get(sourceCharacter)!;
    const sessionId = setMap("storySessions", sourceCharacter, deterministicNativeId("story_session", sourceFingerprint, sourceCharacter));
    storySessionByCharacter.set(sourceCharacter, sessionId);
    const latest = sourceMessages[sourceMessages.length - 1];
    const latestCreatedAt = iso(latest?.createdAt, fallbackTime);
    storySessions.push({
      id: sessionId,
      characterId,
      title: "Sully 线下剧情",
      updatedAt: latestCreatedAt,
      lastMessageId: setMap("storyMessages", latest.migrationId, deterministicNativeId("story_message", sourceFingerprint, latest.migrationId)),
      lastMessagePreview: (latest.content ?? "").slice(0, 120),
    });
  }

  const orderBySession = new Map<string, number>();
  const messages: ChatMessage[] = [];
  const sourceMessageType = new Map<string, string | undefined>();
  for (const source of chatSourceMessages) {
    const sessionId = source.conversationRef ? sessionByConversation.get(source.conversationRef) : undefined;
    if (!sessionId) continue;
    const id = setMap("messages", source.migrationId, deterministicNativeId("message", sourceFingerprint, source.migrationId));
    const order = orderBySession.get(sessionId) ?? 0;
    orderBySession.set(sessionId, order + 1);
    const content = source.content ?? "";
    const rich = mapMessageRichType(sourceFingerprint, source.messageType, content, source.media, source.sourceMetadata);
    const message: ChatMessage = {
      id,
      sessionId,
      role: mapRole(source.role),
      content,
      status: "sent",
      createdAt: iso(source.createdAt, fallbackTime),
      order,
      ...rich,
    };
    messages.push(message);
    sourceMessageType.set(id, source.messageType);
  }
  const storyMessages: StoryMessage[] = [];
  for (const source of storySourceMessages) {
    const sourceCharacter = sourceCharacterRef(source)!;
    const sessionId = storySessionByCharacter.get(sourceCharacter);
    if (!sessionId) continue;
    const id = setMap("storyMessages", source.migrationId, deterministicNativeId("story_message", sourceFingerprint, source.migrationId));
    storyMessages.push({
      id,
      sessionId,
      role: mapStoryRole(source.role, source.migrationId),
      rawContent: source.content ?? "",
      createdAt: iso(source.createdAt, fallbackTime),
    });
  }
  const messagesBySession = new Map<string, ChatMessage[]>();
  for (const message of messages) {
    const list = messagesBySession.get(message.sessionId) ?? [];
    list.push(message);
    messagesBySession.set(message.sessionId, list);
  }
  for (const session of sessions) {
    const list = messagesBySession.get(session.id) ?? [];
    const last = list[list.length - 1];
    if (!last) continue;
    session.lastMessageId = last.id;
    session.lastMessagePreview = chatPreview(last, sourceMessageType.get(last.id));
    session.updatedAt = last.createdAt;
  }

  const allCharacterIds = characters.map((entry) => entry.value.id);
  const moments: NativeMigrationPlan["moments"] = [];
  const momentComments: NativeMigrationPlan["momentComments"] = [];
  const momentSourceMetadata: NativeMigrationPlan["archive"]["momentSourceMetadata"] = [];
  for (const moment of payload.moments) {
    const id = setMap("moments", moment.migrationId, deterministicNativeId("moment", sourceFingerprint, moment.migrationId));
    const authorId = moment.authorRef ? characterTargets.get(moment.authorRef) : undefined;
    const postTime = iso(moment.createdAt, fallbackTime);
    const explicitLiked = explicitUserLiked(moment);
    const assetId = firstAssetId(moment.images);
    moments.push({
      id,
      authorType: authorId ? "character" : "user",
      authorId: authorId ?? "user",
      content: moment.content ?? "",
      ...(assetId ? { photoUrl: targetMediaRef(sourceFingerprint, assetId) } : {}),
      visibility: allCharacterIds,
      likes: explicitLiked ? [{ authorType: "user", authorId: "user", createdAt: postTime }] : [],
      createdAt: postTime,
    });
    const sourceComments = Array.isArray(moment.comments) ? moment.comments : [];
    sourceComments.forEach((raw, index) => {
      if (!isRecord(raw)) return;
      const author = commentAuthor(raw, payload.provenance.idMap, characterTargets);
      const sourceCommentId = asString(raw.id) ?? `${moment.migrationId}:comment:${index}`;
      const commentId = setMap("momentComments", sourceCommentId, deterministicNativeId("moment_comment", sourceFingerprint, `${moment.migrationId}:${sourceCommentId}`));
      const sourceCreatedAt = raw.createdAt ?? raw.timestamp;
      if (sourceCreatedAt === undefined) warnings.push(`moment comment ${sourceCommentId} has no source timestamp; anchored to parent post`);
      momentComments.push({
        id: commentId,
        postId: id,
        ...author,
        content: plainText(raw.content),
        createdAt: iso(sourceCreatedAt, postTime),
      });
    });
    momentSourceMetadata.push({
      momentMigrationId: moment.migrationId,
      aggregateLikes: aggregateLikes(moment),
      explicitUserLiked: explicitLiked,
      sourceLikes: moment.likes,
      sourceMetadata: moment.metadata,
    });
  }

  const diaries: NativeMigrationPlan["diaries"] = [];
  const diaryUserPages: NativeMigrationPlan["archive"]["diaryUserPages"] = [];
  for (const diary of payload.diaries) {
    const sourceCharId = asString(diary.metadata?.charId);
    const canonicalCharRef = getSourceCharacterMigrationId(sourceCharId, payload.provenance.idMap);
    const characterId = canonicalCharRef ? characterTargets.get(canonicalCharRef) : undefined;
    if (!characterId) {
      warnings.push(`diary ${diary.migrationId} has no resolvable character; character page kept in archive only`);
    } else {
      const body = isRecord(diary.characterContent) ? plainText(diary.characterContent.text) : plainText(diary.characterContent);
      const createdAt = iso(diary.createdAt, diary.date ? `${diary.date}T00:00:00.000Z` : fallbackTime);
      const id = setMap("diaries", diary.migrationId, deterministicNativeId("diary", sourceFingerprint, diary.migrationId));
      diaries.push({
        id,
        characterId,
        characterName: characterNames.get(characterId) ?? "角色",
        title: diary.date ? `${diary.date} 手记` : "Sully 手记",
        dateLabel: diary.date ? diary.date.replace(/-/g, ".") : createdAt.slice(0, 10).replace(/-/g, "."),
        mood: "",
        weather: "",
        tags: [],
        body,
        blocks: body ? body.split(/\n{2,}/).filter(Boolean).map((text) => ({ type: "paragraph" as const, text })) : [],
        trigger: "manual",
        createdAt,
        updatedAt: createdAt,
      });
    }
    if (diary.userContent !== undefined) diaryUserPages.push({ diaryMigrationId: diary.migrationId, userContent: diary.userContent, metadata: diary.metadata });
  }

  const worlds: NativeMigrationPlan["worlds"] = payload.worlds.map((world) => {
    const id = setMap("worlds", world.migrationId, deterministicNativeId("world", sourceFingerprint, world.migrationId));
    const sourceMemberIds = Array.isArray(world.metadata?.memberIds) ? world.metadata!.memberIds as unknown[] : [];
    const memberIds = sourceMemberIds
      .map((entry) => getSourceCharacterMigrationId(asString(entry), payload.provenance.idMap))
      .map((entry) => entry ? characterTargets.get(entry) : undefined)
      .filter((entry): entry is string => Boolean(entry));
    const createdAt = iso(world.metadata?.createdAt, fallbackTime);
    return {
      id,
      name: world.title || "Sully World",
      description: plainText(world.content),
      memberIds,
      relations: [],
      createdAt,
      updatedAt: iso(world.metadata?.updatedAt, createdAt),
    };
  });

  const unsupportedRelationships: NativeMigrationPlan["archive"]["unsupportedRelationships"] = [];
  for (const relationship of payload.relationships) {
    const state = isRecord(relationship.state) ? relationship.state : {};
    const label = asString(state.label);
    const fromRef = asString(state.fromRef) ?? relationship.characterRef;
    const toRef = asString(state.toRef);
    const fromId = fromRef ? characterTargets.get(fromRef) : undefined;
    const toId = toRef ? characterTargets.get(toRef) : undefined;
    if (!label || !fromId || !toId || fromId === toId || worlds.length === 0) {
      unsupportedRelationships.push(relationship);
      continue;
    }
    const world = worlds.find((entry) => entry.memberIds.includes(fromId) && entry.memberIds.includes(toId));
    if (!world) { unsupportedRelationships.push(relationship); continue; }
    world.relations.push({
      id: setMap("relationships", relationship.migrationId, deterministicNativeId("world_relation", sourceFingerprint, relationship.migrationId)),
      fromCharacterId: fromId,
      toCharacterId: toId,
      label,
    });
  }

  const worldbooks = payload.worldbooks.map((record) => {
    const value = mapWorldBook(sourceFingerprint, fallbackTime, record);
    setMap("worldbooks", record.migrationId, value.id);
    return value;
  });

  const calendarByPlanKey = new Map<string, CalendarWeekPlan>();
  for (const schedule of payload.schedules) {
    const ownerId = schedule.characterRef ? characterTargets.get(schedule.characterRef) : undefined;
    if (!ownerId || !schedule.date) {
      warnings.push(`schedule ${schedule.migrationId} cannot be projected to native calendar`);
      continue;
    }
    const content = isRecord(schedule.content) ? schedule.content : {};
    const slots = Array.isArray(content.slots) ? content.slots.filter(isRecord) : [];
    const weekStart = mondayOf(schedule.date);
    const planKey = `${ownerId}\u0000${weekStart}`;
    let plan = calendarByPlanKey.get(planKey);
    if (!plan) {
      plan = {
        id: deterministicNativeId("calendar_week", sourceFingerprint, planKey),
        ownerType: "character",
        ownerId,
        weekStart,
        items: [],
        updatedAt: iso(schedule.metadata?.generatedAt, fallbackTime),
      };
      calendarByPlanKey.set(planKey, plan);
    }
    slots.forEach((slot, index) => {
      const startTime = asString(slot.startTime);
      if (!startTime) return;
      const nextStart = index + 1 < slots.length ? asString(slots[index + 1].startTime) : undefined;
      const endTime = nextStart && nextStart > startTime ? nextStart : addMinutes(startTime, 60);
      const timestamp = iso(schedule.metadata?.generatedAt, fallbackTime);
      const item: CalendarScheduleItem = {
        id: deterministicNativeId("calendar_item", sourceFingerprint, `${schedule.migrationId}:${index}`),
        date: schedule.date!,
        weekday: weekdayLabel(schedule.date!),
        startTime,
        endTime,
        location: "",
        title: asString(slot.activity) ?? asString(slot.description) ?? "Sully 日程",
        ...(asString(slot.emoji) ? { emoji: asString(slot.emoji) } : {}),
        colorKey: calendarColor(index),
        source: "generated",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      plan!.items.push(item);
      if (timestamp > plan!.updatedAt) plan!.updatedAt = timestamp;
    });
  }
  const calendar = [...calendarByPlanKey.values()]
    .map((plan) => ({ ...plan, items: plan.items.sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime)) }))
    .sort((a, b) => a.ownerId.localeCompare(b.ownerId) || a.weekStart.localeCompare(b.weekStart));
  for (const plan of calendar) setMap("calendar", plan.id, plan.id);

  const sourceMemoryById = new Map(payload.memories.map((memory) => [memory.migrationId, memory]));
  const intentByMemory = new Map<string, MigrationFutureIntent>();
  for (const intent of payload.futureIntents) if (intent.sourceMemoryRef) intentByMemory.set(intent.sourceMemoryRef, intent);
  const archivedMemories = payload.memories.filter((memory) => memory.archived === true);
  const activeMemories = payload.memories.filter((memory) => memory.archived !== true);
  const archivedFutureIntents = payload.futureIntents
    .filter((intent) => intent.sourceMemoryRef && sourceMemoryById.get(intent.sourceMemoryRef)?.archived === true)
    .map((intent) => ({ intent, sourceMemory: intent.sourceMemoryRef ? sourceMemoryById.get(intent.sourceMemoryRef) : undefined }));
  const activeIntentIds = new Set(payload.futureIntents
    .filter((intent) => intent.sourceMemoryRef && sourceMemoryById.get(intent.sourceMemoryRef)?.archived !== true)
    .map((intent) => intent.sourceMemoryRef as string));

  const memories: MemoryEntry[] = [];
  for (const memory of activeMemories) {
    const characterId = memory.characterRef ? characterTargets.get(memory.characterRef) : undefined;
    if (!characterId) {
      warnings.push(`memory ${memory.migrationId} has no resolvable character and was not activated`);
      continue;
    }
    const id = setMap("memories", memory.migrationId, deterministicNativeId("memory", sourceFingerprint, memory.migrationId));
    const sourceMood = asString(memory.mood);
    const metadataKind = asString(memory.metadata?.kind);
    const intent = activeIntentIds.has(memory.migrationId) ? intentByMemory.get(memory.migrationId) : undefined;
    const createdAt = iso(memory.createdAt, fallbackTime);
    const entry: MemoryEntry = {
      id,
      characterId,
      sourceApp: "chat",
      type: "long_term",
      content: memory.content,
      importance: safeImportance(memory.importance),
      createdAt,
      updatedAt: iso(memory.metadata?.updatedAt, createdAt),
      ...(memory.tags?.length ? { tags: memory.tags } : {}),
      ...(sourceMood && MEMORY_MOODS.has(sourceMood as MemoryMood) ? { mood: sourceMood as MemoryMood } : {}),
      ...(intent ? { kind: "future_intent", futureIntent: futureIntentMeta(intent) } : metadataKind && MEMORY_KINDS.has(metadataKind as MemoryKind) ? { kind: metadataKind as MemoryKind } : {}),
      ...(memory.accessCount !== undefined ? { accessCount: memory.accessCount } : {}),
      ...(memory.lastAccessedAt ? { lastAccessedAt: iso(memory.lastAccessedAt, createdAt) } : {}),
      ...(memory.room && COGNITIVE_ROOMS.has(memory.room as CognitiveRoom) ? { cognitiveRoom: memory.room as CognitiveRoom } : {}),
      metadata: {
        migrationSource: "sully",
        migrationId: memory.migrationId,
        sourceOriginalId: memory.sourceOriginalId,
        archived: false,
        ...(sourceMood && !MEMORY_MOODS.has(sourceMood as MemoryMood) ? { sourceMood } : {}),
        ...(memory.valence !== undefined ? { valence: memory.valence } : {}),
        ...(memory.arousal !== undefined ? { arousal: memory.arousal } : {}),
        ...(memory.origin !== undefined ? { origin: memory.origin } : {}),
        ...(memory.eventBoxRef ? { eventBoxRef: memory.eventBoxRef } : {}),
        ...(memory.metadata ?? {}),
        ...(intent ? { sourceFutureIntent: intent, migrationFutureIntentStatus: intent.status ?? "unknown" } : {}),
      },
    };
    memories.push(entry);
  }

  const activeMemoryBySourceId = new Map<string, { source: typeof activeMemories[number]; nativeId: string; characterId: string }>();
  for (const entry of memories) {
    if (entry.type !== "long_term") continue;
    const sourceId = asString(entry.metadata?.migrationId);
    const source = sourceId ? sourceMemoryById.get(sourceId) : undefined;
    const terminalFutureIntent = entry.futureIntent?.status === "fulfilled" || entry.futureIntent?.status === "cancelled";
    if (source && source.archived !== true && !terminalFutureIntent) {
      activeMemoryBySourceId.set(source.migrationId, { source, nativeId: entry.id, characterId: entry.characterId });
    }
  }
  const memoryLinkMapping = mapNativeMemoryLinks(
    payload.memoryLinks,
    payload.memories,
    activeMemoryBySourceId,
    sourceFingerprint,
    fallbackTime,
    deterministicNativeId,
  );
  for (const [sourceId, targetId] of Object.entries(memoryLinkMapping.sourceIdMap)) setMap("memoryLinks", sourceId, targetId);

  const legacy = Array.isArray(payload.extended.legacyCharacterMemories) ? payload.extended.legacyCharacterMemories : [];
  let legacyCoreMemoryCount = 0;
  legacy.forEach((raw, index) => {
    if (!isRecord(raw) || !isRecord(raw.memory)) return;
    const sourceCharId = asString(raw.characterSourceId);
    const canonicalCharRef = getSourceCharacterMigrationId(sourceCharId, payload.provenance.idMap);
    const characterId = canonicalCharRef ? characterTargets.get(canonicalCharRef) : undefined;
    const summary = asString(raw.memory.summary);
    if (!characterId || !summary) return;
    const sourceId = asString(raw.memory.id) ?? `${sourceCharId ?? "character"}:${index}`;
    const id = deterministicNativeId("core_memory", sourceFingerprint, sourceId);
    setMap("coreMemories", sourceId, id);
    const date = asString(raw.memory.date);
    const createdAt = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00.000Z` : fallbackTime;
    memories.push({
      id,
      characterId,
      sourceApp: "chat",
      type: "core",
      content: summary,
      importance: 1,
      createdAt,
      updatedAt: createdAt,
      metadata: { migrationSource: "sully", legacyCoreSummary: true, sourceRecord: raw.memory },
    });
    legacyCoreMemoryCount += 1;
  });

  const activeFutureIntentCount = activeMemories.filter((memory) => activeIntentIds.has(memory.migrationId)).length;
  const archivedWindowsillCount = archivedMemories.filter((memory) => memory.room === "windowsill").length;

  const archive: NativeMigrationPlan["archive"] = {
    archivedMemories,
    archivedFutureIntents,
    memoryLinks: payload.memoryLinks,
    unsupportedRelationships,
    diaryUserPages,
    momentSourceMetadata,
    messageSourceMetadata: payload.messages
      .filter((message) => message.messageType !== "text" || (message.sourceMetadata && Object.keys(message.sourceMetadata).length > 0))
      .map((message) => ({ messageMigrationId: message.migrationId, messageType: message.messageType, sourceMetadata: message.sourceMetadata })),
    scheduleSource: payload.schedules,
    eventBoxes: payload.eventBoxes,
    stories: payload.stories,
    games: payload.games,
    extended: payload.extended,
    compat: payload.compat,
    provenance: payload.provenance,
  };

  const verifiedRealFingerprint = "sha256:0bae3c5f57ba5cb0246c58e735674670ee39b5e3fe7aa17805fd51695a29fcba";
  if (sourceFingerprint === verifiedRealFingerprint) {
    if (activeMemories.length !== 250) warnings.push(`expected 250 active Memory Palace nodes for the verified Sully backup; observed ${activeMemories.length}`);
    if (archivedMemories.length !== 147) warnings.push(`expected 147 archived Memory Palace nodes for the verified Sully backup; observed ${archivedMemories.length}`);
    if (activeFutureIntentCount !== 4) warnings.push(`expected 4 active Future Intent candidates for the verified Sully backup; observed ${activeFutureIntentCount}`);
    if (archivedWindowsillCount !== 5) warnings.push(`expected 5 archived windowsill memories for the verified Sully backup; observed ${archivedWindowsillCount}`);
  }

  return {
    manifest,
    sourceFingerprint,
    identities,
    characters,
    contacts,
    sessions,
    messages,
    storySessions,
    storyMessages,
    media,
    moments,
    momentComments,
    diaries,
    worlds,
    worldbooks,
    calendar,
    memories,
    memoryLinks: memoryLinkMapping.links,
    memoryLinkAudit: memoryLinkMapping.audit,
    activeMemoryPalaceCount: activeMemories.length,
    legacyCoreMemoryCount,
    activeFutureIntentCount,
    archivedWindowsillCount,
    archive,
    idMap: nativeIdMap,
    warnings,
    timelineRecords: [],
  };
}
