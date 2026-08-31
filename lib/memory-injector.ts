// Formats selected memory entries into natural prompt text.

import type { MemoryEntry } from "./memory-types";

export interface MemoryPromptFormatOptions {
    now?: Date;
    timezone?: string;
}

function calendarDayKey(value: Date, timezone?: string): string {
    if (timezone) {
        try {
            const parts = new Intl.DateTimeFormat("en-US", {
                timeZone: timezone,
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
            }).formatToParts(value);
            const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
            return `${fields.year}-${fields.month}-${fields.day}`;
        } catch {
            // Invalid user time zones fall back to UTC.
        }
    }
    return value.toISOString().slice(0, 10);
}

function futureIntentLabel(entry: MemoryEntry, options: MemoryPromptFormatOptions): string {
    const intent = entry.futureIntent;
    if (!intent) return "[近期计划]";
    if (intent.status === "overdue") return "[已过期未确认]";
    const targetAt = intent.targetAt ? new Date(intent.targetAt) : undefined;
    if (!targetAt || !Number.isFinite(targetAt.getTime())) return "[近期计划]";
    const now = options.now ?? new Date();
    const targetDay = calendarDayKey(targetAt, options.timezone);
    const today = calendarDayKey(now, options.timezone);
    const tomorrow = calendarDayKey(new Date(now.getTime() + 24 * 60 * 60 * 1000), options.timezone);
    if (targetDay === today) return "[今天]";
    if (targetDay === tomorrow) return "[明天]";
    return `[${targetDay}]`;
}

function formatLine(entry: MemoryEntry, prefix = ""): string {
    return `- ${prefix}${entry.content.trim()}`;
}

/**
 * Format selected long-term memories as stable facts plus current plans.
 * Internal ids, scores, and storage terminology are intentionally omitted.
 */
export function formatLongTermMemories(
    memories: MemoryEntry[],
    options: MemoryPromptFormatOptions = {},
): string {
    if (memories.length === 0) return "";

    const futureIntents = memories.filter(entry => (
        entry.kind === "future_intent"
        && ["pending", "overdue"].includes(entry.futureIntent?.status ?? "")
    ));
    const relatedMemories = memories.filter(entry => !futureIntents.includes(entry));
    const sections: string[] = [];
    if (relatedMemories.length > 0) {
        sections.push(`## 当前相关记忆\n${relatedMemories.map(entry => formatLine(entry)).join("\n")}`);
    }
    if (futureIntents.length > 0) {
        sections.push(`## 近期计划与约定\n${futureIntents
            .map(entry => formatLine(entry, `${futureIntentLabel(entry, options)} `))
            .join("\n")}`);
    }
    return sections.join("\n\n");
}

export function formatCoreMemories(memories: MemoryEntry[]): string {
    if (memories.length === 0) return "";
    return `## 稳定核心记忆\n${memories.map(entry => formatLine(entry)).join("\n")}`;
}
