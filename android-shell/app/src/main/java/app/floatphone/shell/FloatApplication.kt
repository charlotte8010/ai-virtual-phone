package app.floatphone.shell

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity

/**
 * 让 Android 系统返回键/侧滑返回优先走 Float 页面自己的返回逻辑。
 *
 * Float 的标准页面统一使用 .page-back-btn；直接触发它，等价于用户点击页面左上角返回，
 * 因此能正确处理设置子页、overrideBack 等 React 内部状态，而不是只依赖 WebView URL 历史。
 * 找不到可见返回键时，再交回 MainActivity 原有的 WebView 返回/退后台逻辑。
 */
class FloatApplication : Application(), Application.ActivityLifecycleCallbacks {

    override fun onCreate() {
        super.onCreate()
        registerActivityLifecycleCallbacks(this)
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
        if (activity !is MainActivity || activity !is AppCompatActivity) return

        activity.onBackPressedDispatcher.addCallback(activity, object : OnBackPressedCallback(true) {
            private var dispatchInFlight = false

            override fun handleOnBackPressed() {
                if (dispatchInFlight) return
                dispatchInFlight = true

                val root = activity.findViewById<ViewGroup>(android.R.id.content)
                val webView = root?.getChildAt(0) as? WebView
                if (webView == null) {
                    dispatchInFlight = false
                    fallThrough(activity)
                    return
                }

                val script = """
                    (function () {
                      try {
                        var buttons = Array.prototype.slice.call(
                          document.querySelectorAll('button.page-back-btn[aria-label="返回"]')
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
                    dispatchInFlight = false
                    if (handled == "true") return@evaluateJavascript
                    fallThrough(activity)
                }
            }

            private fun fallThrough(activity: AppCompatActivity) {
                // 临时停用自己，让 MainActivity 原有 callback 接手：WebView.goBack() / 退后台。
                isEnabled = false
                activity.onBackPressedDispatcher.onBackPressed()
                isEnabled = true
            }
        })
    }

    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
}
