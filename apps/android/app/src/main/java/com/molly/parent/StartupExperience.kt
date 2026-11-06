package com.molly.parent

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import org.json.JSONObject

/** Same gate as iOS: launch/session overlap, final pose waits for audio and session, no replay. */
class StartupExperience(private val context: Context) {
    var finished by mutableStateOf(false); private set
    private var started = false
    var startedAt = 0L; private set
    private var player: MediaPlayer? = null
    private val handler = Handler(Looper.getMainLooper())
    fun start() {
        if (started || finished) return
        started = true; startedAt = SystemClock.uptimeMillis()
        val reduced = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        val minimum = if (reduced) 600L else 1800L
        var duration = minimum
        try {
            val config = JSONObject(context.assets.open("startup/config.json").bufferedReader().use { it.readText() })
            if (config.optBoolean("configured")) {
                val audio = MediaPlayer(); player = audio
                audio.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                context.assets.openFd("startup/sound.mp3").use { audio.setDataSource(it.fileDescriptor, it.startOffset, it.length) }
                audio.setOnErrorListener { _, _, _ -> stopAudio(); true }
                audio.prepare(); audio.start()
                duration = maxOf(minimum, audio.duration.toLong().coerceAtMost(6000L))
            }
        } catch (_: Exception) { stopAudio() }
        handler.postDelayed({ stop() }, duration)
    }
    fun elapsedMs(): Long = if (startedAt == 0L) 0L else (SystemClock.uptimeMillis() - startedAt).coerceAtLeast(0)
    private fun stopAudio() { player?.let { runCatching { it.stop() }; it.release() }; player = null }
    fun stop() { handler.removeCallbacksAndMessages(null); stopAudio(); finished = true }
}
