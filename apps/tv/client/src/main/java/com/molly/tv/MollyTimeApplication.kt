package com.molly.tv

import android.app.Application
import java.util.concurrent.Executors

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class MollyTimeApplication : Application() {
    lateinit var session: SessionStore
    lateinit var api: MollyTimeApi
    lateinit var media: MediaStore
    lateinit var watchQueue: WatchQueue
    lateinit var updates: ClientUpdates
    // Serial execution prevents refresh-token rotation races and preserves event order.
    val io = Executors.newSingleThreadExecutor()
    override fun onCreate() {
        super.onCreate()
        session = SessionStore(this) { if (::media.isInitialized) media.synchronizeOwner() }
        // Upgrade legacy parent-token TV sessions to revocable device credentials at next login.
        if (session.access.isNotEmpty() && session.deviceId.isEmpty()) session.clear()
        api = MollyTimeApi(session) { DeviceName.read(this) }
        updates = ClientUpdates(this)
        media = MediaStore(this, session, api)
        watchQueue = WatchQueue(this, session, api)
        io.execute { watchQueue.flush() }
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        handler.postDelayed(object : Runnable {
            override fun run() {
                io.execute { runCatching { watchQueue.flush() }; runCatching { media.poll() } }
                handler.postDelayed(this, 60000)
            }
        }, 1000)
    }
}
