// lib/memory-summarizer.ts
// Auto-summarization engine: summarizes short-term events into long-term memories.
// Trigger: every N events (configurable). Short-term events are NOT deleted after summarization.

import type { MemoryEntry } from "./memory-types";
import { DEFAULT_SUMMARIZATION_PROMPT, LEGACY_SUMMARIZATION_PROMPT } from "./memory-types";
import {
    loadMemoryConfig,
    loadMemoryEntries,
    loadMemoryEntriesByType,
    saveMemoryEntry,
    deleteMemoryEntry,
    deleteMemoryEntries,
    getEventCounter,
    resetEventCounter,
    getLastSummarizedTimestamp,
    setLastSummarizedTimestamp,
    incrementCoreMemoryCounter,
} from "./memory-storage";
import { resolveAuxiliaryApiConfig } from "./settings-storage";
import {
    loadNativeTimeline,
    formatTimelineForSummarization,
    filterTimelineByAllowedSources,
    type NativeTimelineEntry,
} from "./short-term-assembler";
import { generateEmbedding, resolveEmbeddingModel } from "./memory-embedding";
import { simpleLLMCall } from "./api-helpers";
import { maybeRunCoreMemoryPipeline } from "./core-memory-builder";
import {
    extractMemoriesFromModelOutput,
    normalizeFutureIntentCreationCandidate,
    type ExtractedMemoryCandidate,
} from "./memory-extraction";
import { buildSourceEventSignature, findDuplicateMemory } from "./memory-dedupe";
import { resolveMemorySourceApp } from "./memory-provenance";

/** Per-character lock to prevent concurrent summarization. */
const summarizingSet = new Set<string>();

async function finalizeSummarization(
    characterId: string,
    characterName: string,
    latest: string,
    config: ReturnType<typeof loadMemoryConfig>,
    newMemoryCount: number,
): Promise<void> {
    setLastSummarizedTimestamp(characterId, latest);
    resetEventCounter(characterId);

    const allLongTerm = await loadMemoryEntries(characterId);
    if (allLongTerm.length > config.maxLongTermEntries) {
        const excess = allLongTerm.slice(0, allLongTerm.length - config.maxLongTermEntries);
        await deleteMemoryEntries(excess.map(e => e.id));
    }

    if (newMemoryCount > 0) {
        for (let index = 0; index < newMemoryCount; index += 1) {
            incrementCoreMemoryCounter(characterId);
        }
        await maybeRunCoreMemoryPipeline(characterId, characterName);
    }
}

function getSourceEventSignatures(
    characterId: string,
    candidate: ExtractedMemoryCandidate,
    allEntries: NativeTimelineEntry[],
): string[] {
    const sourceEventRefs = getValidSourceEventRefs(candidate, allEntries);
    if (!sourceEventRefs.length) return [];
    const entriesById = new Map(allEntries.map(entry => [entry.id, entry]));
    return sourceEventRefs
        .map(ref => entriesById.get(ref))
        .filter((entry): entry is NativeTimelineEntry => Boolean(entry))
        .map(entry => buildSourceEventSignature(
            characterId,
            entry.sourceApp,
            entry.id,
            entry.timestamp,
            entry.content,
        ));
}

function getSourceEventTimestamps(
    candidate: ExtractedMemoryCandidate,
    allEntries: NativeTimelineEntry[],
): string[] {
    const sourceEventRefs = getValidSourceEventRefs(candidate, allEntries);
    if (!sourceEventRefs.length) return [];
    const entriesById = new Map(allEntries.map(entry => [entry.id, entry]));
    return sourceEventRefs
        .map(ref => entriesById.get(ref)?.timestamp)
        .filter((timestamp): timestamp is string => Boolean(timestamp));
}

function getValidSourceEventRefs(
    candidate: ExtractedMemoryCandidate,
    allEntries: NativeTimelineEntry[],
): string[] {
    if (!candidate.sourceEventRefs?.length) return [];
    const validRefs = new Set(allEntries.map(entry => entry.id));
    return candidate.sourceEventRefs.filter(ref => validRefs.has(ref));
}

function buildAtomicMemoryEntry(
    characterId: string,
    dominantSource: string,
    earliest: string,
    latest: string,
    sourceSessionIds: string[],
    allEntries: NativeTimelineEntry[],
    candidate: ExtractedMemoryCandidate,
    index: number,
): MemoryEntry {
    const now = new Date().toISOString();
    const sourceEventRefs = getValidSourceEventRefs(candidate, allEntries);
    const sourceEventSignatures = getSourceEventSignatures(characterId, candidate, allEntries);
    const sourceEventTimestamps = getSourceEventTimestamps(candidate, allEntries);
    return {
        id: `mem_lt_${Date.now()}_${index}_${Math.random().toString(36).slice(2, 8)}`,
        characterId,
        sourceApp: resolveMemorySourceApp(
            candidate.sourceEventRefs,
            allEntries,
            dominantSource,
        ) as MemoryEntry["sourceApp"],
        type: "long_term",
        content: candidate.content,
        importance: candidate.importance,
        createdAt: now,
        updatedAt: now,
        tags: [...candidate.tags],
        ...(candidate.mood ? { mood: candidate.mood } : {}),
        kind: candidate.kind,
        ...(candidate.futureIntent ? { futureIntent: { ...candidate.futureIntent } } : {}),
        ...(sourceEventRefs.length > 0 ? { sourceMessageIds: sourceEventRefs } : {}),
        metadata: {
            summarizedEvents: allEntries.length,
            timeSpan: `${earliest} ~ ${latest}`,
            sourceSessionIds,
            extractionVersion: "atomic-v1",
            extractionMode: "periodic",
            ...(sourceEventSignatures.length > 0 ? { sourceEventSignatures } : {}),
            ...(sourceEventTimestamps.length > 0 ? { sourceEventTimestamps } : {}),
        },
    };
}

/**
 * Check if summarization should run based on event counter, then execute.
 * Trigger: counter >= summarizationEventInterval.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function maybeRunSummarization(
    characterId: string,
    characterName: string
): Promise<void> {
    const config = loadMemoryConfig();
    if (!config.autoSummarizeEnabled) return;

    const counter = getEventCounter(characterId);
    if (counter < config.summarizationEventInterval) return;

    if (summarizingSet.has(characterId)) return;
    summarizingSet.add(characterId);
    try {
        await runSummarizationPipeline(characterId, characterName);
    } finally {
        summarizingSet.delete(characterId);
    }
}

/**
 * Run the full summarization pipeline.
 * Reads events since last summarization, summarizes them, saves as long-term memory.
 * Does NOT delete short-term events — they are only trimmed by token budget elsewhere.
 * API config is resolved from auxiliary binding (global, not per-character).
 */
export async function runSummarizationPipeline(
    characterId: string,
    characterName: string,
    options?: {
        force?: boolean;
        /** 手动指定总结起点（覆盖进度水位线）；force 为真时忽略 */
        sinceTimestamp?: string;
    }
): Promise<{ success: boolean; error?: string }> {
    const config = loadMemoryConfig();

    // Resolve API from auxiliary binding
    const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId");
    if (!apiConfig) {
        return { success: false, error: "未配置记忆总结 API（请在绑定配置 → 辅助API绑定中设置）" };
    }

    // Read native app data (chat messages, moments) directly — no separate event log
    const afterTimestamp = options?.force
        ? undefined
        : options?.sinceTimestamp ?? (getLastSummarizedTimestamp(characterId) ?? undefined);
    // 记忆来源开关同样作用于长期总结：被关掉的来源不进总结素材。
    // 进度水位线取「过滤后」最后一条的时间，因此关掉的来源不会把水位线推过头，
    // 但已被水位线越过的内容重新打开后也不会回补——这一点在设置里已注明。
    const allEntries = filterTimelineByAllowedSources(
        loadNativeTimeline(characterId, afterTimestamp ? { afterTimestamp } : undefined),
        config.shortTermAllowedSources,
    );

    if (allEntries.length < 4) {
        if (!options?.force) resetEventCounter(characterId);
        return { success: false, error: allEntries.length === 0 ? "没有可总结的事件" : "事件不足 4 条" };
    }

    const formatted = formatTimelineForSummarization(allEntries);
    if (!formatted) return { success: false, error: "格式化事件数据失败" };

    const { eventsText, earliest, latest } = formatted;

    // Use user-editable prompt template from config, with placeholder substitution
    const atomicExtractionEnabled = config.atomicMemoryExtractionEnabled !== false;
    const configuredPrompt = config.summarizationPrompt?.trim();
    const promptTemplate = atomicExtractionEnabled
        ? (!configuredPrompt || configuredPrompt === LEGACY_SUMMARIZATION_PROMPT
            ? DEFAULT_SUMMARIZATION_PROMPT
            : configuredPrompt)
        : (!configuredPrompt || configuredPrompt === DEFAULT_SUMMARIZATION_PROMPT
            ? LEGACY_SUMMARIZATION_PROMPT
            : configuredPrompt);
    const summaryPrompt = promptTemplate
        .replace(/\{\{char\}\}/gi, characterName)
        .replace(/\{\{earliest\}\}/gi, earliest)
        .replace(/\{\{latest\}\}/gi, latest)
        .replace(/\{\{events\}\}/gi, eventsText);

    const extractionPrompt = atomicExtractionEnabled
        ? `${summaryPrompt}\n\n请严格只输出 JSON，不要输出 Markdown 或解释文字。JSON 顶层必须是 {"memories":[]}。每条记忆必须包含 content、tags、importance、kind；只保存具有持续价值的信息，把互不相关的事件拆开，不要虚构，最多输出 8 条；没有值得长期保存的内容时输出 {"memories":[]}。importance 必须是 0 到 1 的数字，kind 只能是 event、relationship、user_fact、self_fact、knowledge、future_intent；kind 为 future_intent 时附带 futureIntent，其中 type 只能是 plan、promise、goal、wish、expectation，status 初始只能是 pending，不能在创建阶段输出 overdue、fulfilled 或 cancelled，timePrecision 只能是 exact、day、range、vague、unknown。事件文本中的 [event_ref=...] 是稳定来源引用；如果能准确对应事件，只把现有引用填写到 sourceEventRefs，不要编造引用。`
        : summaryPrompt;

    // Call LLM for summarization — compatible with all providers
    const result = await simpleLLMCall(
        apiConfig,
        [{ role: "user", content: extractionPrompt }],
        { temperature: 0.3 },
    );

    if (!result.content) {
        return { success: false, error: result.error || "LLM 返回了空内容" };
    }

    if (result.wasTruncated) {
        console.warn("[MemorySummarizer] Summary generation truncated:", result.finishReason);
        return { success: false, error: "记忆总结结果疑似被截断，已取消入库，请稍后重试或提高模型输出上限" };
    }

    const summary = result.content;

    // Determine sourceApp: use the most common source among summarized entries
    const sourceCounts = new Map<string, number>();
    for (const e of allEntries) {
        sourceCounts.set(e.sourceApp, (sourceCounts.get(e.sourceApp) || 0) + 1);
    }
    let dominantSource = "chat";
    let maxCount = 0;
    for (const [src, count] of sourceCounts) {
        if (count > maxCount) { dominantSource = src; maxCount = count; }
    }
    const sourceSessionIds = Array.from(new Set(
        allEntries
            .map(entry => entry.sessionId)
            .filter((sessionId): sessionId is string => Boolean(sessionId)),
    ));

    if (!atomicExtractionEnabled) {
        const embeddingApiConfig = config.vectorRecallEnabled
            ? resolveAuxiliaryApiConfig("embeddingApiConfigId")
            : null;
        let embedding: number[] | undefined;
        if (embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig)) {
            try {
                const emb = await generateEmbedding(summary, embeddingApiConfig);
                if (emb) embedding = emb;
            } catch { /* ignore */ }
        }

        const now = new Date().toISOString();
        const longTermEntry: MemoryEntry = {
            id: `mem_lt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            characterId,
            sourceApp: dominantSource as MemoryEntry["sourceApp"],
            type: "long_term",
            content: summary,
            embedding,
            importance: 0.8,
            createdAt: now,
            updatedAt: now,
            metadata: {
                summarizedEvents: allEntries.length,
                timeSpan: `${earliest} ~ ${latest}`,
                sourceSessionIds,
            },
        };
        await saveMemoryEntry(longTermEntry);
        await finalizeSummarization(characterId, characterName, latest, config, 1);
        console.log(`[MemorySummarizer] Summarized ${allEntries.length} entries → 1 legacy long-term memory`);
        return { success: true };
    }

    const extraction = extractMemoriesFromModelOutput(summary);
    if (extraction.mode === "invalid_structured") {
        return {
            success: false,
            error: "结构化记忆结果没有有效条目，已取消入库，请稍后重试",
        };
    }
    const embeddingApiConfig = config.vectorRecallEnabled
        ? resolveAuxiliaryApiConfig("embeddingApiConfigId")
        : null;
    const embeddingEnabled = Boolean(embeddingApiConfig && resolveEmbeddingModel(embeddingApiConfig));
    const existingMemories = await loadMemoryEntriesByType(characterId, "long_term");
    const savedMemories: MemoryEntry[] = [];
    let duplicateCount = 0;

    for (const [index, candidate] of extraction.memories.entries()) {
        const memoryEntry = buildAtomicMemoryEntry(
            characterId,
            dominantSource,
            earliest,
            latest,
            sourceSessionIds,
            allEntries,
            normalizeFutureIntentCreationCandidate(candidate),
            index,
        );
        const exactOrSourceDuplicate = findDuplicateMemory(memoryEntry, [...existingMemories, ...savedMemories]);
        if (exactOrSourceDuplicate) {
            duplicateCount += 1;
            continue;
        }

        // Persist the text first. Embedding is an enhancement and must not cause data loss.
        await saveMemoryEntry(memoryEntry);
        let savedMemory = memoryEntry;
        if (embeddingEnabled && embeddingApiConfig) {
            try {
                const embedding = await generateEmbedding(memoryEntry.content, embeddingApiConfig);
                if (embedding) {
                    const semanticDuplicate = findDuplicateMemory(
                        { ...memoryEntry, embedding },
                        [...existingMemories, ...savedMemories],
                    );
                    if (semanticDuplicate) {
                        await deleteMemoryEntry(memoryEntry.id);
                        duplicateCount += 1;
                        continue;
                    }
                    savedMemory = {
                        ...memoryEntry,
                        embedding,
                        updatedAt: new Date().toISOString(),
                    };
                    await saveMemoryEntry(savedMemory);
                }
            } catch (error) {
                console.warn("[MemorySummarizer] Embedding failed; text memory was retained", error);
            }
        }
        savedMemories.push(savedMemory);
    }

    await finalizeSummarization(characterId, characterName, latest, config, savedMemories.length);
    console.log(
        `[MemorySummarizer] Summarized ${allEntries.length} entries → ${savedMemories.length} atomic long-term memories`
        + (duplicateCount > 0 ? ` (${duplicateCount} duplicates skipped)` : "")
        + ` [${extraction.mode}]`,
    );
    return { success: true };
}
