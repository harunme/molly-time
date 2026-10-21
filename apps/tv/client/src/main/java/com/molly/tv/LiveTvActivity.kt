package com.molly.tv

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.view.WindowManager
import android.widget.FrameLayout
import android.widget.TextView
import android.graphics.Color
import android.view.Gravity
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Live streams have no episode progress or disk cache, and never carry API credentials. */
@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class LiveTvActivity : AppCompatActivity() {
    private val app get() = application as MollyTimeApplication
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var view: PlayerView
    private lateinit var status: TextView
    private var owner: ThreadedPlayer? = null
    private var player: Player? = null
    private var active = false
    private var generation = 0
    private var session = ""
    private var channel = ""
    private var clock: PlayingClock? = null
    private var sequence = 0
    private var retries = 0
    private var checking = false
    private var endsAt = 0L
    private val watchTick = object : Runnable {
        override fun run() {
            if (!active || isFinishing) return
            if (player != null && !runCatching { app.watchControl.tick(player?.isPlaying == true) }.getOrDefault(false)) { player?.pause(); finish(); return }
            if (player?.isPlaying == true) runCatching { app.watchControl.notice() }.getOrNull()?.let { android.widget.Toast.makeText(this@LiveTvActivity, it, android.widget.Toast.LENGTH_LONG).show() }
            handler.postDelayed(this, 100)
        }
    }
    private val stopAtDeadline = Runnable { finish() }
    private val poll = object : Runnable {
        override fun run() {
            if (!active || isFinishing) return
            sample(player?.isPlaying == true)
            val id = session
            if (id.isNotEmpty() && !checking) {
                checking = true
                val current = generation
                app.playbackIo.execute {
                    val result = runCatching { app.watchControl.sync(); app.api.json("GET", "/api/live-tv/sessions/$id") }
                    runOnUiThread {
                        checking = false
                        if (active && generation == current) result.onFailure { error ->
                            if (error is ApiFailure && error.status in listOf(401, 403, 404)) finish()
                            else { player?.pause(); status.text = "连接中断，按确定重试，返回退出" }
                        }
                    }
                }
            }
            handler.postDelayed(this, 5000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        channel = intent.getStringExtra("channelId") ?: ""
        if (!channel.matches(Regex("[a-f0-9]{32}"))) { finish(); return }
        endsAt = savedInstanceState?.getLong("endsAt") ?: 0
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        androidx.core.view.WindowCompat.getInsetsController(window, window.decorView)
            .hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
        view = PlayerView(this).apply { useController = false }
        status = TextView(this).apply { setTextColor(Color.WHITE); textSize = 18f; setPadding(24, 12, 24, 12); setBackgroundColor(0xCC1C222A.toInt()) }
        setContentView(FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            addView(view, FrameLayout.LayoutParams(-1, -1))
            addView(status, FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM))
        })
    }

    override fun onStart() {
        super.onStart()
        if (!::view.isInitialized || isFinishing) return
        active = true
        load()
        handler.post(poll)
        handler.post(watchTick)
    }

    private fun load() {
        val current = ++generation
        release()
        status.text = "正在连接频道… · 返回退出"
        app.playbackIo.execute {
            val result = runCatching { app.watchControl.sync(); app.watchControl.requireLive(); app.api.json("POST", "/api/live-tv/channels/$channel/sessions") }
            runOnUiThread {
                result.onSuccess { source ->
                    val id = source.getString("sessionId")
                    if (!active || current != generation || isFinishing) {
                        enqueue(id, JSONObject().put("seq", 0).put("startMs", 0).put("endMs", 0)
                            .put("playedMs", 0).put("positionMs", 0).put("stopped", true))
                        return@onSuccess
                    }
                    session = id; sequence = 0; clock = PlayingClock(SystemClock.elapsedRealtime())
                    if (endsAt == 0L) endsAt = SystemClock.elapsedRealtime() + source.getLong("limitMs")
                    handler.removeCallbacks(stopAtDeadline)
                    handler.postDelayed(stopAtDeadline, (endsAt - SystemClock.elapsedRealtime()).coerceAtLeast(0))
                    connect(source, current)
                }.onFailure { error ->
                    if (active && current == generation) status.text = (error.message ?: "频道加载失败") + " · 按确定重试，返回退出"
                }
            }
        }
    }

    private fun connect(source: JSONObject, current: Int) {
        val owner = ThreadedPlayer(applicationContext)
        this.owner = owner
        owner.connect({ looper ->
            // Separate unauthenticated client: redirects, manifests, keys and segments
            // must never receive MollyTime's Authorization or Cookie headers.
            val http = okhttp3.OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(15, TimeUnit.SECONDS).followRedirects(true).build()
            val factory = DefaultDataSource.Factory(applicationContext, OkHttpDataSource.Factory(http))
            ExoPlayer.Builder(applicationContext).setLooper(looper)
                .setMediaSourceFactory(DefaultMediaSourceFactory(factory)).build()
        }, { connected ->
            if (!active || generation != current || this.owner !== owner) { owner.release(); return@connect }
            player = connected; view.player = connected
            connected.addListener(object : Player.Listener {
                override fun onIsPlayingChanged(isPlaying: Boolean) {
                    if (!runCatching { app.watchControl.tick(isPlaying) }.getOrDefault(false)) { connected.pause(); finish(); return }
                    sample(isPlaying)
                    if (isPlaying) { retries = 0; status.text = source.getString("name") + " · 正在直播 · 返回换台 · 最长 30 分钟" }
                }
                override fun onPlayerError(error: PlaybackException) {
                    sample(false)
                    status.text = "频道暂时不可用 · 按确定重试，返回换台"
                    if (retries++ < 2) handler.postDelayed({
                        if (active && generation == current && player === connected) { connected.prepare(); connected.play() }
                    }, 2000)
                }
            })
            val url = source.getString("url")
            val item = MediaItem.Builder().setUri(url)
            if (!android.net.Uri.parse(url).path.orEmpty().endsWith(".mp4", true)) item.setMimeType(MimeTypes.APPLICATION_M3U8)
            connected.setMediaItem(item.build())
            connected.prepare(); connected.play()
        }, {
            if (active && generation == current) { status.text = "播放器初始化失败 · 按确定重试，返回退出"; release() }
        })
    }

    private fun enqueue(id: String, body: JSONObject) {
        app.io.execute { runCatching { app.watchQueue.enqueue(id, body) } }
    }

    private fun sample(playing: Boolean) {
        val current = clock ?: return
        current.sample(SystemClock.elapsedRealtime(), playing).forEach { segment ->
            enqueue(session, JSONObject().put("seq", sequence++).put("startMs", segment.start).put("endMs", segment.end)
                .put("playedMs", segment.played).put("positionMs", 0))
        }
    }

    private fun release() {
        runCatching { app.watchControl.tick(false) }
        sample(false)
        clock?.let {
            val end = it.offset(SystemClock.elapsedRealtime())
            enqueue(session, JSONObject().put("seq", sequence++).put("startMs", end).put("endMs", end)
                .put("playedMs", 0).put("positionMs", 0).put("stopped", true))
        }
        clock = null; session = ""
        view.player = null; player = null; owner?.release(); owner = null
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode in listOf(KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) { retries = 0; load() }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onSaveInstanceState(outState: Bundle) { outState.putLong("endsAt", endsAt); super.onSaveInstanceState(outState) }
    override fun onStop() {
        active = false; generation++
        handler.removeCallbacksAndMessages(null)
        if (::view.isInitialized) release()
        super.onStop()
    }
}
