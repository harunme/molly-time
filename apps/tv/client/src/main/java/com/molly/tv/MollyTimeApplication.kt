package com.molly.tv

import android.app.Application
import java.util.concurrent.Executors

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class MollyTimeApplication : Application() {
    lateinit var session: SessionStore
    lateinit var api: MollyTimeApi
    lateinit var media: MediaStore
    lateinit var watchQueue: WatchQueue
    lateinit var errorLogQueue: ErrorLogQueue
    lateinit var updates: ClientUpdates
    lateinit var webBundles: WebBundleStore
    lateinit var catalog: CatalogSync
    var catalogListener: ((String, org.json.JSONObject) -> Unit)? = null
    val webUpdateExecutor = Executors.newSingleThreadExecutor()
    // Interactive playback never waits behind persisted event uploads or downloads.
    val playbackIo = Executors.newSingleThreadExecutor()
    // Persisted event queues retain their ordering; token rotation has its own lock.
    val io = Executors.newSingleThreadExecutor()
    override fun onCreate() {
        super.onCreate()
        session = SessionStore(this) { if (::media.isInitialized) media.synchronizeOwner() }
        // Upgrade legacy parent-token TV sessions to revocable device credentials at next login.
        if (session.access.isNotEmpty() && session.deviceId.isEmpty()) session.clear()
        api = MollyTimeApi(session) { DeviceName.read(this) }
        val covers = CoverStore(this, session, api)
        catalog = CatalogSync(this, session, api, covers, emit = { name, detail ->
            android.os.Handler(android.os.Looper.getMainLooper()).post { catalogListener?.invoke(name, detail) }
        })
        catalog.start()
        val connectivity = getSystemService(android.net.ConnectivityManager::class.java)
        val networkChanges = object : android.net.ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: android.net.Network) { catalog.checkSoon() }
            override fun onLost(network: android.net.Network) { if (connectivity.activeNetwork == null) catalog.networkLost() }
        }
        if (android.os.Build.VERSION.SDK_INT >= 24) connectivity.registerDefaultNetworkCallback(networkChanges)
        else connectivity.registerNetworkCallback(android.net.NetworkRequest.Builder().addCapability(android.net.NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), networkChanges)
        if (connectivity.activeNetwork == null) catalog.networkLost()
        updates = ClientUpdates(this)
        webBundles = WebBundleStore(this)
        media = MediaStore(this, session, api)
        watchQueue = WatchQueue(this, session, api)
        errorLogQueue = ErrorLogQueue(this, session, api)
        io.execute { runCatching { watchQueue.flush() }; runCatching { errorLogQueue.flush() } }
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        handler.postDelayed(object : Runnable {
            override fun run() {
                io.execute { runCatching { watchQueue.flush() }; runCatching { errorLogQueue.flush() }; runCatching { media.poll() } }
                handler.postDelayed(this, 60000)
            }
        }, 1000)
    }
}
