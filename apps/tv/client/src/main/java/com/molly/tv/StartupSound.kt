package com.molly.tv

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import android.os.Handler
import android.os.Looper

/** Independent, bounded startup work must never queue behind catalog sync or hold up launch. */
class StartupSound(private val context: Context, http: OkHttpClient) {
    private val client = http.newBuilder().callTimeout(1500, TimeUnit.MILLISECONDS)
        .followRedirects(false).followSslRedirects(false).build()
    private val worker = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    @Volatile private var stopped = false
    @Volatile private var call: Call? = null
    private var player: MediaPlayer? = null
    private var cue: StartupCue? = null

    fun start(server: String, onReady: () -> Unit = {}, active: () -> Boolean) {
        val launch = StartupCue(onReady)
        cue = launch
        // Wait briefly with a static logo. Past this deadline the launch is silent,
        // even if a download or decoder finishes later; keep the file for next time.
        handler.postDelayed({
            if (!stopped && active() && launch.ready()) release()
        }, 600)
        worker.execute {
            val file = runCatching {
                val config = JSONObject(fetch(server + "/api/startup", 4096).toString(Charsets.UTF_8))
                if (!config.optBoolean("configured") || stopped) return@runCatching null
                val version = config.getString("version")
                require(Regex("[0-9a-f]{64}").matches(version))
                val directory = File(context.cacheDir, "startup-sound").apply { mkdirs() }
                val target = File(directory, "$version.mp3")
                if (!target.isFile) {
                    // Construct the path locally; never follow a config URL to another host.
                    val bytes = fetch(server + "/api/startup/audio/$version", 128 * 1024)
                    val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
                    require(digest == version)
                    if (stopped) return@runCatching null
                    val temp = File.createTempFile(".startup-", ".mp3", directory)
                    try { temp.writeBytes(bytes); check(temp.renameTo(target)) } finally { temp.delete() }
                }
                directory.listFiles()?.filter { it != target }?.forEach { it.delete() }
                target
            }.getOrNull()
            handler.post {
                if (stopped || !active()) return@post
                if (file == null) { launch.ready(); return@post }
                if (launch.started) return@post
                val audio = MediaPlayer()
                player = audio
                runCatching {
                    audio.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    audio.setDataSource(file.absolutePath)
                    audio.isLooping = false
                    audio.setOnPreparedListener {
                        runCatching {
                            if (stopped || !active() || !launch.ready { it.start() }) release()
                        }.onFailure { release() }
                    }
                    audio.setOnCompletionListener { release() }
                    audio.setOnErrorListener { _, _, _ ->
                        file.delete(); release()
                        if (!stopped && active()) launch.ready()
                        true
                    }
                    audio.prepareAsync()
                }.onFailure { release(); if (!stopped && active()) launch.ready() }
            }
        }
    }
    private fun fetch(url: String, limit: Int): ByteArray {
        check(!stopped)
        val request = client.newCall(Request.Builder().url(url).build())
        call = request
        if (stopped) request.cancel()
        return request.execute().use { response ->
            check(response.isSuccessful)
            val stream = response.body!!.byteStream()
            val out = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = stream.read(buffer)
                if (count < 0) break
                check(out.size() + count <= limit)
                out.write(buffer, 0, count)
            }
            out.toByteArray()
        }
    }
    private fun release() { player?.release(); player = null }
    fun stop() {
        stopped = true; call?.cancel(); handler.removeCallbacksAndMessages(null)
        cue?.cancel()
        release(); worker.shutdownNow()
    }
}
