import type {
  FloatMigrationManifest,
  FloatMigrationPackagePayload,
  MigrationAssetRef,
  MigrationCharacter,
  MigrationConversation,
  MigrationDiary,
  MigrationEventBox,
  MigrationFutureIntent,
  MigrationGame,
  MigrationIdentity,
  MigrationMemory,
  MigrationMemoryLink,
  MigrationMessage,
  MigrationMoment,
  MigrationRelationship,
  MigrationSchedule,
  MigrationSourceRef,
  MigrationStory,
  MigrationWorld,
  MigrationWorldbook,
} from "../format/types";
import type { SullyMigrationIdMap, SullyV3ParseSuccess } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value.filter((entry): entry is string => typeof entry === "string");
  return result.length ? result : undefined;
}

function iso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return undefined;
}

function sourceRef(parsed: SullyV3ParseSuccess, store?: string, originalId?: string): MigrationSourceRef {
  return {
    platform: "sully",
    backupFormat: "sully_v3",
    backupFormatVersion: 3,
    backupFingerprint: parsed.fingerprint,
    ...(store ? { store } : {}),
    ...(originalId ? { originalId } : {}),
  };
}

function safeIdPart(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.slice(0, 96) || "unknown";
}

function mapped(map: SullyMigrationIdMap, collection: string, sourceId: string): string {
  const bucket = map[collection] ?? (map[collection] = {});
  return bucket[sourceId] ?? (bucket[sourceId] = `mig_${collection}_${safeIdPart(sourceId)}`);
}

function recordId(record: unknown, fallback: string): string {
  if (isRecord(record)) return asString(record.id) ?? fallback;
  return fallback;
}

function records(parsed: SullyV3ParseSuccess, store: string): Record<string, unknown>[] {
  return (parsed.stores[store]?.records ?? []).filter(isRecord);
}

function basename(path: string): string {
  return path.replace(/\\/g, "/").split("/").pop() || "asset.bin";
}

function extension(path: string): string {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index) : "";
}

function assetRefForSourcePath(parsed: SullyV3ParseSuccess, map: SullyMigrationIdMap, path: string): MigrationAssetRef | undefined {
  const descriptor = parsed.assets.find((entry) => entry.sourcePath === path || entry.sourceOriginalId === path);
  if (!descriptor) return undefined;
  const sourceId = descriptor.sourceOriginalId;
  const assetId = mapped(map, "assets", sourceId);
  const fileName = basename(descriptor.sourcePath);
  return {
    assetId,
    sourceOriginalId: sourceId,
    mediaType: descriptor.mediaType,
    fileName,
    byteLength: descriptor.byteLength,
    packagePath: descriptor.missing ? undefined : `assets/files/${safeIdPart(assetId)}${extension(fileName)}`,
    missing: descriptor.missing,
    source: sourceRef(parsed, descriptor.kind === "blob" ? "blobs" : "assets", sourceId),
  };
}

function assetRefsFromUnknown(parsed: SullyV3ParseSuccess, map: SullyMigrationIdMap, value: unknown): MigrationAssetRef[] | undefined {
  const found = new Map<string, MigrationAssetRef>();
  const visit = (current: unknown) => {
    if (typeof current === "string") {
      if (current.startsWith("assets/")) {
        const ref = assetRefForSourcePath(parsed, map, current);
        if (ref) found.set(ref.assetId, ref);
      } else if (current.startsWith("blobref:")) {
        const id = current.slice("blobref:".length);
        const ref = assetRefForSourcePath(parsed, map, id);
        if (ref) found.set(ref.assetId, ref);
      }
      return;
    }
    if (Array.isArray(current)) { for (const entry of current) visit(entry); return; }
    if (isRecord(current)) for (const entry of Object.values(current)) visit(entry);
  };
  visit(value);
  return found.size ? [...found.values()] : undefined;
}

function role(value: unknown): MigrationMessage["role"] {
  return value === "user" || value === "assistant" || value === "system" ? value : "other";
}

function futureCue(content: string): string | undefined {
  const patterns = [
    /下周[一二三四五六日天]?/,
    /周[一二三四五六日天]/,
    /明天|后天|今晚|明晚|明早|以后|到时候|等[^，。；]{0,12}(?:再|就)/,
    /\b20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/,
    /(?:计划|打算|准备|约好|答应|承诺|期待|想要|要去|要做|安排)/,
  ];
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) return match[0];
  }
  return undefined;
}

function futurePrecision(expression: string | undefined): MigrationFutureIntent["timePrecision"] {
  if (!expression) return "unknown";
  if (/^20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(expression)) return "day";
  return "vague";
}

const CHARACTER_RUNTIME_KEYS = new Set([
  "savedRoomState", "lastRoomDate", "phoneState", "vrState", "spriteConfig", "savedDateState", "activeBuffs",
]);

function characterMetadata(record: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (["id", "name", "avatar", "description", "systemPrompt", "memories"].includes(key)) continue;
    if (CHARACTER_RUNTIME_KEYS.has(key)) continue;
    output[key] = value;
  }
  if (Array.isArray(record.memories) && record.memories.length) output.legacyMemories = record.memories;
  if (typeof record.description === "string") output.description = record.description;
  return output;
}

export interface NormalizeSullyPackageOptions {
  packageId: string;
  createdAt: string;
  userProfile?: Record<string, unknown>;
  metadataRedactions?: string[];
}

export interface NormalizedSullyPackage {
  manifest: FloatMigrationManifest;
  payload: FloatMigrationPackagePayload;
  assetRefs: MigrationAssetRef[];
}

export function normalizeSullyV3ToMigrationPackage(parsed: SullyV3ParseSuccess, options: NormalizeSullyPackageOptions): NormalizedSullyPackage {
  const idMap: SullyMigrationIdMap = {
    characters: {}, messages: {}, moments: {}, memories: {}, assets: {}, diaries: {}, worlds: {}, worldbooks: {}, stories: {}, games: {}, schedules: {}, eventBoxes: {},
  };

  const assetRefs = parsed.assets.map((descriptor) => {
    const assetId = mapped(idMap, "assets", descriptor.sourceOriginalId);
    const fileName = basename(descriptor.sourcePath);
    return {
      assetId,
      sourceOriginalId: descriptor.sourceOriginalId,
      mediaType: descriptor.mediaType,
      fileName,
      byteLength: descriptor.byteLength,
      packagePath: descriptor.missing ? undefined : `assets/files/${safeIdPart(assetId)}${extension(fileName)}`,
      missing: descriptor.missing,
      source: sourceRef(parsed, descriptor.kind === "blob" ? "blobs" : "assets", descriptor.sourceOriginalId),
    } satisfies MigrationAssetRef;
  });

  const userSourceId = asString(options.userProfile?.id) ?? "me";
  const userAvatar = typeof options.userProfile?.avatar === "string" ? assetRefForSourcePath(parsed, idMap, options.userProfile.avatar) : undefined;
  const identities: MigrationIdentity[] = options.userProfile ? [{
    migrationId: mapped(idMap, "identities", userSourceId),
    kind: "user",
    displayName: asString(options.userProfile.name),
    avatar: userAvatar,
    source: sourceRef(parsed, "metadata.userProfile", userSourceId),
    metadata: {
      ...(typeof options.userProfile.bio === "string" ? { bio: options.userProfile.bio } : {}),
    },
  }] : [];

  const characters: MigrationCharacter[] = records(parsed, "characters").map((record, index) => {
    const originalId = recordId(record, `character-${index}`);
    return {
      migrationId: mapped(idMap, "characters", originalId),
      kind: "character",
      displayName: asString(record.name),
      avatar: typeof record.avatar === "string" ? assetRefForSourcePath(parsed, idMap, record.avatar) : undefined,
      persona: asString(record.description),
      systemPrompt: asString(record.systemPrompt),
      personality: record.personalityStyle ?? record.personality ?? record.ruminationTendency,
      source: sourceRef(parsed, "characters", originalId),
      metadata: characterMetadata(record),
    };
  });

  const characterBySource = new Map(Object.entries(idMap.characters));
  const conversationSourceIds = new Set<string>();
  for (const message of records(parsed, "messages")) if (asString(message.charId)) conversationSourceIds.add(String(message.charId));
  const conversations: MigrationConversation[] = [...conversationSourceIds].map((sourceId) => ({
    migrationId: mapped(idMap, "conversations", sourceId),
    characterRef: characterBySource.get(sourceId),
    title: records(parsed, "characters").find((entry) => asString(entry.id) === sourceId)?.name as string | undefined,
    source: sourceRef(parsed, "messages", sourceId),
  }));

  for (const message of records(parsed, "messages")) {
    const originalId = asString(message.id);
    if (originalId) mapped(idMap, "messages", originalId);
  }
  const messages: MigrationMessage[] = records(parsed, "messages").map((record, index) => {
    const originalId = recordId(record, `message-${index}`);
    const sourceCharId = asString(record.charId);
    const replyId = isRecord(record.replyTo) ? asString(record.replyTo.id) : asString(record.replyTo);
    return {
      migrationId: mapped(idMap, "messages", originalId),
      sourceOriginalId: originalId,
      characterRef: sourceCharId ? idMap.characters[sourceCharId] : undefined,
      conversationRef: sourceCharId ? mapped(idMap, "conversations", sourceCharId) : undefined,
      role: role(record.role),
      content: asString(record.content),
      messageType: asString(record.type),
      media: assetRefsFromUnknown(parsed, idMap, { content: record.content, metadata: record.metadata }),
      createdAt: iso(record.timestamp ?? record.createdAt),
      replyTo: replyId ? idMap.messages[replyId] ?? mapped(idMap, "messages", replyId) : undefined,
      source: sourceRef(parsed, "messages", originalId),
      sourceMetadata: {
        ...(isRecord(record.metadata) ? record.metadata : {}),
        ...(isRecord(record.replyTo) ? { replySnapshot: record.replyTo } : {}),
      },
    };
  }).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "") || a.migrationId.localeCompare(b.migrationId));

  const moments: MigrationMoment[] = records(parsed, "socialPosts").map((record, index) => {
    const originalId = recordId(record, `moment-${index}`);
    const authorCharId = asString(record.authorCharId);
    const imageRefs = assetRefsFromUnknown(parsed, idMap, record.images);
    return {
      migrationId: mapped(idMap, "moments", originalId),
      authorRef: authorCharId ? idMap.characters[authorCharId] : undefined,
      content: [asString(record.title), asString(record.content)].filter(Boolean).join("\n\n") || undefined,
      images: imageRefs,
      likes: Array.isArray(record.likes) ? record.likes : record.likes !== undefined ? [{ count: record.likes }] : undefined,
      comments: Array.isArray(record.comments) ? record.comments : undefined,
      createdAt: iso(record.timestamp ?? record.createdAt),
      source: sourceRef(parsed, "socialPosts", originalId),
      metadata: {
        ...Object.fromEntries(Object.entries(record).filter(([key]) => !["id", "content", "images", "comments", "timestamp"].includes(key))),
        ...(record.images !== undefined ? { sourceImages: record.images } : {}),
      },
    };
  });

  const diaries: MigrationDiary[] = records(parsed, "diaries").map((record, index) => {
    const originalId = recordId(record, `diary-${index}`);
    return {
      migrationId: mapped(idMap, "diaries", originalId),
      date: asString(record.date),
      userContent: record.userPage,
      characterContent: record.charPage,
      createdAt: iso(record.timestamp ?? record.createdAt),
      source: sourceRef(parsed, "diaries", originalId),
      metadata: Object.fromEntries(Object.entries(record).filter(([key]) => !["id", "date", "userPage", "charPage", "timestamp"].includes(key))),
    };
  });

  const worlds: MigrationWorld[] = records(parsed, "worlds").map((record, index) => {
    const originalId = recordId(record, `world-${index}`);
    return {
      migrationId: mapped(idMap, "worlds", originalId),
      title: asString(record.name ?? record.title),
      content: record.worldview ?? record.content,
      source: sourceRef(parsed, "worlds", originalId),
      metadata: Object.fromEntries(Object.entries(record).filter(([key]) => !["id", "name", "title", "worldview", "content", "relationships"].includes(key))),
    };
  });

  const relationships: MigrationRelationship[] = [];
  for (const world of records(parsed, "worlds")) {
    if (!Array.isArray(world.relationships)) continue;
    const worldId = asString(world.id) ?? "world";
    for (const [index, rel] of world.relationships.entries()) {
      if (!isRecord(rel)) continue;
      const from = asString(rel.fromId);
      const to = asString(rel.toId);
      relationships.push({
        migrationId: mapped(idMap, "relationships", `${worldId}:${index}:${from ?? "?"}:${to ?? "?"}`),
        characterRef: from ? idMap.characters[from] : undefined,
        state: { ...rel, fromRef: from ? idMap.characters[from] : undefined, toRef: to ? idMap.characters[to] : undefined },
        source: sourceRef(parsed, "worlds.relationships", `${worldId}:${index}`),
      });
    }
  }

  const worldbooks: MigrationWorldbook[] = records(parsed, "worldbooks").map((record, index) => {
    const originalId = recordId(record, `worldbook-${index}`);
    const primaryKeys = typeof record.key === "string" ? record.key.split(/[,，|]/).map((v) => v.trim()).filter(Boolean) : [];
    const secondaryKeys = typeof record.keysecondary === "string" ? record.keysecondary.split(/[,，|]/).map((v) => v.trim()).filter(Boolean) : [];
    return {
      migrationId: mapped(idMap, "worldbooks", originalId),
      title: asString(record.title),
      content: asString(record.content),
      keys: [...new Set([...primaryKeys, ...secondaryKeys])],
      source: sourceRef(parsed, "worldbooks", originalId),
      settings: Object.fromEntries(Object.entries(record).filter(([key]) => !["id", "title", "content", "key", "keysecondary"].includes(key))),
    };
  });

  const stories: MigrationStory[] = [];
  const storyStores: Array<[string, string]> = [
    ["worldEpisodes", "world_episode"], ["vrNovels", "vr_novel"], ["vrAnnotations", "vr_annotation"], ["vrLetters", "vr_letter"], ["vrScripts", "vr_script"], ["vrStagedPlays", "vr_staged_play"],
  ];
  for (const [store, kind] of storyStores) {
    for (const [index, record] of records(parsed, store).entries()) {
      const originalId = recordId(record, `${store}-${index}`);
      stories.push({
        migrationId: mapped(idMap, "stories", `${store}:${originalId}`),
        kind,
        title: asString(record.title ?? record.name ?? record.authorName),
        content: record,
        createdAt: iso(record.createdAt ?? record.timestamp ?? record.sentAt),
        source: sourceRef(parsed, store, originalId),
      });
    }
  }

  const games: MigrationGame[] = records(parsed, "games").map((record, index) => {
    const originalId = recordId(record, `game-${index}`);
    return {
      migrationId: mapped(idMap, "games", originalId),
      kind: asString(record.theme),
      title: asString(record.title),
      state: record,
      createdAt: iso(record.createdAt),
      source: sourceRef(parsed, "games", originalId),
    };
  });

  const schedules: MigrationSchedule[] = records(parsed, "dailySchedules").map((record, index) => {
    const originalId = recordId(record, `schedule-${index}`);
    const charId = asString(record.charId);
    return {
      migrationId: mapped(idMap, "schedules", originalId),
      characterRef: charId ? idMap.characters[charId] : undefined,
      date: asString(record.date),
      content: { slots: record.slots, flowNarrative: record.flowNarrative },
      source: sourceRef(parsed, "dailySchedules", originalId),
      metadata: { generatedAt: iso(record.generatedAt) },
    };
  });

  const eventBoxSourceIds = new Set(records(parsed, "eventBoxes").map((entry, index) => recordId(entry, `event-box-${index}`)));
  for (const [index, record] of records(parsed, "memoryNodes").entries()) {
    mapped(idMap, "memories", recordId(record, `memory-${index}`));
  }
  const memories: MigrationMemory[] = records(parsed, "memoryNodes").map((record, index) => {
    const originalId = recordId(record, `memory-${index}`);
    const charId = asString(record.charId);
    const boxId = asString(record.eventBoxId ?? record.boxId);
    return {
      migrationId: mapped(idMap, "memories", originalId),
      sourceOriginalId: originalId,
      characterRef: charId ? idMap.characters[charId] : undefined,
      content: asString(record.content) ?? "",
      tags: asStringArray(record.tags),
      importance: typeof record.importance === "number" ? record.importance : undefined,
      mood: record.mood,
      room: asString(record.room),
      createdAt: iso(record.createdAt),
      lastAccessedAt: iso(record.lastAccessedAt),
      accessCount: typeof record.accessCount === "number" ? record.accessCount : undefined,
      origin: record.origin,
      eventBoxRef: boxId && eventBoxSourceIds.has(boxId) ? mapped(idMap, "eventBoxes", boxId) : undefined,
      valence: typeof record.valence === "number" ? record.valence : undefined,
      arousal: typeof record.arousal === "number" ? record.arousal : undefined,
      archived: typeof record.archived === "boolean" ? record.archived : undefined,
      source: sourceRef(parsed, "memoryNodes", originalId),
      metadata: {
        ...Object.fromEntries(Object.entries(record).filter(([key]) => !["id", "charId", "content", "tags", "importance", "mood", "room", "createdAt", "lastAccessedAt", "accessCount", "origin", "eventBoxId", "boxId", "valence", "arousal", "archived", "embedded"].includes(key))),
        ...(boxId && !eventBoxSourceIds.has(boxId) ? { sourceBoxId: boxId } : {}),
      },
    };
  });

  const futureIntents: MigrationFutureIntent[] = [];
  for (const memory of memories) {
    if (memory.room !== "windowsill") continue;
    const expression = futureCue(memory.content);
    if (!expression) continue;
    futureIntents.push({
      migrationId: mapped(idMap, "futureIntents", memory.sourceOriginalId ?? memory.migrationId),
      characterRef: memory.characterRef,
      content: memory.content,
      timeExpression: expression,
      timePrecision: futurePrecision(expression),
      status: "unknown",
      sourceMemoryRef: memory.migrationId,
      source: sourceRef(parsed, "memoryNodes", memory.sourceOriginalId),
      metadata: { sourceRoom: "windowsill" },
    });
  }

  const eventBoxes: MigrationEventBox[] = records(parsed, "eventBoxes").map((record, index) => {
    const originalId = recordId(record, `event-box-${index}`);
    const charId = asString(record.charId);
    const mapMemoryRefs = (value: unknown) => Array.isArray(value) ? value.map(asString).filter(Boolean).map((id) => idMap.memories[id as string] ?? mapped(idMap, "memories", id as string)) : undefined;
    const predecessor = asString(record.predecessorId ?? record.predecessor);
    return {
      migrationId: mapped(idMap, "eventBoxes", originalId),
      characterRef: charId ? idMap.characters[charId] : undefined,
      name: asString(record.name),
      tags: asStringArray(record.tags),
      summary: asString(record.summary),
      liveMemoryRefs: mapMemoryRefs(record.liveMemoryIds),
      archiveMemoryRefs: mapMemoryRefs(record.archivedMemoryIds),
      predecessorRef: predecessor ? mapped(idMap, "eventBoxes", predecessor) : undefined,
      createdAt: iso(record.createdAt),
      updatedAt: iso(record.updatedAt),
      source: sourceRef(parsed, "eventBoxes", originalId),
      metadata: {
        ...Object.fromEntries(Object.entries(record).filter(([key]) => !["id", "charId", "name", "tags", "summary", "liveMemoryIds", "archivedMemoryIds", "predecessorId", "predecessor", "createdAt", "updatedAt"].includes(key))),
        ...(asString(record.summaryNodeId) ? { summaryMemoryRef: idMap.memories[asString(record.summaryNodeId) as string] ?? mapped(idMap, "memories", asString(record.summaryNodeId) as string) } : {}),
      },
    };
  });

  const memoryLinks: MigrationMemoryLink[] = records(parsed, "memoryLinks").map((record, index) => {
    const originalId = recordId(record, `memory-link-${index}`);
    const from = asString(record.sourceId ?? record.fromId) ?? "unknown";
    const to = asString(record.targetId ?? record.toId) ?? "unknown";
    const charId = asString(record.charId);
    return {
      migrationId: mapped(idMap, "memoryLinks", originalId),
      characterRef: charId ? idMap.characters[charId] : undefined,
      fromMemoryRef: idMap.memories[from] ?? mapped(idMap, "memories", from),
      toMemoryRef: idMap.memories[to] ?? mapped(idMap, "memories", to),
      type: asString(record.type) ?? "unknown",
      weight: typeof record.strength === "number" ? record.strength : typeof record.weight === "number" ? record.weight : undefined,
      createdAt: iso(record.createdAt),
      source: sourceRef(parsed, "memoryLinks", originalId),
      metadata: Object.fromEntries(Object.entries(record).filter(([key]) => !["id", "charId", "sourceId", "targetId", "fromId", "toId", "type", "strength", "weight", "createdAt"].includes(key))),
    };
  });

  const extended = {
    lifeRecords: records(parsed, "lifeRecords"),
    roomNotes: records(parsed, "roomNotes"),
    roomTodos: records(parsed, "roomTodos"),
    galleryImages: records(parsed, "galleryImages").map((entry) => ({ ...entry, media: assetRefsFromUnknown(parsed, idMap, entry) })),
    legacyCharacterMemories: records(parsed, "characters").flatMap((entry) => Array.isArray(entry.memories) ? entry.memories.map((memory) => ({ characterSourceId: asString(entry.id), memory })) : []),
  };

  const compat = parsed.compat
    .filter((entry) => parsed.stores[entry.store]?.classification !== "sensitive-config")
    .filter((entry) => entry.store !== "assets")
    .filter((entry) => entry.records.length > 0)
    .map((entry) => ({ store: entry.store, records: entry.records }));

  const payload: FloatMigrationPackagePayload = {
    identities, characters, relationships, conversations, messages, moments, diaries, worlds, worldbooks, stories, games, schedules, eventBoxes, memories, futureIntents, memoryLinks, extended, compat,
    provenance: {
      idMap,
      normalizationReport: parsed.report,
      sourceManifest: parsed.manifest,
      metadataRedactions: options.metadataRedactions ?? [],
      excludedSensitiveStores: Object.fromEntries(Object.entries(parsed.stores).filter(([, value]) => value.classification === "sensitive-config").map(([name, value]) => [name, value.parsedCount])),
      excludedRuntimeStores: { ...(parsed.stores.assets?.parsedCount ? { assets: parsed.stores.assets.parsedCount } : {}) },
    },
  };

  const counts: Record<string, number> = {
    identities: identities.length,
    characters: characters.length,
    relationships: relationships.length,
    conversations: conversations.length,
    messages: messages.length,
    moments: moments.length,
    diaries: diaries.length,
    worlds: worlds.length,
    worldbooks: worldbooks.length,
    stories: stories.length,
    games: games.length,
    schedules: schedules.length,
    eventBoxes: eventBoxes.length,
    memories: memories.length,
    futureIntents: futureIntents.length,
    memoryLinks: memoryLinks.length,
    compatStores: compat.length,
  };
  const manifest: FloatMigrationManifest = {
    format: "float_migration",
    formatVersion: 1,
    packageId: options.packageId,
    source: { platform: "sully", format: "sully_v3", formatVersion: 3, backupFingerprint: parsed.fingerprint },
    createdAt: options.createdAt,
    counts,
    assets: { count: assetRefs.filter((entry) => !entry.missing).length, totalBytes: parsed.report.assets.totalBytes },
    skippedByPolicy: parsed.report.skippedByPolicy,
    warnings: [...parsed.report.warnings, ...(parsed.report.assets.missingBlobs.length ? [`missing blobs: ${parsed.report.assets.missingBlobs.join(", ")}`] : [])],
  };

  return { manifest, payload, assetRefs };
}
