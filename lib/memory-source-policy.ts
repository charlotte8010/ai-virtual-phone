export type MemorySourceRules = Record<string, boolean | undefined>;

/** Shared source switch policy for native timeline and event-triggered detectors. */
export function isMemorySourceAllowed(
    sourceApp: string,
    sourceDetail: string | undefined,
    allowed?: MemorySourceRules,
): boolean {
    const rules = allowed ?? {};
    if (sourceApp === "chat") {
        if (sourceDetail === "group") return rules.group_chat !== false;
        return rules.chat !== false;
    }
    if (sourceApp === "story") return rules.story !== false;
    if (sourceApp === "vn") return rules.vn !== false;
    if (sourceApp === "map") return rules.adventure !== false;
    return rules[sourceApp] !== false;
}
