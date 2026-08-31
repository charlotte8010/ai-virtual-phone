import type { MemoryEntry } from "./memory-types";

type MemoryDedupeCandidate = Pick<MemoryEntry, "content" | "kind" | "embedding" | "createdAt" | "metadata">;

const SEMANTIC_DUPLICATE_THRESHOLD = 0.92;
const SEMANTIC_TIME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeMemoryContent(content: string): string {
    return content
        .normalize("NFKC")
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "");
}

export function buildSourceEventSignature(
    characterId: string,
    sourceApp: string,
    sourceEventId: string | undefined,
    timestamp: string,
    content: string,
): string {
    const eventId = sourceEventId?.trim();
    if (eventId) return `${characterId}:${sourceApp}:${eventId}`;
    return `${sourceApp}:${timestamp}:${normalizeMemoryContent(content)}`;
}

function getSourceEventSignatures(entry: MemoryDedupeCandidate): string[] {
    const signatures = entry.metadata?.sourceEventSignatures;
    if (!Array.isArray(signatures)) return [];
    return signatures.filter((value): value is string => typeof value === "string" && value.length > 0);
}

function cosineSimilarity(left: number[], right: number[]): number | undefined {
    if (left.length === 0 || left.length !== right.length) return undefined;
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < left.length; index += 1) {
        dot += left[index] * right[index];
        leftNorm += left[index] * left[index];
        rightNorm += right[index] * right[index];
    }
    if (leftNorm === 0 || rightNorm === 0) return undefined;
    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function areTimestampsClose(left: string, right: string): boolean {
    const leftTime = Date.parse(left);
    const rightTime = Date.parse(right);
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return false;
    return Math.abs(leftTime - rightTime) <= SEMANTIC_TIME_WINDOW_MS;
}

function sharesSourceSignature(
    candidate: MemoryDedupeCandidate,
    existing: MemoryDedupeCandidate,
): boolean {
    const existingSignatures = new Set(getSourceEventSignatures(existing));
    return getSourceEventSignatures(candidate).some(signature => existingSignatures.has(signature));
}

export function findDuplicateMemory(
    candidate: MemoryDedupeCandidate,
    existingEntries: MemoryDedupeCandidate[],
): MemoryDedupeCandidate | null {
    const candidateContentKey = normalizeMemoryContent(candidate.content);
    const candidateKind = candidate.kind ?? "event";

    for (const existing of existingEntries) {
        if (candidateContentKey && candidateContentKey === normalizeMemoryContent(existing.content)) {
            return existing;
        }
        if (sharesSourceSignature(candidate, existing)) return existing;

        const existingKind = existing.kind ?? "event";
        if (
            candidateKind === existingKind
            && candidate.embedding
            && existing.embedding
            && areTimestampsClose(candidate.createdAt, existing.createdAt)
        ) {
            const similarity = cosineSimilarity(candidate.embedding, existing.embedding);
            if (similarity !== undefined && similarity > SEMANTIC_DUPLICATE_THRESHOLD) return existing;
        }
    }
    return null;
}
