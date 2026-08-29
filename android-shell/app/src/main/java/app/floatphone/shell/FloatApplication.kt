package app.floatphone.shell

import android.app.Activity
import android.app.Application
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * Float 的 Android 壳适配层。
 *
 * 顶部保留系统状态栏，只隐藏底部导航栏。这样左右返回手势不会再先被沉浸式全屏
 * 拿去“唤出系统栏”，第一次侧滑就能作为正常 Android Back 交给 Float 页面处理。
 */
class FloatApplication : Application(), Application.ActivityLifecycleCallbacks {

    override fun onCreate() {
        super.onCreate()
        registerActivityLifecycleCallbacks(this)
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
        if (activity !is MainActivity || activity !is AppCompatActivity) return

        val root = activity.findViewById<ViewGroup>(android.R.id.content)
        val webView = root?.getChildAt(0) as? WebView ?: return

        // MainActivity 旧逻辑仍会尝试进入 immersive；这里在创建完成后覆盖成
        // “顶部状态栏常驻 + 底部导航栏隐藏”，并在窗口重新获得焦点后再次校正。
        installSystemBarPolicy(activity)

        activity.onBackPressedDispatcher.addCallback(activity, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                performFloatBack(activity, webView)
            }
        })
    }

    private fun installSystemBarPolicy(activity: MainActivity) {
        fun applyPolicy() {
            val window = activity.window
            window.statusBarColor = Color.BLACK
            window.navigationBarColor = Color.TRANSPARENT

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val attrs = window.attributes
                attrs.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT
                window.attributes = attrs
            }

            // 页面从系统状态栏下方开始布局，不再延伸进刘海/状态栏区域。
            WindowCompat.setDecorFitsSystemWindows(window, true)
            WindowCompat.getInsetsController(window, window.decorView).apply {
                show(WindowInsetsCompat.Type.statusBars())
                hide(WindowInsetsCompat.Type.navigationBars())
                isAppearanceLightStatusBars = false
                systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }

            // 清掉 MainActivity immersive 中的 FULLSCREEN/LAYOUT_FULLSCREEN，只保留底栏隐藏。
            @Suppress("DEPRECATION")
            run {
                window.decorView.systemUiVisibility = (
                    View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or
                        View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    )
            }
        }

        applyPolicy()
        activity.window.decorView.post { applyPolicy() }

        // MainActivity.onWindowFocusChanged() 会再次调用旧 immersive；延后一拍覆盖回来。
        activity.window.decorView.viewTreeObserver.addOnWindowFocusChangeListener { hasFocus ->
            if (hasFocus) activity.window.decorView.post { applyPolicy() }
        }
    }

    private fun performFloatBack(activity: MainActivity, webView: WebView) {
        val script = """
            (function () {
              try {
                var selectors = [
                  '.page-back-btn',
                  'button[aria-label="返回"]',
                  '[role="button"][aria-label="返回"]'
                ];
                var buttons = Array.prototype.slice.call(
                  document.querySelectorAll(selectors.join(','))
                );
                for (var i = buttons.length - 1; i >= 0; i--) {
                  var button = buttons[i];
                  var style = window.getComputedStyle(button);
                  var rect = button.getBoundingClientRect();
                  if (
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    Number(style.opacity || '1') > 0 &&
                    rect.width > 0 &&
                    rect.height > 0
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
            if (webView.canGoBack()) {
                webView.goBack()
            } else {
                activity.moveTaskToBack(true)
            }
        }
    }

    override fun onActivityStarted(activity: Activity) = Unit

    override fun onActivityResumed(activity: Activity) {
        if (activity is MainActivity) {
            activity.window.decorView.post {
                // 触发已安装的窗口焦点策略；这里额外 requestApplyInsets 让状态栏占位立即生效。
                activity.window.decorView.requestApplyInsets()
            }
        }
    }

    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
}
