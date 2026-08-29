"use client";

// components/chat-plugin-bootstrap.tsx
// 聊天插件运行时启动引导：应用挂载后加载全部启用插件。
// 放在根布局，保证插件的 hook 在用户进入聊天前就已注册。

import { useEffect } from "react";
import { getChatPluginRuntime } from "@/lib/chat-plugin-runtime";
import { loadChatPlugins, setChatPluginEnabled } from "@/lib/chat-plugin-storage";

export function ChatPluginBootstrap() {
    useEffect(() => {
        void getChatPluginRuntime().ensureStarted();

        // 兼容一类直接往 document.body/head 注入 canvas / style 的“动态背景”插件。
        // 它们自己的“关闭动态背景”常只停动画、不清 DOM，结果留下全屏遮罩。
        // 捕获这个明确的关闭动作后，只禁用源码/名称对应的动态背景插件，并硬刷新一次：
        // enabled 状态先持久化，所以刷新后插件不会重启，残留 DOM/CSS/定时器也全部被浏览器清掉。
        const handleDynamicBackgroundClose = (event: MouseEvent) => {
            const target = event.target instanceof Element
                ? event.target.closest("button, [role='button'], a")
                : null;
            const label = target?.textContent?.replace(/\s+/g, " ").trim() ?? "";
            if (label !== "关闭动态背景") return;

            window.setTimeout(() => {
                const candidates = loadChatPlugins().filter(plugin =>
                    plugin.enabled
                    && (
                        plugin.code.includes("关闭动态背景")
                        || /动态.*背景|背景.*动态/.test(plugin.manifest.name)
                    )
                );
                if (candidates.length === 0) return;
                for (const plugin of candidates) setChatPluginEnabled(plugin.manifest.id, false);
                window.setTimeout(() => window.location.reload(), 80);
            }, 0);
        };

        document.addEventListener("click", handleDynamicBackgroundClose, true);
        return () => document.removeEventListener("click", handleDynamicBackgroundClose, true);
    }, []);
    return null;
}
