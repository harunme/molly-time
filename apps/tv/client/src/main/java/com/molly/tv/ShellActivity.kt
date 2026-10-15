package com.molly.tv

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Build
import android.provider.Settings
import android.view.KeyEvent
import android.view.View
import android.webkit.*
import android.widget.*
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.io.ByteArrayInputStream

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class ShellActivity : AppCompatActivity() {
    private val app get() = application as MollyTimeApplication
    private var web: WebView? = null
    private var loading: ProgressBar? = null
    private var pageReady = false
    private var playing = false
    private var resumed = false
    private var webUpdateCheckedServer = ""
    private var webUpdateRunning = false
    private var clientUpdateCheckedServer = ""
    private var pendingClientRelease: ClientUpdates.Release? = null
    private var fallbackAttempted = false
    private var clientRelease: ClientUpdates.Release? = null
    private var downloadedClient: java.io.File? = null
    @Volatile private var clientUpdateProgress: JSONObject? = null
    @Volatile private var clientDownloadRunning = false
    private val clientUpdateOperation = ClientUpdates.Operation()
    private var installAfterPermission = false
    private var installReady = false
    private var pendingInstallResult: Intent? = null
    private val installPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (installAfterPermission) {
            installAfterPermission = false
            if (Build.VERSION.SDK_INT < 26 || packageManager.canRequestPackageInstalls()) startClientInstall()
            else dispatch("molly:clientUpdateProgress", JSONObject().put("state", "请在系统设置中允许安装应用"))
        }
    }
    @Volatile private var generation = 0
    private var inFlight = 0
    private val player = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        playing = false
        app.catalog.resume()
        val data = JSONObject().put("episodeId", result.data?.getStringExtra("episodeId") ?: "")
            .put("positionMs", result.data?.getLongExtra("positionMs", 0) ?: 0)
            .put("completed", result.data?.getBooleanExtra("completed", false) ?: false)
            .put("runtimeMs", result.data?.getLongExtra("runtimeMs", 0) ?: 0)
            .put("progressKnown", result.data?.getBooleanExtra("progressKnown", false) ?: false)
        web?.evaluateJavascript("window.dispatchEvent(new CustomEvent('molly:playbackClosed',{detail:$data}))", null)
        pendingClientRelease?.let { pendingClientRelease = null; dispatch("molly:clientUpdateAvailable", it.json()) }
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        app.catalogListener = { name, detail -> dispatch(name, detail) }
        WindowCompat.getInsetsController(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (!pageReady) { finish(); return }
                web?.evaluateJavascript("Boolean(window.mollyBack && window.mollyBack())") { handled ->
                    if (handled != "true") finish()
                }
            }
        })
        if (intent.action == ClientUpdateInstaller.INSTALL_RESULT) pendingInstallResult = intent
        app.webBundles.selectForLaunch(app.session.server)
        loadPage()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_MENU && pageReady && !playing) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                web?.evaluateJavascript("window.dispatchEvent(new CustomEvent('molly:menu'))", null)
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun destroyWeb() {
        generation++
        pageReady = false
        web?.stopLoading()
        web?.destroy()
        web = null
    }

    private fun fault(message: String) {
        destroyWeb()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(72, 64, 72, 40)
            setBackgroundColor(Color.rgb(15, 27, 46))
        }
        layout.addView(TextView(this).apply { text = message; textSize = 25f; setTextColor(Color.WHITE) })
        val retry = Button(this).apply { text = "重新连接"; setOnClickListener { loadPage() } }
        layout.addView(retry)
        setContentView(layout)
        retry.requestFocus()
    }

    private fun trustedWebOrigin(uri: Uri) = uri.scheme == "https" &&
        uri.host == "appassets.androidplatform.net" && (uri.port == -1 || uri.port == 443)

    private fun loadPage() {
        (getSystemService(INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager)
            .hideSoftInputFromWindow(currentFocus?.windowToken, 0)
        destroyWeb()
        app.api.homeSchemaVersion = 1
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            fault("电视的网页组件版本过旧，请更新系统或 Android System WebView")
            return
        }
        val current = generation
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/tv/", app.webBundles.pathHandler()).build()
        val view = WebView(this)
        // The web UI draws card focus. Avoid an additional native frame around
        // the entire WebView when a remote switches out of touch mode.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) view.defaultFocusHighlightEnabled = false
        web = view
        val frame = FrameLayout(this)
        frame.addView(view, FrameLayout.LayoutParams(-1, -1))
        loading = ProgressBar(this).also { frame.addView(it, FrameLayout.LayoutParams(64, 64, android.view.Gravity.CENTER)) }
        setContentView(frame)
        view.setBackgroundColor(Color.rgb(15, 27, 46))
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            cacheMode = WebSettings.LOAD_DEFAULT
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        WebViewCompat.addWebMessageListener(view, "MollyBridge", setOf(WebBundleStore.LOCAL_ORIGIN),
            WebViewCompat.WebMessageListener { _, message, origin, isMainFrame, reply ->
                if (!isMainFrame || !trustedWebOrigin(origin) || generation != current) return@WebMessageListener
                val raw = message.data ?: return@WebMessageListener
                if (raw.length > 65536) return@WebMessageListener
                val request = runCatching { JSONObject(raw) }.getOrNull() ?: return@WebMessageListener
                val id = request.optString("id")
                if (!Regex("[A-Za-z0-9-]{1,64}").matches(id)) return@WebMessageListener
                val method = request.optString("method")
                val args = request.optJSONObject("args") ?: JSONObject()
                if (inFlight >= 24) {
                    reply.postMessage(JSONObject().put("id", id).put("error",
                        JSONObject().put("message", "请求过多，请稍后重试").put("status", 429)).toString())
                    return@WebMessageListener
                }
                if (method == "ready") {
                    pageReady = true
                    loading?.visibility = View.GONE
                    app.webBundles.confirmLoaded(app.session.server, args.optString("webVersion").takeIf { it.isNotEmpty() })
                    checkWebUpdateAsync()
                    checkStartupClientUpdate()
                    pendingInstallResult?.let { result -> pendingInstallResult = null; runOnUiThread { handleInstallResult(result) } }
                }
                inFlight++
                val local = method in setOf("catalogRead", "catalogStatus", "catalogSync", "getCapabilities", "ready")
                (if (local) app.catalog.reads else if (method == "playEpisode") app.playbackIo else app.io).execute {
                    val response = JSONObject().put("id", id)
                    try {
                        if (generation == current) response.put("result", handle(method, args, current))
                    } catch (error: Exception) {
                        response.put("error", JSONObject().put("message",
                            if (error is ApiFailure || error is IllegalArgumentException || error is IllegalStateException) error.message else "连接失败，请检查媒体库与网络")
                            .put("status", if (error is ApiFailure) error.status else 0))
                    }
                    runOnUiThread {
                        inFlight--
                        if (generation == current && !isDestroyed) {
                            reply.postMessage(response.toString())
                        }
                    }
                }
            })
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean =
                !trustedWebOrigin(req.url) || !req.url.path.orEmpty().startsWith("/tv/")

            override fun shouldInterceptRequest(v: WebView, req: WebResourceRequest): WebResourceResponse? {
                assetLoader.shouldInterceptRequest(req.url)?.let { return it }
                if (req.method == "GET" && BridgePolicy.allowsOssImage(req.url.toString())) return null
                if (!trustedWebOrigin(req.url)) return blocked()
                if (!BridgePolicy.image.matches(req.url.path.orEmpty())) return blocked()
                if (req.method != "GET") return blocked()
                return try {
                    // Width is the only supported image parameter; never forward credentials from the page.
                    val width = req.url.getQueryParameter("w")?.toIntOrNull()?.coerceIn(64, 1280) ?: 480
                    val version = req.url.getQueryParameter("v").orEmpty()
                    app.catalog.covers.cached(req.url.path.orEmpty(), version)?.let { cached ->
                        return WebResourceResponse("image/jpeg", null, cached.inputStream())
                    }
                    val res = app.api.imageResponse(req.url.path + "?w=$width")
                    val body = res.body!!
                    WebResourceResponse(body.contentType()?.toString()?.substringBefore(';') ?: "image/jpeg",
                        null, res.code, "OK", mapOf("Cache-Control" to "no-store"), body.byteStream())
                } catch (_: Exception) { blocked() }
            }
            override fun onReceivedError(v: WebView, req: WebResourceRequest, error: WebResourceError) {
                if (req.isForMainFrame && generation == current) recoverWebPage("网页无法启动，请更新电视客户端")
            }
            override fun onReceivedHttpError(v: WebView, req: WebResourceRequest, response: WebResourceResponse) {
                if (req.isForMainFrame && generation == current) recoverWebPage("网页无法启动，请更新电视客户端")
            }
        }
        view.loadUrl("${WebBundleStore.LOCAL_ORIGIN}/tv/index.html")
        view.requestFocus()
        view.postDelayed({
            if (generation == current && !pageReady) recoverWebPage("网页启动超时，请更新电视客户端")
        }, 30000)
    }

    private fun blocked() = WebResourceResponse("text/plain", "utf-8", 403, "Forbidden",
        emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private fun recoverWebPage(message: String) {
        if (!fallbackAttempted && app.session.server.isNotEmpty()) {
            fallbackAttempted = true
            app.webBundles.rollback(app.session.server)
            loadPage()
        } else fault(message)
    }

    private fun handle(method: String, args: JSONObject, current: Int): Any = when (method) {
        "ready" -> JSONObject().put("ok", true)
        "getCapabilities" -> JSONObject().put("bridgeVersion", 1).put("shellVersion", BuildConfig.VERSION_NAME)
            .put("catalogSync", true).put("offlinePlayback", true)
            .put("serverUrl", app.session.server).put("webVersion", app.webBundles.selectedVersion()).put("authenticated", app.session.refresh.isNotEmpty())
            .put("childId", app.session.childId).put("nativePlayback", true).put("devicePairing", true).put("devicePairingReset", true)
            .put("clientUpdates", true)
        "catalogRead" -> app.catalog.read(args).also { result ->
            result.optJSONObject("data")?.let { data ->
                val store = app.catalog.store()
                data.optJSONArray("episodes")?.let { app.media.decorateOffline(it, store) }
                data.optJSONArray("rows")?.let { rows -> for (i in 0 until rows.length()) rows.getJSONObject(i).optJSONArray("items")?.let { app.media.decorateOffline(it, store) } }
            }
        }
        "catalogStatus" -> app.catalog.status()
        "catalogSync" -> { app.catalog.checkSoon(); JSONObject().put("ok", true) }
        "connect" -> {
            app.session.connect(args.getString("serverUrl"))
            app.catalog.checkSoon()
            webUpdateCheckedServer = ""
            clientUpdateCheckedServer = ""
            checkStartupClientUpdate()
            JSONObject().put("serverUrl", app.session.server).put("authenticated", app.session.refresh.isNotEmpty())
                .put("childId", app.session.childId)
        }
        "checkWebUpdate" -> { checkWebUpdateAsync(force = true); JSONObject().put("ok", true) }
        "checkUpdate" -> {
            // A new check must not replace the release belonging to an active
            // download or to the verified package waiting for installation.
            val release = if (clientDownloadRunning || downloadedClient?.isFile == true) clientRelease
                else app.updates.check(app.session.server)
            if (release?.sha256 != clientRelease?.sha256) {
                downloadedClient = null
                clientUpdateProgress = null
            }
            clientRelease = release
            JSONObject().put("release", release?.json()).put("progress", clientUpdateProgress)
        }
        "downloadUpdate" -> {
            val release = clientRelease ?: throw IllegalStateException("请先检查客户端更新")
            if (!clientDownloadRunning) {
                clientDownloadRunning = true
                app.updates.executor.execute {
                    val result = runCatching { app.updates.download(release, clientUpdateOperation) { received ->
                        dispatch("molly:clientUpdateProgress", JSONObject().put("state", "downloading")
                            .put("received", received).put("total", release.size))
                    } }
                    clientDownloadRunning = false
                    result.onSuccess { downloadedClient = it; dispatch("molly:clientUpdateProgress", JSONObject().put("state", "downloaded")) }
                        .onFailure { dispatch("molly:clientUpdateProgress", JSONObject().put("state", "error").put("message", it.message ?: "下载失败")) }
                }
            }
            JSONObject().put("ok", true)
        }
        "installUpdate" -> {
            require(clientRelease != null && downloadedClient != null) { "请先下载并校验更新包" }
            runOnUiThread { startClientInstall() }
            JSONObject().put("ok", true)
        }
        "pairingStart" -> app.api.pairingStart()
        "pairingPoll" -> app.api.pairingPoll()
        "pairingCancel" -> app.api.pairingCancel()
        "pairingReset" -> app.api.pairingReset()
        "request" -> {
            val verb = args.getString("method")
            val path = args.getString("path")
            require(BridgePolicy.allows(verb, path)) { "接口不允许访问" }
            if (path.substringBefore('?') == "/api/home") app.api.homeSchemaVersion = args.optInt("homeSchemaVersion", 1).coerceIn(1, 2)
            val result = org.json.JSONTokener(app.api.text(verb, path, args.optJSONObject("body"))).nextValue()
            result
        }
        "playEpisode" -> {
            val id = args.getString("episodeId")
            require(BridgePolicy.id.matches(id)) { "无效的剧集 ID" }
            if (app.catalog.status().optBoolean("supported") && !app.catalog.status().optBoolean("online")) app.media.offline(id, app.catalog.store())
            else try { app.api.json("GET", "/api/episodes/$id") }
            catch (failure: java.io.IOException) { app.media.offline(id, app.catalog.store()) }
            runOnUiThread {
                if (!playing && !isDestroyed && generation == current) {
                    playing = true
                    app.catalog.pause()
                    player.launch(Intent(this, PlaybackActivity::class.java).putExtra("episodeId", id)
                        .putExtra("childId", app.session.childId))
                }
            }
            JSONObject().put("ok", true)
        }
        else -> throw IllegalArgumentException("不支持的网页接口")
    }

    private fun dispatch(name: String, detail: JSONObject) {
        if (name == "molly:clientUpdateProgress") clientUpdateProgress = detail
        runOnUiThread { web?.evaluateJavascript("window.dispatchEvent(new CustomEvent('$name',{detail:${detail}}))", null) }
    }

    private fun startClientInstall() {
        val release = clientRelease ?: return
        val file = downloadedClient ?: return
        if (installReady || installAfterPermission) return
        if (Build.VERSION.SDK_INT >= 26 && !packageManager.canRequestPackageInstalls()) {
            installAfterPermission = true
            dispatch("molly:clientUpdateProgress", JSONObject().put("state", "请允许 MollyTime 安装应用，然后返回继续").put("phase", "installing"))
            runCatching { installPermission.launch(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))) }
                .onFailure { installAfterPermission = false; dispatch("molly:clientUpdateProgress", JSONObject().put("state", "电视未提供安装授权入口，请在系统设置中允许安装应用").put("phase", "ready")) }
            return
        }
        installReady = true
        ClientUpdateInstaller(this).install(file, release, clientUpdateOperation) { state, waiting ->
            if (!waiting) installReady = false
            dispatch("molly:clientUpdateProgress", JSONObject().put("state", state)
                .put("phase", if (waiting) "installing" else "error"))
        }
    }

    @Suppress("DEPRECATION")
    private fun handleInstallResult(result: Intent) {
        val id = result.getIntExtra(android.content.pm.PackageInstaller.EXTRA_SESSION_ID, -1)
        val prefs = getSharedPreferences("molly.updates", MODE_PRIVATE)
        if (id < 0 || id != prefs.getInt("session", -1) || result.getStringExtra("nonce") != prefs.getString("nonce", null)) {
            dispatch("molly:clientUpdateProgress", JSONObject().put("state", "安装结果已失效，请重新检查更新")); return
        }
        val status = result.getIntExtra(android.content.pm.PackageInstaller.EXTRA_STATUS, android.content.pm.PackageInstaller.STATUS_FAILURE)
        when (status) {
            android.content.pm.PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirmation = result.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                if (confirmation != null) startActivity(confirmation)
                dispatch("molly:clientUpdateProgress", JSONObject().put("state", "请在系统安装界面确认更新"))
            }
            android.content.pm.PackageInstaller.STATUS_SUCCESS -> {
                prefs.edit().clear().commit()
                dispatch("molly:clientUpdateProgress", JSONObject().put("state", "更新已安装，请重新打开 MollyTime"))
            }
            android.content.pm.PackageInstaller.STATUS_FAILURE_ABORTED -> {
                prefs.edit().clear().commit(); installReady = false
                dispatch("molly:clientUpdateProgress", JSONObject().put("state", "尚未安装，更新包已保留").put("phase", "ready"))
            }
            else -> {
                prefs.edit().clear().commit(); installReady = false
                val detail = result.getStringExtra(android.content.pm.PackageInstaller.EXTRA_STATUS_MESSAGE)
                    ?.replace(Regex("\\s+"), " ")?.take(300)?.takeIf { it.isNotBlank() }
                val message = "安装失败（系统状态 $status）" + (detail?.let { "：$it" } ?: "，请重试")
                dispatch("molly:clientUpdateProgress", JSONObject().put("state", message).put("phase", "error"))
            }
        }
    }

    private fun checkStartupClientUpdate() {
        val server = app.session.server
        if (server.isBlank() || clientUpdateCheckedServer == server) return
        clientUpdateCheckedServer = server
        app.updates.executor.execute {
            val release = runCatching { app.updates.check(server) }.getOrNull()
            runOnUiThread {
                if (!isDestroyed && app.session.server == server && release != null) {
                    if (!clientDownloadRunning && downloadedClient == null) clientRelease = release
                    if (playing) pendingClientRelease = release
                    else dispatch("molly:clientUpdateAvailable", release.json())
                }
            }
        }
    }

    private fun checkWebUpdateAsync(force: Boolean = false) {
        val server = app.session.server
        if (server.isBlank() || (!force && webUpdateCheckedServer == server) || webUpdateRunning) return
        webUpdateCheckedServer = server
        webUpdateRunning = true
        app.webUpdateExecutor.execute {
            val result = runCatching { app.webBundles.checkAndStage(server, WebBundleStore.BRIDGE_VERSION) { received, total ->
                dispatch("molly:webUpdateProgress", JSONObject().put("state", "downloading").put("received", received).put("total", total))
            } }
            runOnUiThread {
                webUpdateRunning = false
                if (!isDestroyed && app.session.server == server) {
                    result.onSuccess { version ->
                        dispatch("molly:webUpdateProgress", JSONObject().put("state", if (version == null) "当前已是最新网页" else "staged").put("version", version ?: ""))
                    }.onFailure {
                        val message = it.message ?: "网页更新检查失败"
                        dispatch("molly:webUpdateProgress", JSONObject().put("state", "error").put("message", message))
                        if (message.contains("网页版本需要更新电视客户端"))
                            dispatch("molly:webUpdateIncompatible", JSONObject().put("message", message))
                    }
                }
            }
        }
    }

    override fun onPause() { if (!playing) app.catalog.pause(); resumed = false; web?.onPause(); super.onPause() }
    override fun onResume() { super.onResume(); resumed = true; web?.onResume(); if (!playing) app.catalog.resume() }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent); setIntent(intent)
        if (intent.action == ClientUpdateInstaller.INSTALL_RESULT) handleInstallResult(intent)
    }
    override fun onDestroy() { app.catalogListener = null; destroyWeb(); super.onDestroy() }
}
