package app.floatphone.shell

import android.app.Activity
import android.app.Application
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.view.MotionEvent
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Float 的原生返回适配层。
 *
 * 沉浸式全屏下，Android 会优先占用左右边缘手势：第一次侧滑常被拿去临时显示
 * system bars，随后再次侧滑才触发系统 Back。为了让 Float 像普通 App 一样在页面内返回，
 * Android 10+ 把左右极窄边缘从系统手势区排除，并由 WebView 自己识别向内侧滑。
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

        installEdgeBackGesture(activity, webView)

        // 物理返回键 / 三键导航 / 未被排除区域产生的系统 Back 也走同一套 Float 返回逻辑。
        activity.onBackPressedDispatcher.addCallback(activity, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                performFloatBack(activity, webView)
            }
        })
    }

    private fun installEdgeBackGesture(activity: MainActivity, webView: WebView) {
        val density = resources.displayMetrics.density
        // 只占最边缘，尽量不影响页面左上角返回按钮等正常点击。
        val edgeWidthPx = (24f * density).roundToInt()
        val triggerDistancePx = (64f * density).roundToInt()

        fun updateGestureExclusion() {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
            if (webView.width <= 0 || webView.height <= 0) return
            webView.systemGestureExclusionRects = listOf(
                Rect(0, 0, edgeWidthPx, webView.height),
                Rect(webView.width - edgeWidthPx, 0, webView.width, webView.height),
            )
        }

        webView.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ ->
            updateGestureExclusion()
        }
        webView.post { updateGestureExclusion() }

        var tracking = false
        var fromLeft = false
        var downX = 0f
        var downY = 0f

        webView.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    val startsLeft = event.x <= edgeWidthPx
                    val startsRight = event.x >= webView.width - edgeWidthPx
                    tracking = startsLeft || startsRight
                    fromLeft = startsLeft
                    if (tracking) {
                        downX = event.x
                        downY = event.y
                    }
                    tracking
                }

                MotionEvent.ACTION_MOVE -> tracking

                MotionEvent.ACTION_UP -> {
                    if (!tracking) {
                        false
                    } else {
                        val dx = event.x - downX
                        val dy = event.y - downY
                        val horizontalEnough = abs(dx) >= triggerDistancePx && abs(dx) > abs(dy) * 1.2f
                        val correctDirection = if (fromLeft) dx > 0 else dx < 0
                        tracking = false
                        if (horizontalEnough && correctDirection) {
                            performFloatBack(activity, webView)
                        }
                        true
                    }
                }

                MotionEvent.ACTION_CANCEL -> {
                    val wasTracking = tracking
                    tracking = false
                    wasTracking
                }

                else -> tracking
            }
        }
    }

    private fun performFloatBack(activity: MainActivity, webView: WebView) {
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
            if (handled == "true") return@evaluateJavascript
            if (webView.canGoBack()) {
                webView.goBack()
            } else {
                activity.moveTaskToBack(true)
            }
        }
    }

    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
}
