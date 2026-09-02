import type { MemoryEntry } from "./memory-types";
import { DEFAULT_CORE_MEMORY_PROMPT } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntriesByType,
    saveMemoryEntry,
    deleteMemoryEntry,
    deleteMemoryEntries,
    getCoreMemoryCounter,
    resetCoreMemoryCounter,
    getLastCoreSummarizedTimestamp,
    setLastCoreSummarizedTimestamp,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import { simpleLLMCall } from "./api-helpers";

const coreBuildingSet = new Set<string>();
const legacyCoreBuildingSet = new Set<string>();
const LEGACY_CORE_BACKFILL_VERSION = 1;
const LEGACY_CORE_CHUNK_CHAR_BUDGET = 6000;
const CORE_MEMORY_SAFETY_SUFFIX = [
    "【Core Memory 内置安全约束】",
    "尚未实际发生的计划、承诺、目标、愿望、预期不得进入 Core。",
    "不得把“曾经计划/期待”误写为“已经发生”。",
    "cancelled / waiting / unfulfilled / merely discussed future matters 不得成为稳定 Core。",
    "只有输入文本本身明确描述已经实际发生的经历、已成立关系或稳定事实时才可进入 Core。",
    "无法确认是否实际发生时，宁可忽略，不要推测。",
].join("\n");

type CoreTimelineItem = {
    id: string;
    timestamp: string;
    content: string;
    sourceApp: MemoryEntry["sourceApp"];
    sourceSessionIds: string[];
};

export type LegacyCoreBackfillPreview = {
    version: number;
    characterId: string;
    sourceFingerprint: string;
    longTermCount: number;
    replaceCoreIds: string[];
    preserveCoreIds: string[];
    earliest: string;
    latest: string;
    candidate: MemoryEntry;
};

export type LegacyCoreBackfillPreviewResult =
    | { success: true; preview: LegacyCoreBackfillPreview }
    | { success: false; error: string };

export type LegacyCoreBackfillApplyResult =
    | {
        success: true;
        longTermCount: number;
        replacedCoreCount: number;
        preservedCoreCount: number;
    }
    | { success: false; error: string };

function filterCoreMemoryInputEntries(entries: readonly MemoryEntry[]): MemoryEntry[] {
    return entries.filter(entry => entry.kind !== "future_intent");
}

function formatCoreTimelineForSummarization(
    entries: CoreTimelineItem[],
): { eventsText: string; earliest: string; latest: string; count: number } | null {
    if (entries.length === 0) return null;
    return {
        eventsText: entries.map(entry => `- ${entry.content}`).join("\n"),
        earliest: entries[0].timestamp,
        latest: entries[entries.length - 1].timestamp,
        count: entries.length,
    };
}

function toCoreTimelineItems(entries: readonly MemoryEntry[]): CoreTimelineItem[] {
    return entries
        .map(entry => ({
            id: entry.id,
            timestamp: entry.createdAt,
            content: entry.content,
            sourceApp: entry.sourceApp,
            sourceSessionIds: Array.isArray(entry.metadata?.sourceSessionIds)
                ? entry.metadata.sourceSessionIds.map(String)
                : [],
        }))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.id.localeCompare(b.id));
}

function dominantSourceApp(entries: readonly CoreTimelineItem[]): MemoryEntry["sourceApp"] {
    const sourceCounts = new Map<string, number>();
    for (const entry of entries) {
        sourceCounts.set(entry.sourceApp, (sourceCounts.get(entry.sourceApp) || 0) + 1);
    }
    let dominantSource: MemoryEntry["sourceApp"] = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) {
            dominantSource = src as MemoryEntry["sourceApp"];
            maxCount = count;
        }
    }
    return dominantSource;
}

function buildCorePrompt(
    promptTemplate: string,
    characterName: string,
    earliest: string,
    latest: string,
    eventsText: string,
): string {
    const substitutedPrompt = promptTemplate
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{earliest\}\}/gi, earliest)
        .replace(/\{\{latest\}\}/gi, latest)
        .replace(/\{\{events\}\}/gi, eventsText)
        .replace(/\{\{longTermMemories\}\}/gi, eventsText);
    return [substitutedPrompt, CORE_MEMORY_SAFETY_SUFFIX].join("\n\n");
}

function isProtectedCoreMemory(entry: MemoryEntry): boolean {
    const origin = String(entry.metadata?.origin ?? "");
    return origin === "user_manual" || origin === "user_edited" || entry.id.includes("_manual_");
}

function hasLegacyCoreBackfillMarker(entry: MemoryEntry): boolean {
    return Number(entry.metadata?.legacyCoreBackfillVersion) >= LEGACY_CORE_BACKFILL_VERSION;
}

function fnv1a(text: string): string {
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildLegacyCoreSourceFingerprint(
    longTermEntries: readonly MemoryEntry[],
    coreEntries: readonly MemoryEntry[],
): string {
    const normalized = [
        ...filterCoreMemoryInputEntries(longTermEntries).map(entry => ({
            scope: "long_term",
            id: entry.id,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            content: entry.content,
        })),
        ...coreEntries.map(entry => ({
            scope: "core",
            id: entry.id,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            content: entry.content,
            origin: String(entry.metadata?.origin ?? ""),
        })),
    ].sort((left, right) => (
        left.scope.localeCompare(right.scope) || left.id.localeCompare(right.id)
    ));
    return `legacy-core-v${LEGACY_CORE_BACKFILL_VERSION}-${fnv1a(JSON.stringify(normalized))}`;
}

export function classifyLegacyCoreEntries(coreEntries: readonly MemoryEntry[]): {
    replaceCoreIds: string[];
    preserveCoreIds: string[];
} {
    const replaceCoreIds: string[] = [];
    const preserveCoreIds: string[] = [];
    for (const entry of coreEntries) {
        if (isProtectedCoreMemory(entry)) preserveCoreIds.push(entry.id);
        else replaceCoreIds.push(entry.id);
    }
    return { replaceCoreIds, preserveCoreIds };
}

function chunkCoreTimelineItems(entries: readonly CoreTimelineItem[]): CoreTimelineItem[][] {
    const chunks: CoreTimelineItem[][] = [];
    let current: CoreTimelineItem[] = [];
    let currentChars = 0;
    for (const entry of entries) {
        const entryChars = entry.content.length + 32;
        if (current.length > 0 && currentChars + entryChars > LEGACY_CORE_CHUNK_CHAR_BUDGET) {
            chunks.push(current);
            current = [];
            currentChars = 0;
        }
        current.push(entry);
        currentChars += entryChars;
    }
    if (current.length > 0) chunks.push(current);
    return chunks;
}

async function summarizeLegacyChunk(
    apiConfig: NonNullable<ReturnType<typeof resolveAuxiliaryApiConfig>>,
    promptTemplate: string,
    characterName: string,
    entries: readonly CoreTimelineItem[],
): Promise<{ success: true; content: string } | { success: false; error: string }> {
    const formatted = formatCoreTimelineForSummarization([...entries]);
    if (!formatted) return { success: false, error: "格式化旧长期记忆失败" };
    const prompt = buildCorePrompt(
        promptTemplate,
        characterName,
        formatted.earliest,
        formatted.latest,
        formatted.eventsText,
    );
    const result = await simpleLLMCall(apiConfig, [{ role: "user", content: prompt }], { temperature: 0.2 });
    if (!result.content) {
        return { success: false, error: result.error || "旧长期记忆分段整理失败" };
    }
    if (result.wasTruncated) {
        return { success: false, error: "旧长期记忆分段整理结果疑似被截断，已取消写入" };
    }
    const content = result.content.trim();
    if (!content) return { success: false, error: "旧长期记忆分段整理结果为空" };
    return { success: true, content };
}

function buildLegacyConsolidationPrompt(input: {
    characterName: string;
    earliest: string;
    latest: string;
    chunkSummaries: string[];
    replaceableCoreEntries: MemoryEntry[];
    protectedCoreEntries: MemoryEntry[];
}): string {
    const historical = input.chunkSummaries.map((summary, index) => `- 历史摘要 ${index + 1}: ${summary}`).join("\n");
    const oldAutoCore = input.replaceableCoreEntries.length > 0
        ? input.replaceableCoreEntries.map(entry => `- ${entry.content}`).join("\n")
        : "（无）";
    const lockedCore = input.protectedCoreEntries.length > 0
        ? input.protectedCoreEntries.map(entry => `- ${entry.content}`).join("\n")
        : "（无）";

    return [
        "你正在执行一次性的旧版记忆清理（Legacy Core Backfill）。",
        `角色：${input.characterName}`,
        `历史长期记忆跨度：${input.earliest} 至 ${input.latest}`,
        "",
        "【由旧长期记忆提炼出的历史摘要】",
        historical,
        "",
        "【旧自动核心记忆】",
        oldAutoCore,
        "",
        "【必须原样保留、不会被本次替换的手工/用户编辑核心记忆】",
        lockedCore,
        "",
        "请输出一段新的自动核心记忆，用来替换旧自动核心记忆。要求：",
        "- 将旧长期记忆与旧自动核心记忆视为同一批历史证据，合并重复、同义和反复出现的事实。",
        "- 若存在冲突，优先采用更明确、更新且有实际发生依据的事实；不要把互相冲突的版本并列成两个事实。",
        "- 只保留长期稳定、会持续影响角色判断的关系身份、重大经历、重要共同生活里程碑和稳定事实。",
        "- 不要重复“必须原样保留”的手工/用户编辑核心记忆；这些内容会作为独立核心记忆继续存在。",
        "- 不得写入尚未实际发生的计划、承诺、愿望、目标或预期，也不得把讨论过的未来事项写成既成事实。",
        "- 不要因为旧数据表述重复而增加重要性；去重后只写一次。",
        "- 用第三人称、事实性描述；不要 JSON、列表、标题、解释或处理过程。",
        "- 信息量以不丢失关键长期事实为优先，通常控制在 300-800 字；事实较少时可以更短。",
        "",
        "只输出最终核心记忆正文。",
        "",
        CORE_MEMORY_SAFETY_SUFFIX,
    ].join("\n");
}

export async function previewLegacyCoreMemoryBackfill(
    characterId: string,
    characterName: string,
): Promise<LegacyCoreBackfillPreviewResult> {
    if (legacyCoreBuildingSet.has(characterId)) {
        return { success: false, error: "旧核心记忆正在整理，请稍后再试" };
    }
    legacyCoreBuildingSet.add(characterId);
    try {
        const [rawLongTermEntries, coreEntries] = await Promise.all([
            loadMemoryEntriesByType(characterId, "long_term"),
            loadMemoryEntriesByType(characterId, "core"),
        ]);
        const longTermEntries = filterCoreMemoryInputEntries(rawLongTermEntries);
        if (longTermEntries.length === 0) {
            return { success: false, error: "没有可用于整理核心记忆的旧长期记忆" };
        }
        if (coreEntries.some(hasLegacyCoreBackfillMarker)) {
            return { success: false, error: "旧长期记忆已经完成过一次性整理，无需重复执行" };
        }

        const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
        if (!apiConfig) {
            return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
        }

        const config = loadMemoryConfig();
        const promptTemplate = config.coreMemoryPrompt?.trim() || DEFAULT_CORE_MEMORY_PROMPT;
        const timelineEntries = toCoreTimelineItems(longTermEntries);
        const formatted = formatCoreTimelineForSummarization(timelineEntries);
        if (!formatted) return { success: false, error: "格式化旧长期记忆失败" };

        const chunkSummaries: string[] = [];
        for (const chunk of chunkCoreTimelineItems(timelineEntries)) {
            const summarized = await summarizeLegacyChunk(
                apiConfig,
                promptTemplate,
                characterName,
                chunk,
            );
            if (!summarized.success) return summarized;
            chunkSummaries.push(summarized.content);
        }

        const protectedCoreEntries = coreEntries.filter(isProtectedCoreMemory);
        const replaceableCoreEntries = coreEntries.filter(entry => !isProtectedCoreMemory(entry));
        const finalPrompt = buildLegacyConsolidationPrompt({
            characterName,
            earliest: formatted.earliest,
            latest: formatted.latest,
            chunkSummaries,
            replaceableCoreEntries,
            protectedCoreEntries,
        });
        const finalResult = await simpleLLMCall(
            apiConfig,
            [{ role: "user", content: finalPrompt }],
            { temperature: 0.2 },
        );
        if (!finalResult.content) {
            return { success: false, error: finalResult.error || "旧核心记忆合并失败" };
        }
        if (finalResult.wasTruncated) {
            return { success: false, error: "旧核心记忆合并结果疑似被截断，已取消写入" };
        }
        const summary = finalResult.content.trim();
        if (!summary) return { success: false, error: "旧核心记忆合并结果为空" };

        const now = new Date().toISOString();
        const sourceSessionIds = Array.from(new Set(timelineEntries.flatMap(entry => entry.sourceSessionIds)));
        const sourceFingerprint = buildLegacyCoreSourceFingerprint(longTermEntries, coreEntries);
        const { replaceCoreIds, preserveCoreIds } = classifyLegacyCoreEntries(coreEntries);
        const candidate: MemoryEntry = {
            id: `mem_core_legacy_v${LEGACY_CORE_BACKFILL_VERSION}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            characterId,
            sourceApp: dominantSourceApp(timelineEntries),
            type: "core",
            content: summary,
            importance: 0.95,
            // This is a historical consolidation cutoff, not a newly occurred event.
            createdAt: formatted.latest,
            updatedAt: now,
            metadata: {
                origin: "legacy_core_backfill",
                legacyCoreBackfillVersion: LEGACY_CORE_BACKFILL_VERSION,
                legacySourceFingerprint: sourceFingerprint,
                summarizedLongTermEntries: longTermEntries.length,
                replacedAutoCoreEntries: replaceCoreIds.length,
                preservedManualCoreEntries: preserveCoreIds.length,
                timeSpan: `${formatted.earliest} ~ ${formatted.latest}`,
                generatedAt: now,
                sourceSessionIds,
            },
        };

        return {
            success: true,
            preview: {
                version: LEGACY_CORE_BACKFILL_VERSION,
                characterId,
                sourceFingerprint,
                longTermCount: longTermEntries.length,
                replaceCoreIds,
                preserveCoreIds,
                earliest: formatted.earliest,
                latest: formatted.latest,
                candidate,
            },
        };
    } finally {
        legacyCoreBuildingSet.delete(characterId);
    }
}

export async function applyLegacyCoreMemoryBackfill(
    preview: LegacyCoreBackfillPreview,
): Promise<LegacyCoreBackfillApplyResult> {
    if (preview.version !== LEGACY_CORE_BACKFILL_VERSION) {
        return { success: false, error: "旧记忆整理预览版本已失效，请重新预览" };
    }

    const [rawLongTermEntries, coreEntries] = await Promise.all([
        loadMemoryEntriesByType(preview.characterId, "long_term"),
        loadMemoryEntriesByType(preview.characterId, "core"),
    ]);
    const longTermEntries = filterCoreMemoryInputEntries(rawLongTermEntries);
    if (coreEntries.some(hasLegacyCoreBackfillMarker)) {
        return { success: false, error: "旧长期记忆已经完成过一次性整理，无需重复执行" };
    }

    const currentFingerprint = buildLegacyCoreSourceFingerprint(longTermEntries, coreEntries);
    if (currentFingerprint !== preview.sourceFingerprint) {
        return { success: false, error: "记忆数据在预览后发生了变化，请重新预览后再应用" };
    }

    const currentClassification = classifyLegacyCoreEntries(coreEntries);
    const expectedReplaceIds = [...preview.replaceCoreIds].sort();
    const currentReplaceIds = [...currentClassification.replaceCoreIds].sort();
    const expectedPreserveIds = [...preview.preserveCoreIds].sort();
    const currentPreserveIds = [...currentClassification.preserveCoreIds].sort();
    if (
        JSON.stringify(expectedReplaceIds) !== JSON.stringify(currentReplaceIds)
        || JSON.stringify(expectedPreserveIds) !== JSON.stringify(currentPreserveIds)
    ) {
        return { success: false, error: "核心记忆集合在预览后发生了变化，请重新预览" };
    }

    try {
        await saveMemoryEntry(preview.candidate);
        try {
            await deleteMemoryEntries(currentReplaceIds);
        } catch (error) {
            await deleteMemoryEntry(preview.candidate.id).catch(() => undefined);
            throw error;
        }
        setLastCoreSummarizedTimestamp(preview.characterId, preview.latest);
        resetCoreMemoryCounter(preview.characterId);
        return {
            success: true,
            longTermCount: longTermEntries.length,
            replacedCoreCount: currentReplaceIds.length,
            preservedCoreCount: currentPreserveIds.length,
        };
    } catch (error) {
        return { success: false, error: `旧核心记忆写入失败: ${String(error)}` };
    }
}

export async function runCoreMemoryPipeline(
    characterId: string,
    characterName: string,
    options?: { force?: boolean },
): Promise<{ success: boolean; error?: string; rebuiltCount?: number }> {
    const config = loadMemoryConfig();
    const allLongTermEntries = filterCoreMemoryInputEntries(
        await loadMemoryEntriesByType(characterId, "long_term"),
    );

    if (allLongTermEntries.length === 0) {
        return { success: false, error: "没有可用于总结核心记忆的长期记忆" };
    }

    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    const afterTimestamp = options?.force ? undefined : (getLastCoreSummarizedTimestamp(characterId) ?? undefined);
    const entries = toCoreTimelineItems(
        allLongTermEntries.filter(entry => !afterTimestamp || entry.createdAt > afterTimestamp),
    );

    if (entries.length === 0) {
        if (!options?.force) resetCoreMemoryCounter(characterId);
        return { success: false, error: "没有新的长期记忆需要总结" };
    }

    const formatted = formatCoreTimelineForSummarization(entries);
    if (!formatted) return { success: false, error: "格式化核心记忆数据失败" };

    const { eventsText, earliest, latest } = formatted;
    const promptTemplate = config.coreMemoryPrompt?.trim() || DEFAULT_CORE_MEMORY_PROMPT;
    const prompt = buildCorePrompt(promptTemplate, characterName, earliest, latest, eventsText);

    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: prompt }],
        { temperature: 0.3 },
    );

    if (!result.content) {
        return { success: false, error: result.error || "核心记忆总结失败" };
    }
    if (result.wasTruncated) {
        return { success: false, error: "核心记忆总结结果疑似被截断，已取消入库，请稍后重试" };
    }

    const summary = result.content.trim();
    if (!summary) {
        return { success: false, error: "核心记忆总结结果为空" };
    }

    const now = new Date().toISOString();
    const sourceSessionIds = Array.from(new Set(entries.flatMap(entry => entry.sourceSessionIds)));

    const coreEntry: MemoryEntry = {
        id: `mem_core_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        sourceApp: dominantSourceApp(entries),
        type: "core",
        content: summary,
        importance: 0.95,
        createdAt: now,
        updatedAt: now,
        metadata: {
            summarizedLongTermEntries: entries.length,
            timeSpan: `${earliest} ~ ${latest}`,
            sourceSessionIds,
        },
    };
    await saveMemoryEntry(coreEntry);

    setLastCoreSummarizedTimestamp(characterId, latest);
    if (!options?.force) {
        resetCoreMemoryCounter(characterId);
    }

    return { success: true, rebuiltCount: 1 };
}

export async function maybeRunCoreMemoryPipeline(
    characterId: string,
    characterName: string,
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoBuildCoreEnabled) return;

    const counter = getCoreMemoryCounter(characterId);
    if (counter < config.coreSummarizationInterval) return;

    if (coreBuildingSet.has(characterId)) return;
    coreBuildingSet.add(characterId);
    try {
        const result = await runCoreMemoryPipeline(characterId, characterName);
        if (!result.success) {
            console.warn("[CoreMemory] Auto summary failed:", result.error);
        }
    } finally {
        coreBuildingSet.delete(characterId);
    }
}
