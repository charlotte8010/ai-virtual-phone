from pathlib import Path

main = Path('android-shell/app/src/main/java/app/floatphone/shell/MainActivity.kt')
text = main.read_text(encoding='utf-8')

old_bars = '''    /**
     * Samsung / 国产 ROM 对隐藏 systemBars 的实现并不完全一致：
     * WindowInsets 隐藏了图标后，仍可能给刘海区和手势区留黑色占位。
     * 这里同时使用现代 Insets API + 传统 immersive sticky，并显式允许内容进入 cutout。
     */
    @Suppress("DEPRECATION")
    private fun enterImmersiveMode() {
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val attrs = window.attributes
            attrs.layoutInDisplayCutoutMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
            } else {
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
            window.attributes = attrs
        }

        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }

        // 旧式 flags 作为 OEM 兼容兜底，解决“图标没了但黑边还在”的情况。
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
            )
    }
'''

new_bars = '''    /**
     * App 模式：顶部 Android 状态栏常驻，只隐藏底部导航栏。
     * 不再进入真正的全屏/沉浸式布局，避免侧滑返回先被系统用于“唤出状态栏”。
     */
    @Suppress("DEPRECATION")
    private fun enterImmersiveMode() {
        window.statusBarColor = Color.BLACK
        window.navigationBarColor = Color.TRANSPARENT

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val attrs = window.attributes
            attrs.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT
            window.attributes = attrs
        }

        // WebView 从状态栏下方开始布局；顶部栏始终可见。
        WindowCompat.setDecorFitsSystemWindows(window, true)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            show(WindowInsetsCompat.Type.statusBars())
            hide(WindowInsetsCompat.Type.navigationBars())
            isAppearanceLightStatusBars = false
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }

        // 清掉 FULLSCREEN / LAYOUT_FULLSCREEN / IMMERSIVE_STICKY，只保留底部导航隐藏。
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
    }
'''

if old_bars not in text:
    raise SystemExit('old system bar block not found')
text = text.replace(old_bars, new_bars, 1)

old_back = '''        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
            }
        })
'''

new_back = '''        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Float 大部分内部页面不产生 WebView URL 历史，而是靠页面自己的返回按钮切状态。
                // 系统返回/侧滑先触发当前可见的页面返回按钮；没有按钮时再退 WebView 历史/后台。
                val script = """
                    (function () {
                      try {
                        var selectors = [
                          '.page-back-btn',
                          'button[aria-label="返回"]',
                          '[role="button"][aria-label="返回"]'
                        ];
                        var buttons = Array.prototype.slice.call(document.querySelectorAll(selectors.join(',')));
                        for (var i = buttons.length - 1; i >= 0; i--) {
                          var button = buttons[i];
                          var style = window.getComputedStyle(button);
                          var rect = button.getBoundingClientRect();
                          if (
                            style.display !== 'none' &&
                            style.visibility !== 'hidden' &&
                            Number(style.opacity || '1') > 0 &&
                            rect.width > 0 && rect.height > 0 &&
                            rect.bottom > 0 && rect.right > 0 &&
                            rect.top < window.innerHeight && rect.left < window.innerWidth
                          ) {
                            button.click();
                            return true;
                          }
                        }
                      } catch (_) {}
                      return false;
                    })();
                """.trimIndent()

                webView.evaluateJavascript(script) { handled ->
                    if (handled == "true") return@evaluateJavascript
                    if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
                }
            }
        })
'''

if old_back not in text:
    raise SystemExit('old back callback not found')
text = text.replace(old_back, new_back, 1)
text = text.replace('Float 小手机安卓壳：全屏 WebView 直接加载线上站点。', 'Float 小手机安卓壳：原生 WebView 直接加载线上站点。', 1)
main.write_text(text, encoding='utf-8')

manifest = Path('android-shell/app/src/main/AndroidManifest.xml')
mtext = manifest.read_text(encoding='utf-8')
mtext = mtext.replace('        android:name=".FloatApplication"\n', '', 1)
manifest.write_text(mtext, encoding='utf-8')

legacy = Path('android-shell/app/src/main/java/app/floatphone/shell/FloatApplication.kt')
if legacy.exists():
    legacy.unlink()

print('patched MainActivity system bars/back and removed FloatApplication')
