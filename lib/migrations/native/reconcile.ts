import type {
  DomainReconciliation,
  NativeMigrationPlan,
  NativeMigrationReconciliation,
  NativeMigrationSnapshot,
  NativeMediaImport,
} from "./types";

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableValue(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function reconcileRecords<T>(
  planned: T[],
  existing: T[],
  idOf: (value: T) => string,
): DomainReconciliation<T> {
  const existingById = new Map(existing.map((value) => [idOf(value), value]));
  const create: T[] = [];
  const reuse: T[] = [];
  const skip: T[] = [];
  const conflicts: Array<{ planned: T; existing: T; reason: string }> = [];
  const seen = new Set<string>();

  for (const value of planned) {
    const id = idOf(value);
    if (!id || seen.has(id)) {
      skip.push(value);
      continue;
    }
    seen.add(id);
    const current = existingById.get(id);
    if (!current) {
      create.push(value);
      continue;
    }
    if (stableValue(current) === stableValue(value)) reuse.push(current);
    else conflicts.push({ planned: value, existing: current, reason: `target id ${id} already exists with different content` });
  }
  return { create, reuse, skip, conflicts };
}

function totalsOf(parts: Array<DomainReconciliation<unknown>>): NativeMigrationReconciliation["totals"] {
  return parts.reduce((total, part) => ({
    create: total.create + part.create.length,
    reuse: total.reuse + part.reuse.length,
    skip: total.skip + part.skip.length,
    conflicts: total.conflicts + part.conflicts.length,
  }), { create: 0, reuse: 0, skip: 0, conflicts: 0 });
}

function reconcileStorySessions(
  planned: NativeMigrationPlan["storySessions"],
  existing: NativeMigrationSnapshot["storySessions"],
): { reconciliation: NativeMigrationReconciliation["storySessions"]; actualIdByPlannedId: Map<string, string> } {
  const existingById = new Map(existing.map((value) => [value.id, value]));
  const existingByCharacter = new Map<string, NativeMigrationSnapshot["storySessions"][number]>();
  for (const value of existing) if (!existingByCharacter.has(value.characterId)) existingByCharacter.set(value.characterId, value);
  const create: NativeMigrationSnapshot["storySessions"] = [];
  const reuse: NativeMigrationSnapshot["storySessions"] = [];
  const skip: NativeMigrationSnapshot["storySessions"] = [];
  const conflicts: Array<{ planned: NativeMigrationSnapshot["storySessions"][number]; existing: NativeMigrationSnapshot["storySessions"][number]; reason: string }> = [];
  const actualIdByPlannedId = new Map<string, string>();
  const seen = new Set<string>();

  for (const value of planned) {
    if (!value.id || seen.has(value.id)) {
      skip.push(value);
      continue;
    }
    seen.add(value.id);
    const byCharacter = existingByCharacter.get(value.characterId);
    if (byCharacter) {
      reuse.push(byCharacter);
      actualIdByPlannedId.set(value.id, byCharacter.id);
      continue;
    }
    const byId = existingById.get(value.id);
    if (!byId) {
      create.push(value);
      actualIdByPlannedId.set(value.id, value.id);
      continue;
    }
    if (stableValue(byId) === stableValue(value)) {
      reuse.push(byId);
      actualIdByPlannedId.set(value.id, byId.id);
    } else {
      conflicts.push({ planned: value, existing: byId, reason: `target id ${value.id} already exists for another character` });
    }
  }
  return { reconciliation: { create, reuse, skip, conflicts }, actualIdByPlannedId };
}

function resolveIdMap(
  planned: NativeMigrationPlan["idMap"],
  storySessionIds: Map<string, string>,
): NativeMigrationPlan["idMap"] {
  const resolved = Object.fromEntries(Object.entries(planned).map(([bucket, values]) => [bucket, { ...values }])) as NativeMigrationPlan["idMap"];
  const plannedStorySessions = resolved.storySessions;
  if (plannedStorySessions) {
    resolved.storySessions = Object.fromEntries(Object.entries(plannedStorySessions).map(([sourceId, plannedId]) => [
      sourceId,
      storySessionIds.get(plannedId) ?? plannedId,
    ]));
  }
  return resolved;
}

function protectNewStorySessionPointers(
  sessions: NativeMigrationReconciliation["storySessions"],
  messages: NativeMigrationReconciliation["storyMessages"],
): NativeMigrationReconciliation["storySessions"] {
  const conflictingIds = new Set(messages.conflicts.map((entry) => entry.planned.id));
  if (!conflictingIds.size) return sessions;
  const safeMessages = [...messages.create, ...messages.reuse];
  return {
    ...sessions,
    create: sessions.create.map((session) => {
      if (!session.lastMessageId || !conflictingIds.has(session.lastMessageId)) return session;
      const fallback = safeMessages
        .filter((message) => message.sessionId === session.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .at(-1);
      if (fallback) {
        return { ...session, lastMessageId: fallback.id, lastMessagePreview: fallback.rawContent.slice(0, 120) };
      }
      const { lastMessageId: _lastMessageId, lastMessagePreview: _lastMessagePreview, ...withoutLastMessage } = session;
      return withoutLastMessage;
    }),
  };
}

export function reconcileNativeMigrationPlan(plan: NativeMigrationPlan, existing: NativeMigrationSnapshot): NativeMigrationReconciliation {
  const identities = reconcileRecords(plan.identities.map((entry) => entry.value), existing.identities, (entry) => entry.id);
  const characters = reconcileRecords(plan.characters.map((entry) => entry.value), existing.characters, (entry) => entry.id);
  const contacts = reconcileRecords(plan.contacts, existing.contacts, (entry) => entry.id);
  const sessions = reconcileRecords(plan.sessions, existing.sessions, (entry) => entry.id);
  const messages = reconcileRecords(plan.messages, existing.messages, (entry) => entry.id);
  const existingMedia: NativeMediaImport[] = existing.mediaIds.map((id) => ({
    sourceAssetId: id,
    targetId: id,
    targetRef: `media-store://${id}`,
    source: { assetId: id, source: { platform: "float", backupFingerprint: plan.sourceFingerprint } },
  }));
  const media = reconcileRecords(plan.media, existingMedia, (entry) => entry.targetId);
  // Media rows are binary; an existing deterministic id is a reuse. Byte verification happens in apply/post-reconciliation.
  if (media.conflicts.length) {
    media.reuse.push(...media.conflicts.map((entry) => entry.existing));
    media.conflicts = [];
  }
  const moments = reconcileRecords(plan.moments, existing.moments, (entry) => entry.id);
  const momentComments = reconcileRecords(plan.momentComments, existing.momentComments, (entry) => entry.id);
  const diaries = reconcileRecords(plan.diaries, existing.diaries, (entry) => entry.id);
  const worlds = reconcileRecords(plan.worlds, existing.worlds, (entry) => entry.id);
  const worldbooks = reconcileRecords(plan.worldbooks, existing.worldbooks, (entry) => entry.id);
  const calendar = reconcileRecords(plan.calendar, existing.calendar, (entry) => entry.id);
  const memories = reconcileRecords(plan.memories, existing.memories, (entry) => entry.id);
  const storySessionResult = reconcileStorySessions(plan.storySessions, existing.storySessions);
  const remappedStoryMessages = plan.storyMessages.map((message) => {
    const sessionId = storySessionResult.actualIdByPlannedId.get(message.sessionId);
    if (!sessionId) throw new Error(`cannot reconcile StoryMessage ${message.id}: StorySession ${message.sessionId} is conflicted`);
    return sessionId === message.sessionId ? message : { ...message, sessionId };
  });
  const storyMessages = reconcileRecords(remappedStoryMessages, existing.storyMessages, (entry) => entry.id);
  const storySessions = protectNewStorySessionPointers(storySessionResult.reconciliation, storyMessages);
  const resolvedIdMap = resolveIdMap(plan.idMap, storySessionResult.actualIdByPlannedId);
  const archive = existing.archive === undefined
    ? "create"
    : stableValue(existing.archive) === stableValue(plan.archive) ? "reuse" : "conflict";
  const idMap = existing.idMap === undefined
    ? "create"
    : stableValue(existing.idMap) === stableValue(resolvedIdMap) ? "reuse" : "conflict";
  const parts: Array<DomainReconciliation<unknown>> = [
    identities, characters, contacts, sessions, messages, media, moments, momentComments,
    diaries, worlds, worldbooks, calendar, memories, storySessions, storyMessages,
  ];
  const totals = totalsOf(parts);
  totals.create += archive === "create" ? 1 : 0;
  totals.reuse += archive === "reuse" ? 1 : 0;
  totals.conflicts += archive === "conflict" ? 1 : 0;
  totals.create += idMap === "create" ? 1 : 0;
  totals.reuse += idMap === "reuse" ? 1 : 0;
  totals.conflicts += idMap === "conflict" ? 1 : 0;
  return {
    identities, characters, contacts, sessions, messages, media, moments, momentComments, diaries,
    worlds, worldbooks, calendar, memories,
    storySessions,
    storyMessages,
    archive, idMap, resolvedIdMap, totals,
  };
}
