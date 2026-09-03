package app.floatphone.shell

import android.app.Activity
import android.app.Application
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.app.NotificationCompat
import java.lang.ref.WeakReference

/**
 * App-level WebView bridge for normal chat notifications.
 *
 * Float's web UI already emits `ai-chat-message-notice` whenever a visible
 * assistant/chat message is published. Browser notifications are unreliable
 * inside Android WebView, so the shell listens to that existing event and
 * renders it as a native Android notification while the document is hidden.
 *
 * Offline/scheduled pushes continue to use PushService + Supabase Realtime.
 */
class FloatApplication : Application(), Application.ActivityLifecycleCallbacks {

    companion object {
        private const val CH_MESSAGES = "shell_messages"
        private const val CH_KEEPALIVE = "shell_keepalive"
        private const val NOTIF_MESSAGE_ID = 100
        private const val REINJECT_INTERVAL_MS = 2_000L
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private var currentActivity = WeakReference<Activity>(null)
    private var currentWebView = WeakReference<WebView>(null)
    private val nativeBridge by lazy { NativeChatNotificationBridge(this) }

    private val reinject = object : Runnable {
        override fun run() {
            val activity = currentActivity.get()
            if (activity is MainActivity && !activity.isFinishing && !activity.isDestroyed) {
                val webView = findWebView(activity.window.decorView)
                if (webView != null) attachBridge(webView)
                mainHandler.postDelayed(this, REINJECT_INTERVAL_MS)
            }
        }
    }

    override fun onCreate() {
        super.onCreate()
        ensureNotificationChannels()
        registerActivityLifecycleCallbacks(this)
    }

    override fun onActivityResumed(activity: Activity) {
        if (activity !is MainActivity) return
        currentActivity = WeakReference(activity)
        mainHandler.removeCallbacks(reinject)
        mainHandler.post(reinject)
    }

    override fun onActivityPaused(activity: Activity) {
        // Keep the already-installed JS listener alive while the Activity is
        // backgrounded/locked. We only stop the periodic reinjection loop.
        if (currentActivity.get() === activity) {
            mainHandler.removeCallbacks(reinject)
        }
    }

    override fun onActivityDestroyed(activity: Activity) {
        if (currentActivity.get() === activity) {
            mainHandler.removeCallbacks(reinject)
            currentActivity.clear()
            currentWebView.clear()
        }
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    private fun findWebView(view: View?): WebView? {
        if (view == null) return null
        if (view is WebView) return view
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                findWebView(view.getChildAt(index))?.let { return it }
            }
        }
        return null
    }

    private fun attachBridge(webView: WebView) {
        if (currentWebView.get() !== webView) {
            webView.addJavascriptInterface(nativeBridge, "FloatNativePush")
            currentWebView = WeakReference(webView)
        }

        // Page navigation replaces the JS global, so this small idempotent
        // installer is re-run while MainActivity is visible.
        webView.evaluateJavascript(
            """
            (function () {
              try {
                if (window.__floatNativePushNoticeInstalled) return;
                window.__floatNativePushNoticeInstalled = true;
                window.addEventListener('ai-chat-message-notice', function (event) {
                  try {
                    // Match normal mobile messaging behaviour: do not show a
                    // system notification while the Float window is visible.
                    if (!document.hidden) return;
                    var detail = event && event.detail ? event.detail : {};
                    var body = String(detail.body || '').trim();
                    if (!body) return;
                    var title = String(detail.senderName || 'Float').trim() || 'Float';
                    if (window.FloatNativePush && window.FloatNativePush.notifyMessage) {
                      window.FloatNativePush.notifyMessage(title, body);
                    }
                  } catch (_) {}
                });
              } catch (_) {}
            })();
            """.trimIndent(),
            null,
        )
    }

    private fun ensureNotificationChannels() {
        val manager = getSystemService(NotificationManager::class.java)

        // Same channel IDs as PushService. Creating them here first also gives
        // the channel the correct lock-screen privacy policy for both live chat
        // notices and Realtime/offline notices.
        manager.createNotificationChannel(
            NotificationChannel(CH_MESSAGES, "角色消息", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "角色发来的消息"
                lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CH_KEEPALIVE, "后台连接", NotificationManager.IMPORTANCE_MIN).apply {
                description = "维持角色消息接收通道"
                setShowBadge(false)
                lockscreenVisibility = Notification.VISIBILITY_SECRET
            },
        )
    }

    private class NativeChatNotificationBridge(context: Context) {
        private val appContext = context.applicationContext

        @JavascriptInterface
        fun notifyMessage(rawTitle: String, rawBody: String) {
            val title = rawTitle.trim().take(120).ifEmpty { "Float" }
            val body = rawBody.trim().take(2_000)
            if (body.isEmpty()) return

            Handler(Looper.getMainLooper()).post {
                showMessageNotification(appContext, title, body)
            }
        }
    }

    private fun showMessageNotification(context: Context, title: String, body: String) {
        val openApp = PendingIntent.getActivity(
            context,
            0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val notification = NotificationCompat.Builder(context, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setWhen(System.currentTimeMillis())
            .setShowWhen(true)
            .setOnlyAlertOnce(false)
            .setAutoCancel(true)
            .setContentIntent(openApp)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()

        context.getSystemService(NotificationManager::class.java)
            .notify(NOTIF_MESSAGE_ID, notification)
    }
}
