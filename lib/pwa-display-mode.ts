export type PwaDisplayPreference = "fullscreen" | "standalone";
export type RuntimePwaDisplayMode = "fullscreen" | "standalone" | "minimal-ui" | "browser";
export type PwaHostedSurface = "custom-app" | "game";

export type PwaHostedSafeArea = {
  top: string;
  right: string;
  bottom: string;
  left: string;
  /* 宿主顶部浮层（胶囊按钮/悬浮返回钮）所在行的几何：想跟宿主按钮同排摆自己
     顶栏的应用用这组值贴行对齐，只需避开水平占位，不必整体让到 top 之下。 */
  barTop: string;
  barHeight: string;
  barClearLeft: string;
  barClearRight: string;
};

/** 宿主实测的浮层几何（px）；缺项用各表面的估算值兜底。 */
export type PwaHostedOverlayMetrics = {
  topPx?: number | null;
  barTopPx?: number | null;
  barHeightPx?: number | null;
  barClearLeftPx?: number | null;
  barClearRightPx?: number | null;
};

export const PWA_DISPLAY_MODE_COOKIE = "pwa_display_mode";
export const PWA_DISPLAY_MODE_CHANGED_EVENT = "pwa-display-mode-changed";
export const DEFAULT_PWA_DISPLAY_PREFERENCE: PwaDisplayPreference = "fullscreen";

let fullscreenRequestAttempted = false;

function decodeCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isInstalledAppSurface(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const shellWindow = window as Window & { AndroidShell?: unknown };
  if (typeof shellWindow.AndroidShell !== "undefined" || /FloatShell\//i.test(navigator.userAgent)) return true;
  if (
    window.matchMedia("(display-mode: fullscreen)").matches
    || window.matchMedia("(display-mode: standalone)").matches
    || window.matchMedia("(display-mode: minimal-ui)").matches
  ) {
    return true;
  }
  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return navigatorWithStandalone.standalone === true;
}

export function readPwaDisplayPreference(cookie: string): PwaDisplayPreference | null {
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${PWA_DISPLAY_MODE_COOKIE}=([^;]+)`));
  if (!match) return null;
  const value = decodeCookieValue(match[1]);
  return value === "fullscreen" || value === "standalone" ? value : null;
}

export function writePwaDisplayPreference(preference: PwaDisplayPreference) {
  if (typeof document === "undefined") return;
  document.cookie = `${PWA_DISPLAY_MODE_COOKIE}=${preference}; path=/; max-age=31536000; samesite=lax`;
  // 用户手动重新选择全屏时，允许再尝试一次浏览器 Fullscreen API。
  fullscreenRequestAttempted = false;
  window.dispatchEvent(new CustomEvent(PWA_DISPLAY_MODE_CHANGED_EVENT, { detail: preference }));
}

/**
 * 普通浏览器保留沉浸全屏，但每次页面生命周期最多请求一次，避免 Chrome 的
 * 「退出全屏」安全提示在每次点击/切回页面时反复出现。安装后的 PWA 和 Android
 * 壳由 manifest / 原生窗口负责沉浸，不调用 Fullscreen API，因此没有这条提示。
 */
export function shouldRequestPwaFullscreen(): boolean {
  if (typeof document === "undefined" || typeof navigator === "undefined") return false;
  if (isInstalledAppSurface()) return false;
  const preference = readPwaDisplayPreference(document.cookie) ?? DEFAULT_PWA_DISPLAY_PREFERENCE;
  if (preference !== "fullscreen" || fullscreenRequestAttempted) return false;
  fullscreenRequestAttempted = true;
  return true;
}

export function getRuntimePwaDisplayMode(): RuntimePwaDisplayMode {
  if (typeof window === "undefined" || typeof document === "undefined") return "browser";
  if (document.fullscreenElement || window.matchMedia("(display-mode: fullscreen)").matches) {
    return "fullscreen";
  }
  if (window.matchMedia("(display-mode: standalone)").matches) {
    return "standalone";
  }
  if (window.matchMedia("(display-mode: minimal-ui)").matches) {
    return "minimal-ui";
  }

  const navigatorWithStandalone = navigator as Navigator & { standalone?: boolean };
  return navigatorWithStandalone.standalone ? "standalone" : "browser";
}

/** 非沉浸布局是否生效：必须用户显式开了「显示系统状态栏」且运行时确实不在全屏。
 *  只看运行时模式是不行的——iOS 装到桌面永远报 standalone，会把没碰过开关的
 *  用户也误判成非沉浸（这正是 pwa-manifest-injector 挂标记前要先过这道门的原因）。 */
export function isNonImmersiveLayoutActive(): boolean {
  if (typeof document === "undefined") return false;
  // Float Android 壳现在固定采用普通 App 布局：顶部状态栏、底部导航栏都常驻。
  // WebView 本身不一定报告 standalone，cookie 也可能还是旧的 fullscreen；
  // 这里直接识别原生壳，避免自定义应用继续按沉浸全屏多预留一截 safe-area。
  if (typeof window !== "undefined" && typeof navigator !== "undefined") {
    const shellWindow = window as Window & { AndroidShell?: unknown };
    if (typeof shellWindow.AndroidShell !== "undefined" || /FloatShell\//i.test(navigator.userAgent)) return true;
  }
  return readPwaDisplayPreference(document.cookie) === "standalone"
    && getRuntimePwaDisplayMode() !== "fullscreen";
}

/** Safe-area values injected into sandboxed apps, which cannot inherit host CSS variables.
 *  measured：宿主实测的浮层几何，优先于估算值——壳布局以后再调整时数字不会失真。
 *  top 是"完全让开浮层"的保守值；bar* 描述浮层那一行本身，供想同排摆按钮的应用用。 */
export function getPwaHostedSafeArea(surface: PwaHostedSurface, embedded = false, measured?: PwaHostedOverlayMetrics): PwaHostedSafeArea {
  if (embedded) {
    return { top: "0px", right: "0px", bottom: "0px", left: "0px", barTop: "0px", barHeight: "0px", barClearLeft: "0px", barClearRight: "0px" };
  }

  const nonImmersive = isNonImmersiveLayoutActive();
  const px = (value: number | null | undefined, fallback: number) =>
    `${value != null && value > 0 ? Math.round(value) : fallback}px`;
  // 兜底估算与两个浮层的 CSS 定位保持一致（app-market.css 胶囊 / game.css 悬浮返回钮）：
  // top = 浮层 top + 浮层高 + 4px 间隙。浮层的 top 偏移与这段间隙都已从 8px 收到 4px，
  // 兜底值同步跟着减，免得实测拿不到时又冒出一条比实际更宽的留白。
  const isGame = surface === "game";
  return {
    top: px(measured?.topPx, nonImmersive ? (isGame ? 52 : 40) : (isGame ? 84 : 80)),
    right: "16px",
    bottom: "24px",
    left: "16px",
    barTop: px(measured?.barTopPx, isGame ? 38 : (nonImmersive ? 4 : 52)),
    barHeight: px(measured?.barHeightPx, isGame ? 44 : 30),
    barClearLeft: px(measured?.barClearLeftPx, isGame ? 66 : 0),
    barClearRight: px(measured?.barClearRightPx, isGame ? 0 : 96),
  };
}
