package app.floatphone.shell

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

/**
 * Float 小手机安卓壳：原生 WebView 直接加载线上站点。
 * 网页每次部署即时生效，本壳只负责原生能力（推送长连接、文件上下行、外链）。
 */
class MainActivity : AppCompatActivity() {

    companion object {
        val SITE_URL: String = BuildConfig.SITE_URL
        const val VERSION = "1.0.0"
        /** 来电接听等场景的站内深链（必须以 SITE_URL 开头，否则忽略） */
        const val EXTRA_OPEN_URL = "open_url"
    }

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback ?: return@registerForActivityResult
        filePathCallback = null
        val data = result.data?.data
        callback.onReceiveValue(if (data != null) arrayOf(data) else emptyArray())
    }

    private val notifPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) PushService.start(this)
    }

    // 网页侧 getUserMedia（通话按住说话、语音条录音、视频通话摄像头）触发的
    // WebView 权限请求：先要系统运行时权限，拿到后再转授给页面。
    // 不实现 onPermissionRequest 时 WebView 会静默拒绝，页面永远拿不到麦克风。
    private var pendingWebPermissionRequest: android.webkit.PermissionRequest? = null

    private val webPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        val request = pendingWebPermissionRequest ?: return@registerForActivityResult
        pendingWebPermissionRequest = null
        val granted = request.resources.filter { resource ->
            webResourcePermissions(resource).all {
                ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
            }
        }
        if (granted.isEmpty()) request.deny() else request.grant(granted.toTypedArray())
    }

    private fun webResourcePermissions(resource: String): List<String> = when (resource) {
        android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE -> listOf(Manifest.permission.RECORD_AUDIO)
        android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE -> listOf(Manifest.permission.CAMERA)
        else -> emptyList()
    }

    /**
     * 普通 App 模式：Android 顶部状态栏和底部导航栏都常驻。
     * 不再使用沉浸式/全屏系统栏策略，避免第一次边缘手势只把系统栏拉出来。
     */
    @Suppress("DEPRECATION")
    private fun enterImmersiveMode() {
        window.statusBarColor = Color.BLACK
        window.navigationBarColor = Color.BLACK

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val attrs = window.attributes
            attrs.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT
            window.attributes = attrs
        }

        // WebView 完整布局在系统栏之间，上下系统栏始终可见。
        WindowCompat.setDecorFitsSystemWindows(window, true)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            show(WindowInsetsCompat.Type.systemBars())
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        // 清空旧版 FULLSCREEN / HIDE_NAVIGATION / IMMERSIVE 等 flags。
        window.decorView.systemUiVisibility = View.SYSTEM_UI_FLAG_VISIBLE
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enterImmersiveMode()
        // 音量键默认调媒体流：WebView 里的语音条/TTS 都走媒体流播放，
        // 不设的话短音频没在播时按键调的是铃声，用户感觉"音量键无效、声音巨大"
        volumeControlStream = AudioManager.STREAM_MUSIC

        webView = WebView(this)
        webView.setBackgroundColor(Color.BLACK)
        setContentView(webView)
        enterImmersiveMode()

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            userAgentString = "$userAgentString FloatShell/$VERSION"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)

        webView.addJavascriptInterface(ShellBridge(), "AndroidShell")

        webView.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                syncPushConfigFromWebView()
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                val scheme = url.scheme ?: return false
                // 站内导航留在壳里；http(s) 外链和自定义协议（shortcuts:// 等）交给系统
                if (scheme == "http" || scheme == "https") {
                    if (url.host == Uri.parse(SITE_URL).host) return false
                    return runCatching {
                        startActivity(Intent(Intent.ACTION_VIEW, url)); true
                    }.getOrDefault(true)
                }
                return runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW, url)); true
                }.getOrDefault(true)
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                val supported = request.resources.filter { webResourcePermissions(it).isNotEmpty() }
                if (supported.isEmpty()) { request.deny(); return }
                val missing = supported.flatMap { webResourcePermissions(it) }
                    .distinct()
                    .filter { ContextCompat.checkSelfPermission(this@MainActivity, it) != PackageManager.PERMISSION_GRANTED }
                if (missing.isEmpty()) { request.grant(supported.toTypedArray()); return }
                if (pendingWebPermissionRequest != null) { request.deny(); return }
                pendingWebPermissionRequest = request
                webPermissionLauncher.launch(missing.toTypedArray())
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                filePathCallback?.onReceiveValue(emptyArray())
                filePathCallback = callback
                return runCatching {
                    fileChooserLauncher.launch(params.createIntent()); true
                }.getOrElse {
                    filePathCallback = null; false
                }
            }
        }

        // 备份导出等下载：交给系统下载管理器，落到公共下载目录
        webView.setDownloadListener(DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            runCatching {
                if (url.startsWith("blob:") || url.startsWith("data:")) {
                    // blob/data 由页面内 JS 触发的 a[download] 处理；提示用户等待
                    Toast.makeText(this, "正在导出…", Toast.LENGTH_SHORT).show()
                    return@DownloadListener
                }
                val request = DownloadManager.Request(Uri.parse(url)).apply {
                    addRequestHeader("User-Agent", userAgent)
                    addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setDestinationInExternalPublicDir(
                        Environment.DIRECTORY_DOWNLOADS,
                        android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType),
                    )
                }
                (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                Toast.makeText(this, "已开始下载到「下载」目录", Toast.LENGTH_SHORT).show()
            }
        })

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // Float 内部页面多数是 React 状态切换，不一定产生 WebView URL 历史。
                // 只允许点击左上区域的返回控件；右上“+”/菜单即使误用了 page-back-btn 也不会命中。
                val script = """
                    (function () {
                      try {
                        var selectors = [
                          'button[aria-label="返回"]',
                          '[role="button"][aria-label="返回"]',
                          'a[aria-label="返回"]',
                          'button[title="返回"]',
                          '.page-back-btn'
                        ];
                        var nodes = Array.prototype.slice.call(document.querySelectorAll(selectors.join(',')));
                        var best = null;
                        var bestScore = Infinity;
                        var maxLeft = Math.min(190, window.innerWidth * 0.32);
                        var maxTop = Math.max(220, window.innerHeight * 0.22);

                        for (var i = 0; i < nodes.length; i++) {
                          var button = nodes[i];
                          var style = window.getComputedStyle(button);
                          var rect = button.getBoundingClientRect();
                          var visible =
                            style.display !== 'none' &&
                            style.visibility !== 'hidden' &&
                            Number(style.opacity || '1') > 0 &&
                            rect.width > 0 && rect.height > 0 &&
                            rect.bottom > 0 && rect.right > 0 &&
                            rect.top < window.innerHeight && rect.left < window.innerWidth;
                          if (!visible) continue;

                          // 真正的页面返回键应该位于屏幕左上区域。
                          // 这条规则明确排除聊天页右上角“+”和其弹出的右侧菜单。
                          if (rect.left < 0 || rect.left > maxLeft || rect.top < 0 || rect.top > maxTop) continue;

                          var score = rect.left * 3 + rect.top;
                          if (score < bestScore) {
                            bestScore = score;
                            best = button;
                          }
                        }

                        if (best) {
                          best.click();
                          return true;
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

        // 冷启动带深链（如来电接听）直接加载目标；否则加载首页
        webView.loadUrl(consumeOpenUrl(intent) ?: SITE_URL)
        ensurePushService()
    }

    override fun onResume() {
        super.onResume()
        enterImmersiveMode()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) enterImmersiveMode()
    }

    /** singleTask：App 已在运行时（如全屏来电页接听）通过 onNewIntent 送达深链 */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val target = consumeOpenUrl(intent) ?: return
        // SPA 已加载：loadUrl 到同页 hash 只触发 hashchange，不会整页重载
        webView.loadUrl(target)
    }

    private fun consumeOpenUrl(intent: Intent?): String? {
        val target = intent?.getStringExtra(EXTRA_OPEN_URL) ?: return null
        intent.removeExtra(EXTRA_OPEN_URL)
        return target.takeIf { it.startsWith(SITE_URL) }
    }

    /**
     * 把网页 IndexedDB 中已经绑定的个人 Supabase 配置同步给原生后台推送。
     * 页面侧配置可能在首次恢复/重新绑定后才出现，所以注入一个轻量定时同步；
     * 原生端会比较配置，完全相同时不会反复重连。
     */
    private fun syncPushConfigFromWebView() {
        val script = """
            (function () {
              if (window.__floatShellPushSyncInstalled) return;
              window.__floatShellPushSyncInstalled = true;
              function syncFloatPush() {
                try {
                  var req = indexedDB.open('AiPhoneKvDB');
                  req.onsuccess = function () {
                    try {
                      var db = req.result;
                      var tx = db.transaction('entries', 'readonly');
                      var getReq = tx.objectStore('entries').get('ai_phone_cloud_backup_config_v1');
                      getReq.onsuccess = function () {
                        try {
                          var row = getReq.result;
                          var raw = row && row.value;
                          if (!raw) return;
                          var cfg = JSON.parse(raw);
                          if (cfg && cfg.url && cfg.key && window.AndroidShell && window.AndroidShell.configurePush) {
                            window.AndroidShell.configurePush(String(cfg.url), String(cfg.key), 'owner');
                          }
                        } catch (_) {}
                      };
                    } catch (_) {}
                  };
                } catch (_) {}
              }
              syncFloatPush();
              window.setInterval(syncFloatPush, 5000);
            })();
        """.trimIndent()
        webView.evaluateJavascript(script, null)
    }

    private fun ensurePushService() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            PushService.start(this)
        }
    }

    override fun onDestroy() {
        CookieManager.getInstance().flush()
        webView.destroy()
        super.onDestroy()
    }

    /** 暴露给网页的原生桥（网页侧可用 window.AndroidShell 特性检测壳环境）。 */
    inner class ShellBridge {
        @JavascriptInterface
        fun getVersion(): String = VERSION

        /** 打开本应用的系统设置页（引导用户关电池限制、开自启动）。 */
        @JavascriptInterface
        fun openAppSettings() {
            runCatching {
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }

        /** 网页把个人云配置交给原生长连接；配置仅保存在本 App 私有目录。 */
        @JavascriptInterface
        fun configurePush(supabaseUrl: String, apiKey: String, userId: String) {
            PushService.configure(this@MainActivity, supabaseUrl, apiKey, userId)
        }

        /** 请求忽略电池优化（保活关键一步）。 */
        @SuppressLint("BatteryLife")
        @JavascriptInterface
        fun requestIgnoreBatteryOptimization() {
            runCatching {
                startActivity(
                    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }
    }
}
