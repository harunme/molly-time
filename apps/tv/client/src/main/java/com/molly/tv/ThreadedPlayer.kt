package com.molly.tv

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaController
import androidx.media3.session.MediaSession
import com.google.common.util.concurrent.ListenableFuture
import java.util.UUID
import java.util.concurrent.Executor

/** UI commands use a main-thread controller; decoder/surface teardown never waits on the UI thread. */
@UnstableApi
class ThreadedPlayer(context: Context) {
    private val context = context.applicationContext
    private val thread = HandlerThread("MollyTimePlayer").apply { start() }
    private val worker = Handler(thread.looper)
    private val main = Handler(Looper.getMainLooper())
    private val mainExecutor = Executor { main.post(it) }
    @Volatile private var closed = false
    // Engine and session belong exclusively to worker; controllerFuture belongs to main.
    private var engine: ExoPlayer? = null
    private var session: MediaSession? = null
    private var controllerFuture: ListenableFuture<MediaController>? = null

    fun connect(create: (Looper) -> ExoPlayer, ready: (Player) -> Unit, failed: (Throwable) -> Unit) {
        check(Looper.myLooper() == Looper.getMainLooper())
        worker.post {
            if (closed) return@post
            try {
                val player = create(thread.looper)
                engine = player
                val mediaSession = MediaSession.Builder(context, player)
                    .setId(UUID.randomUUID().toString())
                    .setCallback(object : MediaSession.Callback {
                        override fun onConnect(session: MediaSession, controller: MediaSession.ControllerInfo): MediaSession.ConnectionResult {
                            if (controller.uid != Process.myUid()) return MediaSession.ConnectionResult.reject()
                            return super.onConnect(session, controller)
                        }
                    }).build()
                session = mediaSession
                main.post controller@{
                    if (closed) return@controller
                    try {
                        val future = MediaController.Builder(context, mediaSession.token)
                            .setApplicationLooper(Looper.getMainLooper()).buildAsync()
                        controllerFuture = future
                        future.addListener({
                            if (!closed) {
                                try { ready(future.get()) }
                                catch (error: Exception) { release(); failed(error) }
                            }
                        }, mainExecutor)
                    } catch (error: Exception) { release(); failed(error) }
                }
            } catch (error: Exception) {
                main.post { if (!closed) { release(); failed(error) } }
            }
        }
    }

    fun release() {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (closed) return
        closed = true
        controllerFuture?.let { MediaController.releaseFuture(it) }
        controllerFuture = null
        // MediaSession and ExoPlayer share this looper. Releasing the controller
        // only disconnects the UI; the potentially blocking engine release stays here.
        worker.post {
            try {
                try {
                    engine?.pause()
                    session?.release()
                } finally { engine?.release() }
            } catch (error: Exception) {
                android.util.Log.w("MollyTimePlayback", "Player cleanup failed", error)
            } finally {
                session = null
                engine = null
                thread.quitSafely()
            }
        }
    }
}
