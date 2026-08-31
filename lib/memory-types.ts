// lib/memory-types.ts

import type { ContentAppId } from "./settings-types";

export type MemoryKind =
    | "event"
    | "relationship"
    | "user_fact"
    | "self_fact"
    | "knowledge"
    | "future_intent";

export type MemoryMood =
    | "neutral"
    | "happy"
    | "tender"
    | "excited"
    | "sad"
    | "angry"
    | "anxious"
    | "afraid"
    | "jealous"
    | "embarrassed"
    | "lonely"
    | "nostalgic";

export type FutureIntentType =
    | "plan"
    | "promise"
    | "goal"
    | "wish"
    | "expectation";

export type FutureIntentStatus =
    | "pending"
    | "overdue"
    | "fulfilled"
    | "cancelled";

export type TimePrecision =
    | "exact"
    | "day"
    | "range"
    | "vague"
    | "unknown";

export interface FutureIntentMeta {
    type: FutureIntentType;
    status: FutureIntentStatus;
    targetAt?: string;
    targetEndAt?: string;
    timezone?: string;
    timePrecision?: TimePrecision;
    originalTimeExpression?: string;
    fulfilledAt?: string;
    cancelledAt?: string;
    replacedByMemoryId?: string;
}

export type CognitiveRoom =
    | "living_room"
    | "bedroom"
    | "study"
    | "user_room"
    | "self_room"
    | "attic"
    | "windowsill";

export type MemoryEntry = {
    id: string;
    characterId: string;
    sourceApp: ContentAppId;
    type: "long_term" | "core";
    content: string;
    embedding?: number[];
    importance: number;         // 0-1
    createdAt: string;
    updatedAt: string;
    sourceMessageIds?: string[];

    // Cognitive Memory Layer fields remain optional for old records.
    tags?: string[];
    mood?: MemoryMood;
    kind?: MemoryKind;
    accessCount?: number;
    lastAccessedAt?: string;
    stability?: number;
    futureIntent?: FutureIntentMeta;
    cognitiveRoom?: CognitiveRoom;

    metadata?: Record<string, unknown>;
};

export type MemoryConfig = {
    autoSummarizeEnabled: boolean;          // whether auto-summarization runs after N events
    autoBuildCoreEnabled: boolean;          // whether core memories rebuild after long-term summarization
    vectorRecallEnabled: boolean;           // whether vector embedding recall is used for memory retrieval
    maxLongTermEntries: number;
    summarizationEventInterval: number;     // trigger summarization every N events
    coreSummarizationInterval: number;      // trigger core-memory rebuild every N new long-term memories
    shortTermTokenBudget: number;           // token limit for short-term event log
    coreMemoryTokenBudget: number;          // token limit for injected core memories
    longTermTokenBudget: number;            // token limit for injected long-term memories
    summarizationPrompt: string;            // user-editable prompt template for memory summarization
    coreMemoryPrompt: string;               // user-editable prompt template for core-memory extraction
    vnSummaryPrompt: string;                // user-editable prompt for VN chapter summarization
    // Cognitive Memory Layer feature flags are optional for old saved configs.
    cognitiveMemoryEnabled?: boolean;
    atomicMemoryExtractionEnabled?: boolean;
    futureIntentEnabled?: boolean;
    hybridRecallEnabled?: boolean;
    memoryStabilityEnabled?: boolean;
    memoryLinksEnabled?: boolean;
    shortTermAllowedSources?: {
        chat?: boolean;
        group_chat?: boolean;
        moments?: boolean;
        checkphone?: boolean;
        diary?: boolean;
        xiaohongshu?: boolean;
        interview_magazine?: boolean;
        cocreate?: boolean;
        game?: boolean;
        story?: boolean;
        vn?: boolean;
        adventure?: boolean;
        custom_app?: boolean;
    };
};

export type MemorySearchResult = {
    entry: MemoryEntry;
    score: number;
};

/**
 * Default summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_SUMMARIZATION_PROMPT = `你是一个记忆整理助手。根据以下事件记录，创建一段简洁的事实性总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

事件记录：
{{events}}

要求：
- 只保存具有持续价值的信息；普通寒暄、即时状态、无后续意义的碎片不要保存
- 把互不相关的事件拆成多条原子记忆，不要虚构
- 保留人名、地名、时间、数字、明确承诺、关系变化和用户稳定事实
- 每条记忆包含 2-6 个短标签，并动态判断 importance
- kind 只能是 event、relationship、user_fact、self_fact、knowledge、future_intent
- future_intent 必须附带 futureIntent，分类为 plan、promise、goal、wish 或 expectation
- 最多输出 8 条；没有值得长期保存的内容时输出空数组
- 严格只输出 JSON，不要 Markdown、标题或解释文字

输出格式：
{"memories":[{"content":"...","tags":["..."],"importance":0.8,"kind":"event"}]}`;

/**
 * Default core-memory summarization prompt template.
 * Placeholders: {{char}}, {{earliest}}, {{latest}}, {{events}}
 */
export const DEFAULT_CORE_MEMORY_PROMPT = `你是一个核心记忆整理助手。请根据以下长期记忆记录，为{{char}}整理一段“核心记忆”总结。

角色：{{char}}
时间跨度：{{earliest}} 至 {{latest}}

长期记忆记录：
{{events}}

要求：
- 突出最关键、最稳定、最影响关系判断的事实
- 确认在一起 / 确认分手 / 复合
- 订婚 / 结婚 / 离婚
- 恋爱周年、结婚纪念日、在一起多久
- 明确的长期关系身份（如恋人、前任、配偶）
- 共同生活的重要里程碑（如同居、见家长、共同养宠物）
- 普通日常聊天
- 一般情绪波动
- 暂时性的矛盾或暧昧
- 普通偏好信息
- 任何不确定、推测性的内容
- 用第三人称，事实性描述
- 80-180字
- 不要使用 JSON、列表符号、标题或格式标记

核心记忆总结：`;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
    autoSummarizeEnabled: true,
    autoBuildCoreEnabled: true,
    vectorRecallEnabled: true,
    maxLongTermEntries: 500,
    summarizationEventInterval: 80,
    coreSummarizationInterval: 5,
    shortTermTokenBudget: 100000,
    coreMemoryTokenBudget: 100000,
    longTermTokenBudget: 100000,
    summarizationPrompt: DEFAULT_SUMMARIZATION_PROMPT,
    coreMemoryPrompt: DEFAULT_CORE_MEMORY_PROMPT,
    vnSummaryPrompt: "",
    atomicMemoryExtractionEnabled: true,
    shortTermAllowedSources: {
        chat: true,
        group_chat: true,
        moments: true,
        checkphone: true,
        diary: true,
        xiaohongshu: true,
        interview_magazine: true,
        cocreate: true,
        game: true,
        story: true,
        vn: true,
        adventure: true,
        custom_app: true,
    },
};
