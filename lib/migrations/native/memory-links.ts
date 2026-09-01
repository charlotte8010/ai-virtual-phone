import type { MemoryLink } from "../../memory-types";
import type { MigrationMemory, MigrationMemoryLink } from "../format/types";

export interface NativeMemoryLinkAudit {
  sourceLinksTotal: number;
  bothEndpointsActive: number;
  oneEndpointArchived: number;
  bothEndpointsArchived: number;
  crossCharacter: number;
  brokenRef: number;
  unresolvableEndpoint: number;
  invalidStrength: number;
  invalidType: number;
  invalidStrengthSamples: string[];
  sourceTypeCounts: Record<string, number>;
  activeTypeCounts: Record<string, number>;
}

export interface NativeMemoryLinkMapping {
  links: MemoryLink[];
  sourceIdMap: Record<string, string>;
  audit: NativeMemoryLinkAudit;
}

interface ActiveMemoryRef {
  source: MigrationMemory;
  nativeId: string;
  characterId: string;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeType(value: unknown): string | undefined {
  const type = nonEmptyString(value);
  if (!type) return undefined;
  return type.toLocaleLowerCase() === "emotional" ? "emotion" : type;
}

function sourceWeight(link: MigrationMemoryLink): number | undefined {
  const value = finiteNumber(link.weight);
  return value === undefined || value < 0 ? undefined : Math.min(1, Math.max(0, value));
}

function increment(map: Record<string, number>, key: string | undefined): void {
  if (key) map[key] = (map[key] ?? 0) + 1;
}

function emptyAudit(): NativeMemoryLinkAudit {
  return {
    sourceLinksTotal: 0,
    bothEndpointsActive: 0,
    oneEndpointArchived: 0,
    bothEndpointsArchived: 0,
    crossCharacter: 0,
    brokenRef: 0,
    unresolvableEndpoint: 0,
    invalidStrength: 0,
    invalidType: 0,
    invalidStrengthSamples: [],
    sourceTypeCounts: {},
    activeTypeCounts: {},
  };
}

function semanticKey(characterId: string, fromMemoryId: string, toMemoryId: string, type: string): string {
  return `${characterId}\u0000${fromMemoryId}\u0000${toMemoryId}\u0000${type}`;
}

function sourceTimestamp(link: MigrationMemoryLink, fallback: string): string {
  const value = link.createdAt;
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
  return fallback;
}

/**
 * Project the source archive's links into the active C9 link store.
 * Archived, cross-character, orphaned, and malformed links remain archive-only.
 */
export function mapNativeMemoryLinks(
  sourceLinks: readonly MigrationMemoryLink[],
  sourceMemories: readonly MigrationMemory[],
  activeMemoryBySourceId: ReadonlyMap<string, ActiveMemoryRef>,
  sourceFingerprint: string,
  fallbackTimestamp: string,
  deterministicId: (kind: string, fingerprint: string, sourceId: string) => string,
): NativeMemoryLinkMapping {
  const audit = emptyAudit();
  audit.sourceLinksTotal = sourceLinks.length;
  const sourceMemoryById = new Map(sourceMemories.map((memory) => [memory.migrationId, memory]));
  const sourceIdMap: Record<string, string> = {};
  const activeLinksBySemanticKey = new Map<string, { source: MigrationMemoryLink; from: ActiveMemoryRef; to: ActiveMemoryRef; type: string; strength: number }>();

  for (const link of sourceLinks) {
    const sourceType = nonEmptyString(link.type);
    const type = normalizeType(link.type);
    increment(audit.sourceTypeCounts, sourceType);
    const strength = sourceWeight(link);

    const from = sourceMemoryById.get(link.fromMemoryRef);
    const to = sourceMemoryById.get(link.toMemoryRef);
    if (!from || !to) {
      audit.brokenRef += 1;
      continue;
    }
    if (from.archived === true && to.archived === true) audit.bothEndpointsArchived += 1;
    else if (from.archived === true || to.archived === true) audit.oneEndpointArchived += 1;
    if (from.characterRef && to.characterRef && from.characterRef !== to.characterRef) audit.crossCharacter += 1;

    const fromActive = activeMemoryBySourceId.get(from.migrationId);
    const toActive = activeMemoryBySourceId.get(to.migrationId);
    const bothEndpointsActive = Boolean(
      fromActive
      && toActive
      && fromActive.characterId === toActive.characterId
      && from.characterRef
      && from.characterRef === to.characterRef
    );
    if (bothEndpointsActive) {
      audit.bothEndpointsActive += 1;
      if (!sourceType) audit.invalidType += 1;
      if (strength === undefined) {
        audit.invalidStrength += 1;
        if (audit.invalidStrengthSamples.length < 10) audit.invalidStrengthSamples.push(link.migrationId);
      }
    }
    if (!fromActive || !toActive) {
      if (from.archived !== true && to.archived !== true) audit.unresolvableEndpoint += 1;
      continue;
    }
    if (fromActive.characterId !== toActive.characterId || from.characterRef !== to.characterRef) continue;
    if (!type || strength === undefined || fromActive.nativeId === toActive.nativeId) continue;

    const key = semanticKey(fromActive.characterId, fromActive.nativeId, toActive.nativeId, type);
    const previous = activeLinksBySemanticKey.get(key);
    if (!previous || link.migrationId.localeCompare(previous.source.migrationId) < 0) {
      activeLinksBySemanticKey.set(key, { source: link, from: fromActive, to: toActive, type, strength });
    }
  }

  const links: MemoryLink[] = [];
  for (const candidate of [...activeLinksBySemanticKey.values()].sort((left, right) => left.source.migrationId.localeCompare(right.source.migrationId))) {
    const id = deterministicId("memory_link", sourceFingerprint, candidate.source.migrationId);
    const createdAt = sourceTimestamp(candidate.source, fallbackTimestamp);
    links.push({
      id,
      characterId: candidate.from.characterId,
      fromMemoryId: candidate.from.nativeId,
      toMemoryId: candidate.to.nativeId,
      type: candidate.type,
      strength: candidate.strength,
      createdAt,
      updatedAt: createdAt,
    });
    increment(audit.activeTypeCounts, candidate.type);
  }

  for (const link of sourceLinks) {
    const from = activeMemoryBySourceId.get(link.fromMemoryRef);
    const to = activeMemoryBySourceId.get(link.toMemoryRef);
    const type = normalizeType(link.type);
    if (!from || !to || from.characterId !== to.characterId || from.nativeId === to.nativeId || !type || sourceWeight(link) === undefined) continue;
    sourceIdMap[link.migrationId] = deterministicId(
      "memory_link",
      sourceFingerprint,
      activeLinksBySemanticKey.get(semanticKey(from.characterId, from.nativeId, to.nativeId, type))?.source.migrationId ?? link.migrationId,
    );
  }

  return { links, sourceIdMap, audit };
}

export function memoryLinkSemanticKey(link: Pick<MemoryLink, "characterId" | "fromMemoryId" | "toMemoryId" | "type">): string {
  return semanticKey(link.characterId, link.fromMemoryId, link.toMemoryId, link.type);
}
