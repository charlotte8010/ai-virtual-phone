from pathlib import Path

ROOT = Path('.')

def replace_once(path: str, old: str, new: str):
    p = ROOT / path
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'needle not found in {path}: {old[:100]!r}')
    text = text.replace(old, new, 1)
    p.write_text(text, encoding='utf-8')

# 1) Android WebView: only main-frame external navigation may leave Float.
# Sandboxed custom apps live in iframes; their own navigation must never launch the phone browser.
replace_once(
    'android-shell/app/src/main/java/app/floatphone/shell/MainActivity.kt',
    '''            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {\n                val url = request.url\n                val scheme = url.scheme ?: return false\n''',
    '''            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {\n                // 自定义应用运行在 sandbox iframe 中。子 frame 的导航属于应用内部行为，\n                // 不能按“整个 Float 打开外链”处理，否则筑境等应用一点击就会跳系统浏览器。\n                if (!request.isForMainFrame) return false\n                val url = request.url\n                val scheme = url.scheme ?: return false\n''',
)

# 2) Safe area: Android shell now deliberately keeps both system bars visible.
replace_once(
    'lib/pwa-display-mode.ts',
    '''export function isNonImmersiveLayoutActive(): boolean {\n  if (typeof document === "undefined") return false;\n  return readPwaDisplayPreference(document.cookie) === "standalone"\n    && getRuntimePwaDisplayMode() !== "fullscreen";\n}\n''',
    '''export function isNonImmersiveLayoutActive(): boolean {\n  if (typeof document === "undefined") return false;\n  // Float Android 壳现在固定采用普通 App 布局：顶部状态栏、底部导航栏都常驻。\n  // WebView 本身不一定报告 standalone，cookie 也可能还是旧的 fullscreen；\n  // 这里直接识别原生壳，避免自定义应用继续按沉浸全屏多预留一截 safe-area。\n  if (typeof window !== "undefined" && typeof navigator !== "undefined") {\n    const shellWindow = window as Window & { AndroidShell?: unknown };\n    if (typeof shellWindow.AndroidShell !== "undefined" || /FloatShell\\//i.test(navigator.userAgent)) return true;\n  }\n  return readPwaDisplayPreference(document.cookie) === "standalone"\n    && getRuntimePwaDisplayMode() !== "fullscreen";\n}\n''',
)

# 3) Custom app srcDoc: always get a viewport, sane mobile sizing, and browser-like close/back compatibility.
replace_once(
    'components/app-market/custom-app-runner.tsx',
    '''html, body { min-height: 100%; }\n* { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }\n''',
    '''html, body {\n  width: 100%;\n  min-width: 0;\n  max-width: 100%;\n  min-height: 100%;\n  margin: 0;\n  overflow-x: hidden;\n}\n* { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }\n''',
)

replace_once(
    'components/app-market/custom-app-runner.tsx',
    '''  var seq = 0;\n\n  // ── 首屏失败上报 ──\n''',
    '''  var seq = 0;\n\n  // ── 导入应用的“返回/关闭”兼容 ──\n  // 很多独立 HTML 小应用会用 window.close() 或 history.back() 当“返回宿主”。\n  // 在 sandbox iframe 里 window.close() 默认无效；history.back() 也可能退到 about:blank。\n  // 给 iframe 压一层根哨兵：应用有自己的 history 时照常逐层返回，退到根时再关闭 Float 子应用。\n  try {\n    var rootState = { __aiPhoneAppRoot: true };\n    var guardState = { __aiPhoneAppGuard: true };\n    history.replaceState(rootState, '', location.href);\n    history.pushState(guardState, '', location.href);\n    window.addEventListener('popstate', function(event){\n      if (event && event.state && event.state.__aiPhoneAppRoot) {\n        try { request('app.close'); } catch (_) {}\n        try { history.forward(); } catch (_) {}\n      }\n    });\n  } catch (_) {}\n  try {\n    window.close = function(){\n      try { request('app.close'); } catch (_) {}\n    };\n  } catch (_) {}\n\n  // 导入应用里 _top/_parent/_blank 往往只是从“独立网页”时代留下的写法。\n  // 在 Float 里把它收回当前 iframe，避免越过宿主或触发 Android 外部浏览器。\n  document.addEventListener('click', function(event){\n    try {\n      var node = event && event.target;\n      var anchor = node && node.closest ? node.closest('a[href]') : null;\n      if (!anchor) return;\n      var target = String(anchor.getAttribute('target') || '').toLowerCase();\n      if (target !== '_blank' && target !== '_top' && target !== '_parent') return;\n      event.preventDefault();\n      var href = anchor.href;\n      if (href) window.location.href = href;\n    } catch (_) {}\n  }, true);\n\n  // ── 首屏失败上报 ──\n''',
)

replace_once(
    'components/app-market/custom-app-runner.tsx',
    '''  const safeBridge = bridge;\n  if (/<head[\\s>]/i.test(base)) {\n    return base.replace(/<head([^>]*)>/i, `<head$1>${safeBridge}`);\n  }\n''',
    '''  // 有些导入包自己带完整 <html>，但没写 viewport；之前只有“片段 HTML”分支会补，\n  // Android 上就会按桌面宽度缩放。无论包形态都保证 viewport 存在。\n  const viewport = /<meta[^>]+name=["']viewport["']/i.test(base)\n    ? ""\n    : `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />`;\n  const safeBridge = `${viewport}${bridge}`;\n  if (/<head[\\s>]/i.test(base)) {\n    return base.replace(/<head([^>]*)>/i, `<head$1>${safeBridge}`);\n  }\n''',
)

replace_once(
    'components/app-market/custom-app-runner.tsx',
    '''          <button type="button" className="cap-btn" onClick={onClose} aria-label={closeLabel}>\n''',
    '''          <button data-float-back="true" type="button" className="cap-btn" onClick={onClose} aria-label={closeLabel}>\n''',
)

# 4) Dynamic-background compatibility: plugin-owned "关闭动态背景" means disable that plugin for real,
# then reload once to clear arbitrary canvas/style/DOM that an unsafe plugin appended outside ctx disposables.
bootstrap = ROOT / 'components/chat-plugin-bootstrap.tsx'
bootstrap.write_text('''"use client";\n\n// components/chat-plugin-bootstrap.tsx\n// 聊天插件运行时启动引导：应用挂载后加载全部启用插件。\n// 放在根布局，保证插件的 hook 在用户进入聊天前就已注册。\n\nimport { useEffect } from "react";\nimport { getChatPluginRuntime } from "@/lib/chat-plugin-runtime";\nimport { loadChatPlugins, setChatPluginEnabled } from "@/lib/chat-plugin-storage";\n\nexport function ChatPluginBootstrap() {\n    useEffect(() => {\n        void getChatPluginRuntime().ensureStarted();\n\n        // 兼容一类直接往 document.body/head 注入 canvas / style 的“动态背景”插件。\n        // 它们自己的“关闭动态背景”常只停动画、不清 DOM，结果留下全屏遮罩。\n        // 捕获这个明确的关闭动作后，只禁用源码/名称对应的动态背景插件，并硬刷新一次：\n        // enabled 状态先持久化，所以刷新后插件不会重启，残留 DOM/CSS/定时器也全部被浏览器清掉。\n        const handleDynamicBackgroundClose = (event: MouseEvent) => {\n            const target = event.target instanceof Element\n                ? event.target.closest("button, [role='button'], a")\n                : null;\n            const label = target?.textContent?.replace(/\\s+/g, " ").trim() ?? "";\n            if (label !== "关闭动态背景") return;\n\n            window.setTimeout(() => {\n                const candidates = loadChatPlugins().filter(plugin =>\n                    plugin.enabled\n                    && (\n                        plugin.code.includes("关闭动态背景")\n                        || /动态.*背景|背景.*动态/.test(plugin.manifest.name)\n                    )\n                );\n                if (candidates.length === 0) return;\n                for (const plugin of candidates) setChatPluginEnabled(plugin.manifest.id, false);\n                window.setTimeout(() => window.location.reload(), 80);\n            }, 0);\n        };\n\n        document.addEventListener("click", handleDynamicBackgroundClose, true);\n        return () => document.removeEventListener("click", handleDynamicBackgroundClose, true);\n    }, []);\n    return null;\n}\n''', encoding='utf-8')

print('patched custom app navigation/layout, Android iframe handling, and dynamic background cleanup')
