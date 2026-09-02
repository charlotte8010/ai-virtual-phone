"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Brain, CheckCircle2, RefreshCw, ShieldCheck } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import {
    applyLegacyCoreMemoryBackfill,
    previewLegacyCoreMemoryBackfill,
    type LegacyCoreBackfillPreview,
} from "@/lib/core-memory-builder";
import { hydrateKvDb } from "@/lib/kv-db";
import type { Character } from "@/lib/character-types";

export default function LegacyCoreBackfillPage() {
    const [characters, setCharacters] = useState<Character[]>([]);
    const [characterId, setCharacterId] = useState("");
    const [loadingCharacters, setLoadingCharacters] = useState(true);
    const [preview, setPreview] = useState<LegacyCoreBackfillPreview | null>(null);
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState("");
    const [applied, setApplied] = useState(false);

    useEffect(() => {
        let cancelled = false;

        const hydrateAndLoadCharacters = async () => {
            try {
                await hydrateKvDb();
                if (cancelled) return;
                const loaded = loadCharacters();
                setCharacters(loaded);
                setCharacterId(current => current || loaded[0]?.id || "");
                if (loaded.length === 0) {
                    setNotice("没有读取到角色。请确认当前页面与原 Float 使用同一站点域名，且不要卸载 App。 ");
                }
            } catch (error) {
                if (!cancelled) setNotice(`读取角色失败: ${String(error)}`);
            } finally {
                if (!cancelled) setLoadingCharacters(false);
            }
        };

        void hydrateAndLoadCharacters();
        return () => {
            cancelled = true;
        };
    }, []);

    const selectedCharacter = useMemo(
        () => characters.find(character => character.id === characterId) ?? null,
        [characters, characterId],
    );

    const runPreview = async () => {
        if (!selectedCharacter || busy) return;
        setBusy(true);
        setNotice("");
        setPreview(null);
        setApplied(false);
        try {
            const result = await previewLegacyCoreMemoryBackfill(selectedCharacter.id, selectedCharacter.name);
            if (!result.success) {
                setNotice(result.error);
                return;
            }
            setPreview(result.preview);
        } catch (error) {
            setNotice(`预览失败: ${String(error)}`);
        } finally {
            setBusy(false);
        }
    };

    const applyPreview = async () => {
        if (!preview || busy) return;
        setBusy(true);
        setNotice("");
        try {
            const result = await applyLegacyCoreMemoryBackfill(preview);
            if (!result.success) {
                setNotice(result.error);
                return;
            }
            setApplied(true);
            setNotice(
                `整理完成：${result.longTermCount} 条旧长期记忆 → 1 条去重后的自动核心记忆；`
                + `替换 ${result.replacedCoreCount} 条旧自动 Core，保留 ${result.preservedCoreCount} 条手工/已编辑 Core。`,
            );
        } catch (error) {
            setNotice(`应用失败: ${String(error)}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <main
            className="h-[100dvh] overflow-y-auto overscroll-contain touch-pan-y bg-background text-foreground px-4 py-6"
            style={{ WebkitOverflowScrolling: "touch" }}
        >
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 pb-8">
                <div className="flex items-center gap-3">
                    <button
                        type="button"
                        className="ui-btn ui-btn-outline px-3 py-2"
                        onClick={() => window.history.back()}
                    >
                        <ArrowLeft size={16} />
                    </button>
                    <div>
                        <h1 className="text-xl font-semibold">Legacy Core Backfill</h1>
                        <p className="ts-12 text-secondary">一次性旧长期记忆整理，不改日常 Float Core lifecycle。</p>
                    </div>
                </div>

                <section className="g-card p-4 flex flex-col gap-3">
                    <div className="flex items-start gap-3">
                        <ShieldCheck size={20} className="mt-0.5 shrink-0" />
                        <div className="ts-13 leading-relaxed text-secondary">
                            预览阶段不会写库。应用时会重新校验源数据；手工新增或用户编辑过的核心记忆会保留，
                            旧自动核心记忆会和全部旧长期记忆一起参与去重整理。Future Intent 不会进入 Core。
                        </div>
                    </div>
                </section>

                <section className="g-card p-4 flex flex-col gap-3">
                    <label className="ts-12 text-secondary" htmlFor="legacy-core-character">选择角色</label>
                    <select
                        id="legacy-core-character"
                        className="ui-input w-full"
                        value={characterId}
                        disabled={loadingCharacters || busy || applied}
                        onChange={event => {
                            setCharacterId(event.target.value);
                            setPreview(null);
                            setNotice("");
                            setApplied(false);
                        }}
                    >
                        {loadingCharacters ? <option value="">正在读取角色...</option> : null}
                        {!loadingCharacters && characters.length === 0 ? <option value="">未读取到角色</option> : null}
                        {characters.map(character => (
                            <option key={character.id} value={character.id}>{character.name}</option>
                        ))}
                    </select>
                    <button
                        type="button"
                        className="ui-btn ui-btn-primary w-full py-2.5"
                        disabled={loadingCharacters || !selectedCharacter || busy || applied}
                        onClick={() => void runPreview()}
                    >
                        <RefreshCw size={15} className="mr-1.5" />
                        {loadingCharacters ? "正在读取角色..." : busy && !preview ? "正在整理预览..." : "生成整理预览"}
                    </button>
                </section>

                {preview ? (
                    <section className="g-card p-4 flex flex-col gap-4">
                        <div className="flex items-center gap-2">
                            <Brain size={18} />
                            <h2 className="font-semibold">预览结果</h2>
                        </div>

                        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                            <Stat label="旧长期记忆" value={preview.longTermCount} />
                            <Stat label="替换自动 Core" value={preview.replaceCoreIds.length} />
                            <Stat label="保留手工 Core" value={preview.preserveCoreIds.length} />
                            <Stat label="输出自动 Core" value={1} />
                        </div>

                        <div className="rounded-xl border border-border p-3">
                            <div className="ts-11 text-secondary mb-2">
                                历史跨度：{formatDate(preview.earliest)} → {formatDate(preview.latest)}
                            </div>
                            <p className="ts-14 leading-relaxed whitespace-pre-wrap">{preview.candidate.content}</p>
                        </div>

                        <div className="ts-12 text-secondary leading-relaxed">
                            应用后，上面的候选 Core 会以历史截止时间作为 createdAt，因此不会显示成“刚刚”。
                            正常 Core 增量游标会推进到 {formatDate(preview.latest)}，之后的新长期记忆继续按 Float 逻辑处理。
                        </div>

                        <button
                            type="button"
                            className="ui-btn ui-btn-primary w-full py-2.5"
                            disabled={busy || applied}
                            onClick={() => void applyPreview()}
                        >
                            <CheckCircle2 size={15} className="mr-1.5" />
                            {busy ? "正在应用..." : applied ? "已应用" : "确认应用这次整理"}
                        </button>
                    </section>
                ) : null}

                {notice ? (
                    <section className="g-card p-4 ts-13 leading-relaxed">
                        {notice}
                    </section>
                ) : null}
            </div>
        </main>
    );
}

function Stat({ label, value }: { label: string; value: number }) {
    return (
        <div className="rounded-xl border border-border px-3 py-2">
            <div className="ts-11 text-secondary">{label}</div>
            <div className="text-lg font-semibold mt-1">{value}</div>
        </div>
    );
}

function formatDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
    });
}
