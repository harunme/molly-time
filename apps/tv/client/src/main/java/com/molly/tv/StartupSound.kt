package com.molly.tv

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.json.JSONObject

/** Immutable APK assets: no network, cache eviction, or 600 ms silent cutoff at launch. */
class StartupSound(context: Context, private val configure: (MediaPlayer) -> Boolean = { audio ->
    val config = JSONObject(context.assets.open("startup/config.json").bufferedReader().use { it.readText() })
    if (!config.getBoolean("configured")) false else {
        context.assets.openFd("startup/sound.mp3").use {
            audio.setDataSource(it.fileDescriptor, it.startOffset, it.length)
        }
        true
    }
}) {
    private val handler = Handler(Looper.getMainLooper())
    private var stopped = false
    private var player: MediaPlayer? = null
    private var cue: StartupCue? = null
    var finished = false
        private set
    private var finishCallback: () -> Unit = {}

    fun start(onReady: () -> Unit = {}, onFinished: () -> Unit = {}, active: () -> Boolean) {
        val launch = StartupCue(onReady)
        cue = launch
        finishCallback = onFinished
        prepare(launch, active, true)
    }
    private fun prepare(launch: StartupCue, active: () -> Boolean, retry: Boolean) {
        if (stopped) return
        val audio = MediaPlayer()
        player = audio
        val timeout = Runnable { failed(launch, active, retry) }
        val playbackTimeout = Runnable {
            if (player === audio) { release(); complete(launch) }
        }
        runCatching {
            audio.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            if (!configure(audio)) { release(); complete(launch); return }
            audio.isLooping = false
            audio.setOnPreparedListener {
                handler.removeCallbacks(timeout)
                if (stopped) { release(); return@setOnPreparedListener }
                runCatching {
                    if (active()) launch.ready {
                        it.start()
                        handler.postDelayed(playbackTimeout, 6500)
                    } else { release(); complete(launch) }
                }.onFailure { failed(launch, active, retry) }
            }
            audio.setOnCompletionListener {
                handler.removeCallbacks(timeout); handler.removeCallbacks(playbackTimeout)
                release(); complete(launch)
            }
            audio.setOnErrorListener { _, _, _ ->
                handler.removeCallbacks(timeout); handler.removeCallbacks(playbackTimeout)
                failed(launch, active, retry); true
            }
            audio.prepareAsync()
            handler.postDelayed(timeout, 4000)
        }.onFailure { handler.removeCallbacks(timeout); failed(launch, active, retry) }
    }
    private fun failed(launch: StartupCue, active: () -> Boolean, retry: Boolean) {
        release()
        if (stopped) return
        if (retry && !launch.started) prepare(launch, active, false)
        else { Log.w("MollyStartup", "包内启动音效播放失败"); complete(launch) }
    }
    private fun complete(launch: StartupCue) {
        if (stopped || finished) return
        finished = true
        launch.ready()
        finishCallback()
    }
    private fun release() { player?.release(); player = null }
    fun stop() {
        stopped = true
        handler.removeCallbacksAndMessages(null)
        cue?.cancel()
        release()
    }
}
