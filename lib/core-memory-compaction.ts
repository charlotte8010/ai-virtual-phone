import type { CoreCompactionSnapshot, MemoryEntry, MemoryKind, MemoryMood } from "./memory-types";
import {
    loadMemoryEntriesByType,
    loadLatestCoreCompactionSnapshot,
    replaceCoreMemoriesWithSnapshot,
    restoreCoreCompactionSnapshot,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";

/** Internal-only instruction for the one-time maintenance action. */
export const CORE_COMPACTION_MAINTENANCE_PROMPT = "你是核心记忆维护助手。请把角色当前已有的核心记忆整理成更短、更独立的稳定事实。\n\n"
    + "角色：{{char}}\n\n"
    + "当前核心记忆（唯一事实来源）：\n{{cores}}\n\n"
    + "要求：\n"
    + "- 每条只表达一个主要稳定事实\n"
    + "- 使用第三人称、事实性、简洁自然的中文\n"
    + "- 高度重复内容合并；一个长记忆中的多个独立事实可以拆分\n"
    + "- 普通日常细节、临时情绪和不确定内容删除\n"
    + "- 不制造输入中不存在的事实\n"
    + "- 不要把计划、期待、尚未发生的承诺或未来事项写成已经发生\n"
    + "- 不需要为了凑数量增加内容\n"
    + "- 不要在正文中机械添加日期；记忆创建时间与事实发生时间不同\n"
    + "- 严格只输出 JSON，不要 Markdown、标题或解释文字\n\n"
    + "输出格式：\n{\"memories\":[{\"content\":\"稳定事实\",\"tags\":[\"关系\"],\"kind\":\"relationship\"}]}";

const MAX_CONTENT_LENGTH = 2000;
const MAX_TAGS = 6;
const MAX_TAG_LENGTH = 32;
const MEMORY_KINDS: readonly MemoryKind[] = [
    "event", "relationship", "user_fact", "self_fact", "knowledge", "future_intent",
];
const MEMORY_MOODS: readonly MemoryMood[] = [
    "neutral", "happy", "tender", "excited", "sad", "angry", "anxious", "afraid",
    "jealous", "embarrassed", "lonely", "nostalgic",
];

export type CoreCompactionCandidate = {
    content: string;
    tags: string[];
    kind: Exclude<MemoryKind, "future_intent">;
    mood?: MemoryMood;
};

export type CoreCompactionPreview = {
    characterId: string;
    characterName: string;
    previewedAt: string;
    originalEntries: MemoryEntry[];
    candidates: CoreCompactionCandidate[];
    sourceFingerprint: string;
    originalCount: number;
    candidateCount: number;
};

export type CoreCompactionDependencies = {
    loadCoreEntries: (characterId: string) => Promise<MemoryEntry[]>;
    resolveApiConfig: typeof resolveAuxiliaryApiConfig;
    callLlm: typeof simpleLLMCall;
    replace: typeof replaceCoreMemoriesWithSnapshot;
    loadLatestSnapshot: typeof loadLatestCoreCompactionSnapshot;
    restoreSnapshot: typeof restoreCoreCompactionSnapshot;
    now: () => string;
    createRunId: () => string;
    createMemoryId: (runId: string, index: number) => string;
};

type CompactionFailure = { success: false; error: string };
type CompactionSuccess<T extends object = object> = { success: true } & T;

function getDefaultDependencies(): CoreCompactionDependencies {
    return {
        loadCoreEntries: (characterId) => loadMemoryEntriesByType(characterId, "core"),
        resolveApiConfig: resolveAuxiliaryApiConfig,
        callLlm: simpleLLMCall,
        replace: replaceCoreMemoriesWithSnapshot,
        loadLatestSnapshot: loadLatestCoreCompactionSnapshot,
        restoreSnapshot: restoreCoreCompactionSnapshot,
        now: () => new Date().toISOString(),
        createRunId: () => createOpaqueId("core_compaction"),
        createMemoryId: (runId, index) => "mem_core_compaction_" + runId + "_" + index,
    };
}

function withDependencies(overrides?: Partial<CoreCompactionDependencies>): CoreCompactionDependencies {
    return { ...getDefaultDependencies(), ...overrides };
}

function createOpaqueId(prefix: string): string {
    const uuid = typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : Math.random().toString(36).slice(2, 12);
    return prefix + "_" + Date.now() + "_" + uuid;
}

function cloneEntries(entries: readonly MemoryEntry[]): MemoryEntry[] {
    return entries.map((entry) => {
        if (typeof structuredClone === "function") return structuredClone(entry);
        return {
            ...entry,
            ...(entry.tags ? { tags: [...entry.tags] } : {}),
            ...(entry.metadata ? { metadata: { ...entry.metadata } } : {}),
            ...(entry.futureIntent ? { futureIntent: { ...entry.futureIntent } } : {}),
        };
    });
}

function canonicalContent(content: string): string {
    return content.replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown | undefined {
    const candidates = [text.trim()];
    const fence = String.fromCharCode(96);
    const fenced = text.match(new RegExp(fence + "{3}(?:json)?\\s*([\\s\\S]*?)" + fence + "{3}", "i"))?.[1]?.trim();
    if (fenced) candidates.push(fenced);
    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate) as unknown;
        } catch {
            // Maintenance output is intentionally strict JSON. Do not repair
            // malformed output into something that could be applied silently.
        }
    }
    return undefined;
}

function sanitizeCandidate(raw: unknown): CoreCompactionCandidate | null {
    if (!isRecord(raw) || typeof raw.content !== "string") return null;
    const content = canonicalContent(raw.content);
    if (!content || content.length > MAX_CONTENT_LENGTH) return null;
    if (raw.kind === "future_intent" || (raw.futureIntent !== undefined && raw.futureIntent !== null)) {
        return null;
    }
    const kind = MEMORY_KINDS.includes(raw.kind as MemoryKind) && raw.kind !== "future_intent"
        ? raw.kind as Exclude<MemoryKind, "future_intent">
        : "event";
    const tags = Array.isArray(raw.tags)
        ? Array.from(new Set(raw.tags
            .filter((tag): tag is string => typeof tag === "string")
            .map(tag => tag.trim().slice(0, MAX_TAG_LENGTH))
            .filter(Boolean))).slice(0, MAX_TAGS)
        : [];
    const mood = MEMORY_MOODS.includes(raw.mood as MemoryMood) ? raw.mood as MemoryMood : undefined;
    return {
        content,
        tags,
        kind,
        ...(mood ? { mood } : {}),
    };
}

function parseCandidates(text: string): { candidates: CoreCompactionCandidate[]; error?: string } {
    const payload = parseJson(text);
    const rawCandidates = Array.isArray(payload)
        ? payload
        : isRecord(payload) && Array.isArray(payload.memories)
            ? payload.memories
            : null;
    if (!rawCandidates || rawCandidates.length === 0) {
        return { candidates: [], error: "核心记忆整理结果为空或不是有效 JSON" };
    }

    const candidates: CoreCompactionCandidate[] = [];
    const seen = new Set<string>();
    for (const raw of rawCandidates) {
        const candidate = sanitizeCandidate(raw);
        if (!candidate) {
            return { candidates: [], error: "核心记忆整理结果包含无效或未来事项，已取消应用" };
        }
        const key = canonicalContent(candidate.content);
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
    }
    return candidates.length > 0
        ? { candidates }
        : { candidates: [], error: "核心记忆整理结果去重后为空" };
}

function formatCoreCompactionPrompt(characterName: string, entries: readonly MemoryEntry[]): string {
    const cores = entries
        .map(entry => "- [core_id=" + entry.id + "] [created_at=" + entry.createdAt + "] " + entry.content)
        .join("\n");
    return CORE_COMPACTION_MAINTENANCE_PROMPT
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{cores\}\}/gi, cores);
}

function sourceAppForEntries(entries: readonly MemoryEntry[]): MemoryEntry["sourceApp"] {
    const counts = new Map<MemoryEntry["sourceApp"], number>();
    for (const entry of entries) counts.set(entry.sourceApp, (counts.get(entry.sourceApp) ?? 0) + 1);
    let selected = entries[0]?.sourceApp ?? "chat";
    let maxCount = 0;
    for (const [sourceApp, count] of counts) {
        if (count > maxCount) {
            selected = sourceApp;
            maxCount = count;
        }
    }
    return selected;
}

function sourceFingerprint(entries: readonly MemoryEntry[]): string {
    return JSON.stringify(entries);
}

export function buildCompactedCoreEntries(
    characterId: string,
    originalEntries: readonly MemoryEntry[],
    candidates: readonly CoreCompactionCandidate[],
    runId: string,
    compactedAt: string,
    createMemoryId: (runId: string, index: number) => string,
): MemoryEntry[] {
    const sourceApp = sourceAppForEntries(originalEntries);
    const compactedFromCoreIds = originalEntries.map(entry => entry.id);
    return candidates.map((candidate, index) => ({
        id: createMemoryId(runId, index),
        characterId,
        sourceApp,
        type: "core",
        content: candidate.content,
        importance: 0.95,
        createdAt: compactedAt,
        updatedAt: compactedAt,
        tags: [...candidate.tags],
        kind: candidate.kind,
        ...(candidate.mood ? { mood: candidate.mood } : {}),
        metadata: {
            compactionRunId: runId,
            compactedAt,
            compactedFromCoreIds: [...compactedFromCoreIds],
        },
    }));
}

export async function previewCoreMemoryCompaction(
    characterId: string,
    characterName: string,
    overrides?: Partial<CoreCompactionDependencies>,
): Promise<CompactionSuccess<{ preview: CoreCompactionPreview }> | CompactionFailure> {
    const deps = withDependencies(overrides);
    const originalEntries = (await deps.loadCoreEntries(characterId))
        .filter(entry => entry.characterId === characterId && entry.type === "core");
    if (originalEntries.length === 0) return { success: false, error: "当前角色没有核心记忆可整理" };

    const apiConfig = deps.resolveApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) return { success: false, error: "未配置记忆总结 API（请在绑定配置中设置）" };

    const result = await deps.callLlm(
        apiConfig,
        [{ role: "user", content: formatCoreCompactionPrompt(characterName, originalEntries) }],
        { temperature: 0.2 },
    );
    if (!result.content || result.wasTruncated) {
        return {
            success: false,
            error: result.wasTruncated ? "整理结果疑似被截断，已取消应用" : (result.error || "整理结果为空"),
        };
    }

    const parsed = parseCandidates(result.content);
    if (parsed.error) return { success: false, error: parsed.error };
    const preview: CoreCompactionPreview = {
        characterId,
        characterName,
        previewedAt: deps.now(),
        originalEntries: cloneEntries(originalEntries),
        candidates: parsed.candidates,
        sourceFingerprint: sourceFingerprint(originalEntries),
        originalCount: originalEntries.length,
        candidateCount: parsed.candidates.length,
    };
    return { success: true, preview };
}

export async function applyCoreMemoryCompaction(
    preview: CoreCompactionPreview,
    overrides?: Partial<CoreCompactionDependencies>,
): Promise<CompactionSuccess<{ runId: string; createdCount: number }> | CompactionFailure> {
    const deps = withDependencies(overrides);
    if (preview.candidates.length === 0) return { success: false, error: "没有可应用的整理结果" };
    const currentEntries = (await deps.loadCoreEntries(preview.characterId))
        .filter(entry => entry.characterId === preview.characterId && entry.type === "core");
    if (sourceFingerprint(currentEntries) !== preview.sourceFingerprint) {
        return { success: false, error: "核心记忆在预览后发生变化，请重新预览" };
    }

    const compactedAt = deps.now();
    const runId = deps.createRunId();
    const newEntries = buildCompactedCoreEntries(
        preview.characterId,
        currentEntries,
        preview.candidates,
        runId,
        compactedAt,
        deps.createMemoryId,
    );
    const snapshot: CoreCompactionSnapshot = {
        runId,
        characterId: preview.characterId,
        createdAt: compactedAt,
        compactedAt,
        originalEntries: cloneEntries(currentEntries),
        createdMemoryIds: newEntries.map(entry => entry.id),
    };
    try {
        await deps.replace({ snapshot, originalEntries: currentEntries, newEntries });
        return { success: true, runId, createdCount: newEntries.length };
    } catch (error) {
        return {
            success: false,
            error: "应用核心记忆整理失败：" + (error instanceof Error ? error.message : String(error)),
        };
    }
}

export async function loadLatestCoreMemoryCompactionSnapshot(
    characterId: string,
    overrides?: Partial<CoreCompactionDependencies>,
): Promise<CoreCompactionSnapshot | null> {
    return withDependencies(overrides).loadLatestSnapshot(characterId);
}

export async function restoreCoreMemoryCompaction(
    characterId: string,
    runId?: string,
    overrides?: Partial<CoreCompactionDependencies>,
): Promise<CompactionSuccess<{ snapshot: CoreCompactionSnapshot }> | CompactionFailure> {
    try {
        const snapshot = await withDependencies(overrides).restoreSnapshot(characterId, runId);
        return { success: true, snapshot };
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
}
