export type MemoryExtractionTimelineEntry = {
    id: string;
    sourceApp: string;
    timestamp: string;
    content: string;
};

export function formatMemoryExtractionTimelineEntry(
    entry: MemoryExtractionTimelineEntry,
    formattedContent: string,
): string {
    return `[event_ref=${entry.id}] [source_app=${entry.sourceApp}] [event_time=${entry.timestamp}] ${formattedContent}`;
}

export function resolveMemorySourceApp(
    sourceEventRefs: string[] | undefined,
    entries: readonly MemoryExtractionTimelineEntry[],
    fallbackSourceApp: string,
): string {
    if (!sourceEventRefs?.length) return fallbackSourceApp;
    const refs = new Set(sourceEventRefs);
    const sourceCounts = new Map<string, number>();
    for (const entry of entries) {
        if (!refs.has(entry.id)) continue;
        sourceCounts.set(entry.sourceApp, (sourceCounts.get(entry.sourceApp) ?? 0) + 1);
    }

    let selectedSource = fallbackSourceApp;
    let selectedCount = 0;
    for (const [sourceApp, count] of sourceCounts) {
        if (count > selectedCount) {
            selectedSource = sourceApp;
            selectedCount = count;
        }
    }
    return selectedSource;
}
