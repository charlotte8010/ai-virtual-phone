"use client";

import { useEffect } from "react";

/**
 * Float Android WebView 不需要桌面浏览器式的新窗口。
 * 筑境会先 window.open("", "_blank")，失败后本来就有同页导航 fallback；
 * 某些 Android WebView/ROM 会把这个空白窗口交给系统，导致弹出浏览器“打开方式”。
 * 首页仅在 FloatShell 环境拦住空白 _blank，让调用方自然走自己的 fallback。
 */
export function AndroidPopupGuard() {
  useEffect(() => {
    const shellWindow = window as Window & { AndroidShell?: unknown };
    const isFloatShell =
      typeof shellWindow.AndroidShell !== "undefined" || /FloatShell\//i.test(navigator.userAgent);
    if (!isFloatShell) return;

    const originalOpen = window.open;
    window.open = function guardedOpen(url?: string | URL, target?: string, features?: string) {
      const raw = url == null ? "" : String(url);
      const isBlankPopup = (raw === "" || raw === "about:blank") && target === "_blank";
      if (isBlankPopup) return null;
      return originalOpen.call(window, url as string | URL, target, features);
    } as typeof window.open;

    return () => {
      window.open = originalOpen;
    };
  }, []);

  return null;
}
