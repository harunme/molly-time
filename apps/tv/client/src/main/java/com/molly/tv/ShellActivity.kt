package com.molly.tv

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
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
import org.json.JSONObject
import java.io.ByteArrayInputStream

class ShellActivity : AppCompatActivity() {
    private val app get() = application as MollyTimeApplication
    private var web: WebView? = null
    private var loading: ProgressBar? = null
    private var pageReady = false
    private var playing = false
    private var resumed = false
    private var updateOpening = false
    private var updateCheckedServer = ""
    private var pendingUpdate: ClientUpdates.Release? = null
    @Volatile private var generation = 0
    private var inFlight = 0
    private val player = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        playing = false
        val data = JSONObject().put("episodeId", result.data?.getStringExtra("episodeId") ?: "")
            .put("positionMs", result.data?.getLongExtra("positionMs", 0) ?: 0)
        web?.evaluateJavascript("window.dispatchEvent(new CustomEvent('molly:playbackClosed',{detail:$data}))", null)
        offerPendingUpdate()
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
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
        if (app.session.server.isEmpty()) connection() else loadPage()
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

    private fun connection(message: String = "连接家庭媒体库") {
        destroyWeb()
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(72, 56, 72, 40)
            setBackgroundColor(Color.rgb(15, 27, 46))
        }
        layout.addView(TextView(this).apply { text = "MollyTime"; textSize = 38f; setTextColor(Color.WHITE) })
        layout.addView(TextView(this).apply { text = message; textSize = 22f; setTextColor(Color.WHITE) })
        val input = EditText(this).apply {
            setSingleLine(true)
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            hint = "https://你的媒体库地址"
            setText(app.session.server.ifEmpty { if (BuildConfig.DEBUG) "http://10.0.2.2:8096" else "" })
        }
        layout.addView(input)
        layout.addView(Button(this).apply {
            text = "连接"
            setOnClickListener {
                runCatching { app.session.connect(input.text.toString()) }
                    .onSuccess { loadPage() }
                    .onFailure { input.error = it.message ?: "请检查媒体库地址" }
            }
        })
        setContentView(layout)
        input.requestFocus()
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
        layout.addView(Button(this).apply { text = "连接设置"; setOnClickListener { connection() } })
        setContentView(layout)
        retry.requestFocus()
    }

    private fun sameOrigin(uri: Uri): Boolean {
        val base = Uri.parse(app.session.server)
        fun port(u: Uri) = if (u.port >= 0) u.port else if (u.scheme == "https") 443 else 80
        return uri.scheme == base.scheme && uri.host == base.host && port(uri) == port(base)
    }

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
        val view = WebView(this)
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
        WebViewCompat.addWebMessageListener(view, "MollyBridge", setOf(app.session.server),
            WebViewCompat.WebMessageListener { _, message, origin, isMainFrame, reply ->
                if (!isMainFrame || !sameOrigin(origin) || generation != current) return@WebMessageListener
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
                    checkStartupUpdate()
                }
                inFlight++
                app.io.execute {
                    val response = JSONObject().put("id", id)
                    try {
                        if (generation == current) response.put("result", handle(method, args, current))
                    } catch (error: Exception) {
                        response.put("error", JSONObject().put("message",
                            if (error is ApiFailure || error is IllegalArgumentException) error.message else "连接失败，请检查媒体库与网络")
                            .put("status", if (error is ApiFailure) error.status else 0))
                    }
                    runOnUiThread {
                        inFlight--
                        if (generation == current && !isDestroyed) {
                            reply.postMessage(response.toString())
                            if (method == "connection") connection()
                        }
                    }
                }
            })
        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean =
                !sameOrigin(req.url) || !req.url.path.orEmpty().startsWith("/tv/")

            override fun shouldInterceptRequest(v: WebView, req: WebResourceRequest): WebResourceResponse? {
                if (!sameOrigin(req.url)) return blocked()
                if (!BridgePolicy.image.matches(req.url.path.orEmpty())) return null
                if (req.method != "GET") return blocked()
                return try {
                    // Width is the only supported image parameter; never forward credentials from the page.
                    val width = req.url.getQueryParameter("w")?.toIntOrNull()?.coerceIn(64, 1280) ?: 480
                    val res = app.api.response("GET", req.url.path + "?w=$width")
                    val body = res.body!!
                    WebResourceResponse(body.contentType()?.toString()?.substringBefore(';') ?: "image/jpeg",
                        null, res.code, "OK", mapOf("Cache-Control" to "no-store"), body.byteStream())
                } catch (_: Exception) { blocked() }
            }
            override fun onReceivedError(v: WebView, req: WebResourceRequest, error: WebResourceError) {
                if (req.isForMainFrame && generation == current) fault("网页未能加载，请检查网络或媒体库地址")
            }
            override fun onReceivedHttpError(v: WebView, req: WebResourceRequest, response: WebResourceResponse) {
                if (req.isForMainFrame && generation == current) fault("媒体库网页不可用（${response.statusCode}）")
            }
        }
        view.loadUrl(app.session.server + "/tv/")
        view.requestFocus()
        view.postDelayed({
            if (generation == current && !pageReady) fault("网页启动超时，请重新连接")
        }, 30000)
    }

    private fun blocked() = WebResourceResponse("text/plain", "utf-8", 403, "Forbidden",
        emptyMap(), ByteArrayInputStream(ByteArray(0)))

    private fun handle(method: String, args: JSONObject, current: Int): Any = when (method) {
        "ready" -> JSONObject().put("ok", true)
        "getCapabilities" -> JSONObject().put("bridgeVersion", 1).put("shellVersion", BuildConfig.VERSION_NAME)
            .put("serverUrl", app.session.server).put("authenticated", app.session.refresh.isNotEmpty())
            .put("childId", app.session.childId).put("nativePlayback", true).put("devicePairing", true).put("devicePairingReset", true)
            .put("clientUpdates", true)
        "checkUpdate" -> {
            runOnUiThread {
                if (!playing && resumed && !updateOpening && !isDestroyed && generation == current) {
                    updateOpening = true
                    startActivity(Intent(this, UpdateActivity::class.java))
                }
            }
            JSONObject().put("ok", true)
        }
        "pairingStart" -> app.api.pairingStart()
        "pairingPoll" -> app.api.pairingPoll()
        "pairingCancel" -> app.api.pairingCancel()
        "pairingReset" -> app.api.pairingReset()
        "connection" -> JSONObject().put("ok", true)
        "request" -> {
            val verb = args.getString("method")
            val path = args.getString("path")
            require(BridgePolicy.allows(verb, path)) { "接口不允许访问" }
            if (path == "/api/home") app.api.homeSchemaVersion = args.optInt("homeSchemaVersion", 1).coerceIn(1, 2)
            val result = org.json.JSONTokener(app.api.text(verb, path, args.optJSONObject("body"))).nextValue()
            BridgePolicy.selectedChild(path)?.let { app.session.childId = it }
            result
        }
        "playEpisode" -> {
            val id = args.getString("episodeId")
            require(BridgePolicy.id.matches(id)) { "无效的剧集 ID" }
            app.api.json("GET", "/api/episodes/$id") // Authorize before launching native UI.
            runOnUiThread {
                if (!playing && !isDestroyed && generation == current) {
                    playing = true
                    player.launch(Intent(this, PlaybackActivity::class.java).putExtra("episodeId", id)
                        .putExtra("childId", app.session.childId))
                }
            }
            JSONObject().put("ok", true)
        }
        else -> throw IllegalArgumentException("不支持的网页接口")
    }

    private fun checkStartupUpdate() {
        val server = app.session.server
        if (updateCheckedServer == server) return
        updateCheckedServer = server
        pendingUpdate = null
        app.updates.executor.execute {
            val release = runCatching { app.updates.check(server) }.getOrNull()
            runOnUiThread {
                if (!isDestroyed && app.session.server == server) {
                    pendingUpdate = release
                    offerPendingUpdate()
                }
            }
        }
    }
    private fun offerPendingUpdate() {
        val release = pendingUpdate ?: return
        if (!resumed || playing || updateOpening || !pageReady || isDestroyed) return
        pendingUpdate = null
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("发现新版本 ${release.versionName}")
            .setMessage(release.notes.ifEmpty { "可以更新电视客户端，获取最新功能。" })
            .setNegativeButton("稍后", null)
            .setPositiveButton("查看更新") { _, _ ->
                updateOpening = true
                startActivity(Intent(this, UpdateActivity::class.java).putExtra("release", release.json().toString()))
            }.show()
    }
    override fun onPause() { resumed = false; web?.onPause(); super.onPause() }
    override fun onResume() { super.onResume(); resumed = true; updateOpening = false; web?.onResume(); offerPendingUpdate() }
    override fun onDestroy() { destroyWeb(); super.onDestroy() }
}
