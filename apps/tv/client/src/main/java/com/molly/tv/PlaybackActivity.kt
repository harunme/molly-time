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
import androidx.appcompat.app.AlertDialog
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.common.*
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import org.json.JSONObject

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class PlaybackActivity : AppCompatActivity() {
    private val app get() = application as MollyTimeApplication
    private lateinit var playerView: PlayerView
    private lateinit var status: TextView
    private var player: ExoPlayer? = null
    private lateinit var episodeId: String
    private var child = ""
    private var position = 0L
    private var completed = false
    private var awaitingNext = false
    private var advancing = false
    private var resumeFromProgress = true
    private var playOnResume = true
    private var active = false
    private var loadGeneration = 0
    private var watchId = ""
    private var sourceInfo: JSONObject? = null
    private var refreshAttempts = 0
    private var selectedSubtitle: String? = null
    private var playbackSpeed = 1f
    private var playbackMenu: AlertDialog? = null
    private var clock: PlayingClock? = null
    private var sequence = 0
    private val handler = Handler(Looper.getMainLooper())
    private val heartbeat = object : Runnable {
        override fun run() {
            report("progress")
            app.io.execute {
                runCatching { app.api.json("GET", "/api/me") }.onFailure { error ->
                    if (error is ApiFailure && error.status in listOf(401, 403)) runOnUiThread {
                        player?.pause(); finish()
                    }
                }
            }
            handler.postDelayed(this, 15000)
        }
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        episodeId = state?.getString("episodeId") ?: intent.getStringExtra("episodeId") ?: run { finish(); return }
        child = intent.getStringExtra("childId") ?: ""
        position = state?.getLong("position") ?: 0
        playOnResume = state?.getBoolean("play", true) ?: true
        awaitingNext = state?.getBoolean("awaitingNext", false) ?: false
        completed = awaitingNext
        selectedSubtitle = state?.getString("selectedSubtitle")
        playbackSpeed = state?.getFloat("playbackSpeed", 1f) ?: 1f
        resumeFromProgress = state?.getBoolean("resumeFromProgress", true) ?: true
        playerView = PlayerView(this).apply { setShowSubtitleButton(false); setShowNextButton(false); setShowPreviousButton(false) }
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
        if (awaitingNext) advance() else load()
    }

    private fun load() {
        val current = ++loadGeneration
        val loadingEpisode = episodeId
        status.text = "正在加载视频…"
        app.io.execute {
            runCatching {
                val detail = app.api.json("GET", "/api/episodes/$loadingEpisode")
                val resume = app.api.json("GET", app.api.progressPath(loadingEpisode, child))
                val body = JSONObject().put("episodeId", loadingEpisode)
                if (child.isNotEmpty()) body.put("childId", child)
                val watch = app.api.json("POST", "/api/playback/sessions", body)
                val sessionId = watch.getString("sessionId")
                val mediaId = Uri.parse(detail.getJSONArray("sources").optJSONObject(0)?.optString("url") ?: "").getQueryParameter("mediaId")
                val info = app.api.json("GET", "/api/episodes/$loadingEpisode/playback?sessionId=$sessionId" + (mediaId?.let { "&mediaId=$it" } ?: ""))
                detail.put("playback", info)
                Triple(detail, resume, sessionId)
            }.onSuccess { (detail, resume, sessionId) -> runOnUiThread {
                if (active && current == loadGeneration && !isDestroyed && !isFinishing) {
                    watchId = sessionId
                    clock = PlayingClock(SystemClock.elapsedRealtime())
                    sequence = 0
                    if (resumeFromProgress && position == 0L && !resume.optBoolean("completed")) position = resume.optLong("positionMs")
                    resumeFromProgress = false
                    refreshAttempts = 0
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
        val source = detail.getJSONObject("playback")
        sourceInfo = source
        val dataSource = app.media.factory()
        val exo = ExoPlayer.Builder(this).setMediaSourceFactory(DefaultMediaSourceFactory(dataSource)).build()
        player = exo
        playerView.player = exo
        val subtitles = source.optJSONArray("subtitles")
        if (selectedSubtitle == null) {
            selectedSubtitle = (0 until (subtitles?.length() ?: 0)).firstOrNull {
                subtitles!!.getJSONObject(it).optBoolean("isDefault")
            }?.let { "subtitle-${subtitles!!.getJSONObject(it).getInt("index")}" } ?: "off"
        }
        val configs = (0 until (subtitles?.length() ?: 0)).map { index ->
            val sub = subtitles!!.getJSONObject(index)
            MediaItem.SubtitleConfiguration.Builder(Uri.parse(app.session.server + sub.getString("url")))
                .setId("subtitle-${sub.getInt("index")}")
                .setMimeType(if (sub.optString("codec") == "vtt") MimeTypes.TEXT_VTT else MimeTypes.APPLICATION_SUBRIP)
                .setLanguage(sub.optString("language", "und")).setLabel(sub.optString("label"))
                .setSelectionFlags(if (sub.optBoolean("isDefault")) C.SELECTION_FLAG_DEFAULT else 0).build()
        }
        exo.addListener(object : Player.Listener {
            override fun onTracksChanged(tracks: Tracks) { applySubtitle() }
            override fun onPlaybackParametersChanged(parameters: PlaybackParameters) { playbackSpeed = parameters.speed }
            override fun onPlayerError(error: PlaybackException) {
                if (error.errorCode == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS && refreshAttempts < 2) {
                    refreshSource()
                } else status.text = "播放失败（${error.errorCodeName}）。按确定重试，返回退出"
            }
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY) status.text = ""
                if (state == Player.STATE_ENDED) { completed = true; awaitingNext = true; advance() }
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (BuildConfig.DEBUG) android.util.Log.d("MollyTimePlayback", "isPlaying=$isPlaying")
                sample(isPlaying)
                if (isPlaying) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        })
        exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon()
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, selectedSubtitle == "off").build()
        exo.setPlaybackSpeed(playbackSpeed)
        exo.setMediaItem(MediaItem.Builder().setUri(app.media.uri(source))
            .setCustomCacheKey(app.media.key(source)).setMimeType(source.optString("mime", "video/mp4"))
            .setMediaId(episodeId).setSubtitleConfigurations(configs).build(), position)
        exo.prepare()
        exo.playWhenReady = playOnResume
        handler.postDelayed(heartbeat, 15000)
        playerView.requestFocus()
    }

    private fun advance() {
        if (advancing || !active || isFinishing) return
        advancing = true
        // Finalize the previous session before releasing its player or changing episodeId.
        report("stop")
        release()
        val current = ++loadGeneration
        val finishedEpisode = episodeId
        status.text = "正在准备下一集…"
        app.io.execute {
            runCatching { app.api.json("GET", "/api/episodes/$finishedEpisode/next") }
                .onSuccess { result -> runOnUiThread {
                    if (!active || current != loadGeneration || isFinishing || isDestroyed) return@runOnUiThread
                    advancing = false
                    val next = if (result.isNull("episodeId")) "" else result.optString("episodeId")
                    if (next.isEmpty()) {
                        awaitingNext = false
                        finish()
                    } else {
                        episodeId = next
                        position = 0L
                        completed = false
                        awaitingNext = false
                        resumeFromProgress = false
                        playOnResume = true
                        watchId = ""
                        clock = null
                        sourceInfo = null
                        selectedSubtitle = null
                        playbackSpeed = 1f
                        load()
                    }
                } }.onFailure { error -> runOnUiThread {
                    if (!active || current != loadGeneration || isFinishing) return@runOnUiThread
                    advancing = false
                    if (error is ApiFailure && error.status in listOf(401, 403, 404)) finish()
                    else status.text = "下一集加载失败。按确定重试，返回退出"
                } }
        }
    }

    private fun refreshSource() {
        val mediaId = sourceInfo?.optString("mediaId") ?: return
        refreshAttempts++
        position = player?.currentPosition?.coerceAtLeast(0) ?: position
        playOnResume = player?.playWhenReady ?: true
        sample(false)
        release()
        status.text = "正在刷新播放地址…"
        val current = ++loadGeneration
        app.io.execute {
            runCatching { app.api.json("GET", "/api/episodes/$episodeId/playback?mediaId=$mediaId&sessionId=$watchId") }
                .onSuccess { info -> runOnUiThread {
                    if (active && current == loadGeneration) prepare(JSONObject().put("playback", info))
                } }.onFailure { error -> runOnUiThread {
                    if (active && current == loadGeneration) status.text = (error.message ?: "播放地址刷新失败") + "。按确定重试"
                } }
        }
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
        playbackMenu?.dismiss()
        playbackMenu = null
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
        advancing = false
        loadGeneration++
        report("stop")
        release()
        super.onStop()
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("episodeId", episodeId)
        outState.putLong("position", player?.currentPosition ?: position)
        outState.putBoolean("play", player?.playWhenReady ?: playOnResume)
        outState.putBoolean("awaitingNext", awaitingNext)
        outState.putBoolean("resumeFromProgress", resumeFromProgress)
        outState.putString("selectedSubtitle", selectedSubtitle)
        outState.putFloat("playbackSpeed", playbackSpeed)
        super.onSaveInstanceState(outState)
    }
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val exo = player
        if (exo != null && event.keyCode == KeyEvent.KEYCODE_MENU) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) showPlaybackMenu()
            return true
        }
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
            if (awaitingNext) advance() else { report("stop"); release(); load() }
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    private data class SubtitleChoice(val id: String, val label: String, val group: Tracks.Group, val index: Int)

    private fun subtitleChoices(): List<SubtitleChoice> = player?.currentTracks?.groups?.flatMapIndexed { groupIndex, group ->
        if (group.type != C.TRACK_TYPE_TEXT) emptyList() else (0 until group.length).mapNotNull { index ->
            if (!group.isTrackSupported(index)) null else {
                val format = group.getTrackFormat(index)
                val language = when (format.language) { "zh" -> "中文"; "en" -> "英文"; "zh-en" -> "中英文"; else -> format.language ?: "字幕" }
                SubtitleChoice(format.id ?: "embedded-$groupIndex-$index", "$language · ${format.label ?: "字幕 ${index + 1}"}", group, index)
            }
        }
    } ?: emptyList()

    private fun applySubtitle() {
        val exo = player ?: return
        val choice = subtitleChoices().firstOrNull { it.id == selectedSubtitle }
        val builder = exo.trackSelectionParameters.buildUpon().clearOverridesOfType(C.TRACK_TYPE_TEXT)
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, choice == null)
        if (choice != null) builder.setOverrideForType(TrackSelectionOverride(choice.group.mediaTrackGroup, choice.index))
        val parameters = builder.build()
        if (parameters != exo.trackSelectionParameters) exo.trackSelectionParameters = parameters
    }

    private fun showPlaybackMenu() {
        if (playbackMenu?.isShowing == true) return
        playbackMenu = AlertDialog.Builder(this).setTitle("播放设置 · 仅当前视频")
            .setItems(arrayOf("选择字幕", "播放速度（${playbackSpeed}×）")) { _, which ->
                if (which == 0) showSubtitleMenu() else showSpeedMenu()
            }.setNegativeButton("返回播放", null).create().also { it.show() }
    }

    private fun showSubtitleMenu() {
        val choices = subtitleChoices()
        val labels = arrayOf("关闭字幕", *choices.map { it.label }.toTypedArray())
        val selected = choices.indexOfFirst { it.id == selectedSubtitle }.let { if (it < 0) 0 else it + 1 }
        playbackMenu = AlertDialog.Builder(this).setTitle(if (choices.isEmpty()) "此视频没有可用字幕" else "选择字幕")
            .setSingleChoiceItems(labels, selected) { dialog, which ->
                selectedSubtitle = if (which == 0) "off" else choices[which - 1].id
                applySubtitle()
                dialog.dismiss()
            }.setNegativeButton("返回播放", null).create().also { it.show() }
    }

    private fun showSpeedMenu() {
        val speeds = floatArrayOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 2f)
        playbackMenu = AlertDialog.Builder(this).setTitle("播放速度")
            .setSingleChoiceItems(speeds.map { "${it}×" }.toTypedArray(), speeds.indexOfFirst { it == playbackSpeed }) { dialog, which ->
                playbackSpeed = speeds[which]
                player?.setPlaybackSpeed(playbackSpeed)
                dialog.dismiss()
            }.setNegativeButton("返回播放", null).create().also { it.show() }
    }
    override fun onDestroy() { release(); super.onDestroy() }
}
