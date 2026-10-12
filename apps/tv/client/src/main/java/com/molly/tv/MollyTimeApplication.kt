package com.molly.tv

import android.app.Application
import java.util.concurrent.Executors

class MollyTimeApplication : Application() {
    lateinit var session: SessionStore
    lateinit var api: MollyTimeApi
    lateinit var watchQueue: WatchQueue
    // Serial execution prevents refresh-token rotation races and preserves event order.
    val io = Executors.newSingleThreadExecutor()
    override fun onCreate() {
        super.onCreate()
        session = SessionStore(this)
        // Upgrade legacy parent-token TV sessions to revocable device credentials at next login.
        if (session.access.isNotEmpty() && session.deviceId.isEmpty()) session.clear()
        api = MollyTimeApi(session)
        watchQueue = WatchQueue(this, session, api)
        io.execute { watchQueue.flush() }
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        handler.postDelayed(object : Runnable {
            override fun run() {
                io.execute { runCatching { watchQueue.flush() } }
                handler.postDelayed(this, 60000)
            }
        }, 60000)
    }
}
