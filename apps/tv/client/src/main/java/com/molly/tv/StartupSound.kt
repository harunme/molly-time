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

    fun start(server: String, active: () -> Boolean) {
        worker.execute {
            val file = runCatching {
                val config = JSONObject(fetch(server + "/api/startup", 4096).toString(Charsets.UTF_8))
                if (!config.optBoolean("configured") || stopped) return@execute
                val version = config.getString("version")
                require(Regex("[0-9a-f]{64}").matches(version))
                val directory = File(context.cacheDir, "startup-sound").apply { mkdirs() }
                val target = File(directory, "$version.mp3")
                if (!target.isFile) {
                    // Construct the path locally; never follow a config URL to another host.
                    val bytes = fetch(server + "/api/startup/audio/$version", 128 * 1024)
                    val digest = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
                    require(digest == version)
                    if (stopped) return@execute
                    val temp = File.createTempFile(".startup-", ".mp3", directory)
                    try { temp.writeBytes(bytes); check(temp.renameTo(target)) } finally { temp.delete() }
                }
                directory.listFiles()?.filter { it != target }?.forEach { it.delete() }
                target
            }.getOrNull()
            if (file != null) handler.post {
                if (stopped || !active()) return@post
                val audio = MediaPlayer()
                player = audio
                runCatching {
                    audio.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANCE_SONIFICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    audio.setDataSource(file.absolutePath)
                    audio.isLooping = false
                    audio.setOnPreparedListener { if (!stopped && active()) it.start() else release() }
                    audio.setOnCompletionListener { release() }
                    audio.setOnErrorListener { _, _, _ -> file.delete(); release(); true }
                    audio.prepareAsync()
                }.onFailure { release() }
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
        release(); worker.shutdownNow()
    }
}
