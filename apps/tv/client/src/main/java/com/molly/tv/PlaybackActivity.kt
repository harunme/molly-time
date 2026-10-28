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
import androidx.media3.datasource.HttpDataSource
import androidx.media3.ui.PlayerView
import org.json.JSONObject

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class PlaybackActivity : AppCompatActivity() {
    private val app get() = application as MollyTimeApplication
    private lateinit var playerView: PlayerView
    private lateinit var status: TextView
    private lateinit var watchingNotice: TextView
    private var managedClip = false
    private var endingManaged = false
    private var player: Player? = null
    private var playerOwner: ThreadedPlayer? = null
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
    private var episodeRuntimeMs = 0L
    private var offlineMode = false
    private var watchStartedAt = 0L
    private var parentClipPath = ""
    private var parentClipAfter = false
    private var parentClipPosition = 0L
    private var reminderRequestId = ""
    private var reminderChecking = false
    private val watchTick = object : Runnable {
        override fun run() {
            if (!active || isFinishing) return
            val allowed = if (player == null) true else runCatching { app.watchControl.tick(player?.isPlaying == true && parentClipPath.isEmpty()) }.getOrDefault(false)
            if (!allowed && parentClipPath.isEmpty() && !advancing) { endManaged(); return }
            if (player?.isPlaying == true && parentClipPath.isEmpty()) runCatching { app.watchControl.notice() }.getOrNull()?.let { text -> watchingNotice.text = text; watchingNotice.visibility = android.view.View.VISIBLE; handler.postDelayed({ watchingNotice.visibility = android.view.View.GONE }, 5000) }
            handler.postDelayed(this, 100)
        }
    }
    private val reminderPoll = object : Runnable {
        override fun run() {
            if (!active || isFinishing) return
            if (offlineMode) {
                val info = sourceInfo
                if (info != null) app.catalog.reads.execute {
                    runCatching { OfflinePolicy.permission(app.catalog.store(), app.session.deviceId, episodeId,
                        info.getString("mediaId"), info.getString("version")) }.onFailure { runOnUiThread { finish() } }
                }
                handler.postDelayed(this, 2000)
                return
            }
            if (!reminderChecking && parentClipPath.isEmpty() && !advancing) {
                reminderChecking = true
                val generation = loadGeneration
                app.playbackIo.execute {
                    runCatching { app.watchControl.sync(); reminderState() }.onSuccess { state -> runOnUiThread {
                        if (active && generation == loadGeneration && !isFinishing && player != null &&
                            state.optString("phase") == "pending" && state.optString("episodeId") == episodeId &&
                            (!state.has("sessionId") || state.optString("sessionId") == watchId) &&
                            state.optString("requestId") != reminderRequestId) {
                            reminderRequestId = state.getString("requestId")
                            report("stop")
                            release()
                            showParentClip(state.getString("warningPath"), false)
                        }
                    } }.onFailure { error -> if (error is ApiFailure && error.status in listOf(401, 403)) runOnUiThread { finish() } }
                    runOnUiThread { reminderChecking = false }
                }
            }
            handler.postDelayed(this, 2000)
        }
    }

    private fun reminderState(): JSONObject = try { app.api.json("GET", "/api/reminders/state") }
        catch (error: ApiFailure) { if (error.status == 404) JSONObject().put("phase", "idle") else throw error }
    private var refreshAttempts = 0
    private var skipCacheWrites = false
    private var selectedSubtitle: String? = null
    private var playbackSpeed = 1f
    private var playbackMenu: AlertDialog? = null
    private var clock: PlayingClock? = null
    private var sequence = 0
    private val handler = Handler(Looper.getMainLooper())
    private val heartbeat = object : Runnable {
        override fun run() {
            report("progress")
            if (!offlineMode) app.playbackIo.execute {
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
        managedClip = state?.getBoolean("managedClip", false) ?: false
        parentClipPath = if (managedClip) state?.getString("parentClipPath") ?: "" else ""
        parentClipAfter = state?.getBoolean("parentClipAfter", false) ?: false
        parentClipPosition = state?.getLong("parentClipPosition", 0) ?: 0
        watchId = state?.getString("watchId") ?: ""
        selectedSubtitle = state?.getString("selectedSubtitle")
        playbackSpeed = state?.getFloat("playbackSpeed", 1f) ?: 1f
        resumeFromProgress = state?.getBoolean("resumeFromProgress", true) ?: true
        playerView = PlayerView(this).apply { setShowSubtitleButton(false); setShowNextButton(false); setShowPreviousButton(false) }
        status = TextView(this).apply { textSize = 22f; setTextColor(android.graphics.Color.WHITE); setPadding(24, 24, 24, 24) }
        val frame = FrameLayout(this)
        frame.addView(playerView, FrameLayout.LayoutParams(-1, -1))
        frame.addView(status)
        watchingNotice = TextView(this).apply { textSize = 26f; setTextColor(android.graphics.Color.WHITE); setPadding(24, 24, 24, 24); setBackgroundColor(0xCC1C222A.toInt()); visibility = android.view.View.GONE }
        frame.addView(watchingNotice, FrameLayout.LayoutParams(-2, -2, android.view.Gravity.TOP or android.view.Gravity.CENTER_HORIZONTAL))
        setContentView(frame)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { finish() }
        })
    }

    override fun onStart() {
        super.onStart()
        active = true
        handler.post(reminderPoll)
        handler.post(watchTick)
        if (parentClipPath.isNotEmpty()) loadParentClip() else if (awaitingNext) advance() else load()
    }

    private fun load(continueReminder: Boolean = false) {
        val current = ++loadGeneration
        val loadingEpisode = episodeId
        val previousSessionId = if (continueReminder) watchId else ""
        status.text = "正在加载视频…"
        app.playbackIo.execute {
            runCatching {
                PlaybackAccess.load(online = online@{
                    app.watchControl.sync()
                    app.watchControl.requireEpisode(loadingEpisode)
                    app.watchControl.warningPath(loadingEpisode)?.let { return@online Triple(JSONObject().put("managedWarning", it), JSONObject(), "") }
                    val detail = app.api.json("GET", "/api/episodes/$loadingEpisode")
                    val resume = app.api.json("GET", app.api.progressPath(loadingEpisode, child))
                    val body = JSONObject().put("episodeId", loadingEpisode)
                    if (previousSessionId.isNotEmpty()) body.put("previousSessionId", previousSessionId)
                    if (child.isNotEmpty()) body.put("childId", child)
                    val watch = app.api.json("POST", "/api/playback/sessions", body)
                    app.watchControl.sync()
                    val sessionId = watch.getString("sessionId")
                    val mediaId = Uri.parse(detail.getJSONArray("sources").optJSONObject(0)?.optString("url") ?: "").getQueryParameter("mediaId")
                    val info = app.api.json("GET", "/api/episodes/$loadingEpisode/playback?sessionId=$sessionId" + (mediaId?.let { "&mediaId=$it" } ?: ""))
                    detail.put("playback", info)
                    Triple(detail, resume, sessionId)
                }, offline = { offlineLoad(loadingEpisode) })
            }.onSuccess { (detail, resume, sessionId) -> runOnUiThread {
                if (active && current == loadGeneration && !isDestroyed && !isFinishing) {
                    if (detail.has("managedWarning")) { managedClip = true; showParentClip(detail.getString("managedWarning"), false); return@runOnUiThread }
                    offlineMode = detail.optJSONObject("playback")?.optBoolean("offline") == true
                    watchId = sessionId
                    watchStartedAt = resume.optLong("localSessionStartedAt", System.currentTimeMillis())
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

    private fun offlineLoad(id: String): Triple<JSONObject, JSONObject, String> {
        app.watchControl.requireEpisode(id, true)
        val store = app.catalog.store()
        store.requireEventCapacity()
        val detail = app.media.offline(id, store)
        val info = detail.getJSONObject("playback")
        val sessionId = java.util.UUID.randomUUID().toString()
        val started = OfflinePolicy.now(store)
        store.session(sessionId, JSONObject().put("id", sessionId).put("episodeId", id)
            .put("mediaId", info.getString("mediaId")).put("version", info.getString("version"))
            .put("startedAt", started).put("grant", JSONObject(store.get("grant")!!).getString("token"))
            .put("expiresAt", OfflinePolicy.payload(JSONObject(store.get("grant")!!).getString("token"), store.get("serverPublicKey")!!).getLong("expiresAt")))
        val resume = store.overlay(JSONObject().put("id", id)).put("localSessionStartedAt", started)
        return Triple(detail, resume, sessionId)
    }

    private fun prepare(detail: JSONObject) {
        val runtime = detail.optLong("runtimeMs", 0)
        if (runtime > 0) episodeRuntimeMs = runtime
        if (runtime > 0 && position >= runtime) position = 0
        val source = detail.getJSONObject("playback")
        sourceInfo = source
        val cacheWrites = !skipCacheWrites
        connectPlayer(cacheWrites, source.optBoolean("offline")) { exo -> configureEpisode(exo, source) }
    }

    private fun connectPlayer(cacheWrites: Boolean = true, offline: Boolean = false, ready: (Player) -> Unit) {
        playerOwner?.release()
        val owner = ThreadedPlayer(applicationContext)
        playerOwner = owner
        owner.connect({ looper ->
            val dataSource = if (offline) app.media.offlineFactory() else app.media.factory(cacheWrites)
            ExoPlayer.Builder(applicationContext).setLooper(looper)
                .setMediaSourceFactory(DefaultMediaSourceFactory(dataSource)).build()
        }, { connected ->
            if (playerOwner !== owner || !active || isFinishing || isDestroyed) owner.release()
            else ready(connected)
        }, { error ->
            if (playerOwner === owner && active && !isFinishing) {
                release()
                status.text = (error.message ?: "播放器初始化失败") + "。按确定重试，返回退出"
            }
        })
    }

    private fun configureEpisode(exo: Player, source: JSONObject) {
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
            MediaItem.SubtitleConfiguration.Builder(Uri.parse(if (source.optBoolean("offline")) sub.getString("url") else app.session.server + sub.getString("url")))
                .setId("subtitle-${sub.getInt("index")}")
                .setMimeType(if (sub.optString("codec") == "vtt") MimeTypes.TEXT_VTT else MimeTypes.APPLICATION_SUBRIP)
                .setLanguage(sub.optString("language", "und")).setLabel(sub.optString("label"))
                .setSelectionFlags(if (sub.optBoolean("isDefault")) C.SELECTION_FLAG_DEFAULT else 0).build()
        }
        exo.addListener(object : Player.Listener {
            override fun onTracksChanged(tracks: Tracks) { applySubtitle() }
            override fun onPlaybackParametersChanged(parameters: PlaybackParameters) { playbackSpeed = parameters.speed }
            override fun onPlayerError(error: PlaybackException) {
                reportPlaybackError(error, source.optString("mediaId"), episodeId)
                if (error.errorCode == PlaybackException.ERROR_CODE_IO_UNSPECIFIED && !skipCacheWrites) {
                    // A failed cache write is one possible cause. Retry once without writing cache.
                    skipCacheWrites = true
                    refreshSource()
                } else if (error.errorCode == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS && refreshAttempts < 2) {
                    refreshSource()
                } else status.text = "播放失败（${error.errorCodeName}）。按确定重试，返回退出"
            }
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY) status.text = ""
                if (state == Player.STATE_ENDED) { completed = true; awaitingNext = true; advance() }
            }
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                if (BuildConfig.DEBUG) android.util.Log.d("MollyTimePlayback", "isPlaying=$isPlaying")
                if (!runCatching { app.watchControl.tick(isPlaying) }.getOrDefault(false)) { endManaged(); return }
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
        app.watchControl.complete(episodeId)
        release()
        val current = ++loadGeneration
        val finishedEpisode = episodeId
        status.text = "正在准备下一集…"
        (if (offlineMode) app.catalog.reads else app.playbackIo).execute {
            runCatching {
                if (offlineMode) return@runCatching JSONObject().put("episodeId", (if (app.watchControl.managedEpisodes() && app.watchControl.snapshot().optString("status") != "allowed") null else app.catalog.store().nextEpisode(finishedEpisode)) ?: JSONObject.NULL)
                app.watchControl.sync()
                if (app.watchControl.snapshot().optBoolean("enabled") && app.watchControl.snapshot().optString("status") != "allowed") return@runCatching JSONObject().put("episodeId", JSONObject.NULL)
                val reminder = reminderState()
                if (reminder.optString("episodeId") == finishedEpisode && reminder.optString("phase") != "idle" &&
                    (!reminder.has("sessionId") || reminder.optString("sessionId") == watchId))
                    JSONObject().put("parentFarewell", reminder.getString("farewellPath"))
                else app.api.json("GET", "/api/episodes/$finishedEpisode/next")
            }
                .onSuccess { result -> runOnUiThread {
                    if (!active || current != loadGeneration || isFinishing || isDestroyed) return@runOnUiThread
                    advancing = false
                    if (result.has("parentFarewell")) {
                        awaitingNext = false
                        showParentClip(result.getString("parentFarewell"), true)
                        return@runOnUiThread
                    }
                    val next = if (result.isNull("episodeId")) "" else result.optString("episodeId")
                    if (next.isEmpty()) {
                        awaitingNext = false
                        endManaged()
                    } else {
                        reminderRequestId = ""
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
                        skipCacheWrites = false
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

    private fun endManaged() {
        if (endingManaged || isFinishing) return
        endingManaged = true
        player?.pause(); report("stop"); release()
        val path = if (offlineMode) null else runCatching { app.watchControl.farewellPath() }.getOrNull()
        if (path != null) { managedClip = true; showParentClip(path, true) } else finish()
    }

    private fun showParentClip(path: String, after: Boolean) {
        parentClipPath = path
        parentClipAfter = after
        parentClipPosition = 0L
        clock = null
        loadParentClip()
    }

    private fun loadParentClip() {
        val generation = ++loadGeneration
        status.text = if (parentClipAfter) "休息提醒" else "茉莉，还剩 1 集哦"
        app.playbackIo.execute {
            runCatching { app.api.json("GET", parentClipPath) }.onSuccess { info -> runOnUiThread {
                if (!active || generation != loadGeneration || isFinishing) return@runOnUiThread
                connectPlayer { exo -> configureParentClip(exo, info) }
            } }.onFailure { error -> runOnUiThread {
                if (active && generation == loadGeneration) { if (managedClip) finishParentClip() else status.text = (error.message ?: "家长视频加载失败") + "。按确定重试，返回退出" }
            } }
        }
    }

    private fun configureParentClip(exo: Player, info: JSONObject) {
        player = exo
        playerView.player = exo
        exo.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY) status.text = ""
                if (state == Player.STATE_ENDED) finishParentClip()
            }
            override fun onIsPlayingChanged(playing: Boolean) {
                if (playing) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
            override fun onPlayerError(error: PlaybackException) {
                reportPlaybackError(error, info.optString("mediaId"), null)
                if (managedClip) finishParentClip() else status.text = "家长视频播放失败。按确定重试，返回退出"
            }
        })
        exo.setMediaItem(MediaItem.Builder().setUri(app.media.uri(info)).setCustomCacheKey(app.media.key(info))
            .setMimeType(info.optString("mime", "video/mp4")).build(), parentClipPosition)
        exo.prepare()
        exo.playWhenReady = playOnResume
        handler.postDelayed(heartbeat, 15000)
        playerView.requestFocus()
    }

    private fun finishParentClip() {
        release()
        if (parentClipAfter) { finish(); return }
        if (managedClip) { managedClip = false; parentClipPath = ""; parentClipPosition = 0L; load(true); return }
        val generation = ++loadGeneration
        status.text = "正在返回最后一集…"
        app.playbackIo.execute {
            runCatching { app.api.json("POST", "/api/reminders/requests/$reminderRequestId/ack") }
                .onSuccess { runOnUiThread {
                    if (!active || generation != loadGeneration || isFinishing) return@runOnUiThread
                    parentClipPath = ""
                    parentClipPosition = 0L
                    playOnResume = true
                    if (completed) { awaitingNext = true; advance() } else load(true)
                } }.onFailure { error -> runOnUiThread {
                    if (!active || generation != loadGeneration || isFinishing) return@runOnUiThread
                    if (error is ApiFailure && error.status == 404) { parentClipPath = ""; load(true) }
                    else status.text = "提醒确认失败。按确定重试，返回退出"
                } }
        }
    }

    private fun refreshSource() {
        if (offlineMode) { status.text = "离线视频读取失败，请联网检查副本。返回退出"; return }
        val mediaId = sourceInfo?.optString("mediaId") ?: return
        refreshAttempts++
        position = player?.currentPosition?.coerceAtLeast(0) ?: position
        playOnResume = player?.playWhenReady ?: true
        sample(false)
        release()
        status.text = "正在刷新播放地址…"
        val current = ++loadGeneration
        app.playbackIo.execute {
            runCatching { app.api.json("GET", "/api/episodes/$episodeId/playback?mediaId=$mediaId&sessionId=$watchId") }
                .onSuccess { info -> runOnUiThread {
                    if (active && current == loadGeneration) prepare(JSONObject().put("playback", info))
                } }.onFailure { error -> runOnUiThread {
                    if (active && current == loadGeneration) status.text = (error.message ?: "播放地址刷新失败") + "。按确定重试"
                } }
        }
    }

    private fun reportPlaybackError(error: PlaybackException, mediaId: String?, episode: String?) {
        // Only structured diagnostics leave the TV; exception messages may contain signed URLs.
        val causes = generateSequence(error.cause) { it.cause }.take(6).toList()
        val types = org.json.JSONArray(causes.map { it.javaClass.name })
        val httpStatus = causes.filterIsInstance<HttpDataSource.InvalidResponseCodeException>()
            .firstOrNull()?.responseCode
        android.util.Log.e("MollyTimePlayback",
            "Playback failed: ${error.errorCodeName}, causes=${causes.joinToString(" -> ") { it.javaClass.simpleName }}, http=$httpStatus")
        val body = JSONObject().put("id", java.util.UUID.randomUUID().toString())
            .put("category", "playback").put("code", error.errorCodeName)
            .put("causeTypes", types).put("positionMs", player?.currentPosition?.coerceAtLeast(0) ?: 0)
            .put("availableBytes", filesDir.usableSpace).put("appVersion", BuildConfig.VERSION_NAME)
        if (!episode.isNullOrEmpty()) body.put("episodeId", episode)
        if (!mediaId.isNullOrEmpty()) body.put("mediaId", mediaId)
        if (httpStatus != null) body.put("httpStatus", httpStatus)
        app.io.execute { runCatching { app.errorLogQueue.enqueue(body) }
            .onFailure { android.util.Log.w("MollyTimePlayback", "Could not queue playback error: ${it.javaClass.simpleName}") } }
    }

    private fun report(event: String) {
        if (parentClipPath.isNotEmpty()) return
        val exo = player ?: return
        position = exo.currentPosition.coerceAtLeast(0)
        val done = completed
        val pos = position
        if (event == "stop" && clock == null) return
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
        val local = offlineMode
        val queuedEpisode = episodeId
        val store = app.catalog.store()
        val started = watchStartedAt
        app.catalog.reads.execute {
            runCatching {
                if (local) store.enqueue(id, body)
                store.recordPosition(queuedEpisode, pos, done, id, body.getInt("seq"), started)
            }.onFailure { if (local) runOnUiThread { player?.pause(); status.text = "离线记录保存失败，请联网同步。返回退出" } }
        }
        if (!local) app.io.execute { runCatching { app.watchQueue.enqueue(id, body) } }
    }

    private fun release() {
        runCatching { app.watchControl.tick(false) }
        playbackMenu?.dismiss()
        playbackMenu = null
        handler.removeCallbacks(heartbeat)
        if (::playerView.isInitialized) playerView.player = null
        playerOwner?.release()
        playerOwner = null
        player = null
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun finishReminder() {
        val sessionId = watchId
        if (sessionId.isEmpty() || offlineMode) return
        app.playbackIo.execute { runCatching { app.api.json("POST", "/api/reminders/finish", JSONObject().put("sessionId", sessionId)) } }
    }

    override fun finish() {
        // Activity results are captured by finish(), before onStop(). Capture the
        // final position now; reporting and engine cleanup must not delay return.
        if (!isFinishing && ::episodeId.isInitialized) {
            report("stop")
            finishReminder()
            val runtime = if (parentClipPath.isEmpty()) player?.duration?.takeIf { it > 0 } ?: episodeRuntimeMs else episodeRuntimeMs
            setResult(RESULT_OK, Intent().putExtra("episodeId", episodeId)
                .putExtra("positionMs", position).putExtra("completed", completed)
                .putExtra("runtimeMs", runtime).putExtra("progressKnown", watchId.isNotEmpty()))
        }
        super.finish()
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
    }

    override fun onPause() {
        player?.let { playOnResume = it.playWhenReady; it.pause() }
        super.onPause()
    }
    override fun onStop() {
        active = false
        handler.removeCallbacks(reminderPoll)
        handler.removeCallbacks(watchTick)
        runCatching { app.watchControl.tick(false) }
        if (parentClipPath.isNotEmpty()) parentClipPosition = player?.currentPosition?.coerceAtLeast(0) ?: parentClipPosition
        advancing = false
        loadGeneration++
        report("stop")
        if (!isChangingConfigurations) {
            finishReminder()
            parentClipPath = ""; parentClipAfter = false; managedClip = false; reminderRequestId = ""
        }
        release()
        super.onStop()
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBoolean("managedClip", managedClip)
        outState.putString("parentClipPath", parentClipPath)
        outState.putBoolean("parentClipAfter", parentClipAfter)
        outState.putLong("parentClipPosition", if (parentClipPath.isNotEmpty()) player?.currentPosition ?: parentClipPosition else 0)
        outState.putString("reminderRequestId", reminderRequestId)
        outState.putString("watchId", watchId)
        outState.putString("episodeId", episodeId)
        outState.putLong("position", if (parentClipPath.isEmpty()) player?.currentPosition ?: position else position)
        outState.putBoolean("play", player?.playWhenReady ?: playOnResume)
        outState.putBoolean("awaitingNext", awaitingNext)
        outState.putBoolean("resumeFromProgress", resumeFromProgress)
        outState.putString("selectedSubtitle", selectedSubtitle)
        outState.putFloat("playbackSpeed", playbackSpeed)
        super.onSaveInstanceState(outState)
    }
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val exo = player
        if (exo != null && parentClipPath.isEmpty() && event.keyCode == KeyEvent.KEYCODE_MENU) {
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
            if (parentClipPath.isNotEmpty()) { release(); loadParentClip() } else if (awaitingNext) advance() else { report("stop"); release(); load(true) }
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
        val parameters = SubtitleSelection.parameters(exo.trackSelectionParameters, selectedSubtitle,
            choice?.let { TrackSelectionOverride(it.group.mediaTrackGroup, it.index) })
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
        val selected = SubtitleSelection.menuIndex(selectedSubtitle, choices.map { it.id })
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
