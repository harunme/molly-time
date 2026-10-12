package com.molly.tv

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.KeyEvent
import android.view.WindowManager
import android.widget.*
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.*
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import org.json.JSONObject

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class PlaybackActivity : AppCompatActivity() {
    private val app get() = application as MollyApplication
    private lateinit var playerView: PlayerView
    private lateinit var status: TextView
    private var player: ExoPlayer? = null
    private lateinit var episodeId: String
    private var child = ""
    private var position = 0L
    private var completed = false
    private var playOnResume = true
    private var active = false
    private var loadGeneration = 0
    private var watchId = ""
    private var clock: PlayingClock? = null
    private var sequence = 0
    private val handler = Handler(Looper.getMainLooper())
    private val heartbeat = object : Runnable {
        override fun run() {
            report("progress")
            handler.postDelayed(this, 15000)
        }
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        episodeId = intent.getStringExtra("episodeId") ?: run { finish(); return }
        child = intent.getStringExtra("childId") ?: ""
        position = state?.getLong("position") ?: 0
        playOnResume = state?.getBoolean("play", true) ?: true
        playerView = PlayerView(this).apply { setShowSubtitleButton(true); setShowNextButton(false); setShowPreviousButton(false) }
        status = TextView(this).apply { textSize = 22f; setTextColor(android.graphics.Color.WHITE); setPadding(24, 24, 24, 24) }
        val frame = FrameLayout(this)
        frame.addView(playerView, FrameLayout.LayoutParams(-1, -1))
        frame.addView(status)
        setContentView(frame)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { finish() }
        })
    }

    override fun onStart() {
        super.onStart()
        active = true
        load()
    }

    private fun load() {
        val current = ++loadGeneration
        status.text = "正在加载视频…"
        app.io.execute {
            runCatching {
                val detail = app.api.json("GET", "/api/episodes/$episodeId")
                val resume = app.api.json("GET", app.api.progressPath(episodeId, child))
                val body = JSONObject().put("episodeId", episodeId)
                if (child.isNotEmpty()) body.put("childId", child)
                val watch = app.api.json("POST", "/api/playback/sessions", body)
                Triple(detail, resume, watch.getString("sessionId"))
            }.onSuccess { (detail, resume, sessionId) -> runOnUiThread {
                if (active && current == loadGeneration && !isDestroyed) {
                    watchId = sessionId
                    clock = PlayingClock(SystemClock.elapsedRealtime())
                    sequence = 0
                    if (position == 0L && !resume.optBoolean("completed")) position = resume.optLong("positionMs")
                    prepare(detail)
                }
            } }.onFailure { error -> runOnUiThread {
                if (active && current == loadGeneration) status.text = (error.message ?: "视频加载失败") + "。按确定重试，返回退出"
            } }
        }
    }

    private fun prepare(detail: JSONObject) {
        val runtime = detail.optLong("runtimeMs", 0)
        if (runtime > 0 && position >= runtime) position = 0
        val source = detail.getJSONArray("sources").optJSONObject(0)
        if (source == null) { status.text = "这集暂无可播放的视频，按返回选择其他内容"; return }
        val dataSource = DefaultDataSource.Factory(this, OkHttpDataSource.Factory(app.api.http)
            .setDefaultRequestProperties(mapOf("Authorization" to "Bearer ${app.session.access}")))
        val exo = ExoPlayer.Builder(this).setMediaSourceFactory(DefaultMediaSourceFactory(dataSource)).build()
        player = exo
        playerView.player = exo
        val subtitles = source.optJSONArray("subtitles")
        val configs = (0 until (subtitles?.length() ?: 0)).map { index ->
            val sub = subtitles!!.getJSONObject(index)
            MediaItem.SubtitleConfiguration.Builder(Uri.parse(app.session.server +
                "/api/episodes/$episodeId/subtitles/${sub.getInt("index")}"))
                .setMimeType(if (sub.optString("codec") == "vtt") MimeTypes.TEXT_VTT else MimeTypes.APPLICATION_SUBRIP)
                .setLanguage(sub.optString("language", "und")).setLabel(sub.optString("label"))
                .setSelectionFlags(if (sub.optBoolean("isDefault")) C.SELECTION_FLAG_DEFAULT else 0).build()
        }
        exo.addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                status.text = "播放失败（${error.errorCodeName}）。按确定重试，返回退出"
            }
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY) status.text = ""
                if (state == Player.STATE_ENDED) { completed = true; finish() }
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (BuildConfig.DEBUG) android.util.Log.d("MollyPlayback", "isPlaying=$isPlaying")
                sample(isPlaying)
                if (isPlaying) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        })
        val mediaPath = source.getString("url")
        val mediaUri = Uri.parse(app.session.server + mediaPath).buildUpon().appendQueryParameter("sessionId", watchId).build()
        exo.setMediaItem(MediaItem.Builder().setUri(mediaUri)
            .setMediaId(episodeId).setSubtitleConfigurations(configs).build(), position)
        exo.prepare()
        exo.playWhenReady = playOnResume
        handler.postDelayed(heartbeat, 15000)
        playerView.requestFocus()
    }

    private fun report(event: String) {
        val exo = player ?: return
        position = exo.currentPosition.coerceAtLeast(0)
        val done = completed
        val pos = position
        setResult(RESULT_OK, Intent().putExtra("episodeId", episodeId).putExtra("positionMs", pos))
        sample(exo.isPlaying)
        if (event == "stop") {
            val end = clock?.offset(SystemClock.elapsedRealtime()) ?: 0
            queue(end, end, 0, pos, done, true)
            clock = null
        }
    }

    private fun sample(isPlaying: Boolean) {
        val clock = clock ?: return
        val pos = player?.currentPosition?.coerceAtLeast(0) ?: position
        clock.sample(SystemClock.elapsedRealtime(), isPlaying).forEach { queue(it.start, it.end, it.played, pos, completed, false) }
    }

    private fun queue(start: Long, end: Long, played: Long, pos: Long, done: Boolean, stopped: Boolean) {
        if (watchId.isEmpty()) return
        val id = watchId
        val body = JSONObject().put("seq", sequence++).put("startMs", start).put("endMs", end)
            .put("playedMs", played).put("positionMs", pos).put("completed", done).put("stopped", stopped)
        app.io.execute { runCatching { app.watchQueue.enqueue(id, body) } }
    }

    private fun release() {
        handler.removeCallbacks(heartbeat)
        if (::playerView.isInitialized) playerView.player = null
        player?.release()
        player = null
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    override fun onPause() {
        player?.let { playOnResume = it.playWhenReady; it.pause() }
        super.onPause()
    }
    override fun onStop() {
        active = false
        loadGeneration++
        report("stop")
        release()
        super.onStop()
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putLong("position", player?.currentPosition ?: position)
        outState.putBoolean("play", player?.playWhenReady ?: playOnResume)
        super.onSaveInstanceState(outState)
    }
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val exo = player
        if (exo != null && event.keyCode in listOf(KeyEvent.KEYCODE_SPACE, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
                KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE)) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                when (event.keyCode) {
                    KeyEvent.KEYCODE_MEDIA_PLAY -> exo.play()
                    KeyEvent.KEYCODE_MEDIA_PAUSE -> exo.pause()
                    else -> if (exo.playWhenReady) exo.pause() else exo.play()
                }
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (event?.repeatCount == 0 && keyCode in listOf(KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER) &&
            (player == null || player?.playerError != null)) {
            report("stop"); release(); load(); return true
        }
        return super.onKeyDown(keyCode, event)
    }
    override fun onDestroy() { release(); super.onDestroy() }
}
