package com.molly.tv

import android.content.Context
import android.net.Uri
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.datasource.cache.Cache
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheEvictor
import androidx.media3.datasource.cache.CacheSpan
import androidx.media3.datasource.cache.CacheWriter
import androidx.media3.datasource.cache.SimpleCache
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** One cache for playback and downloads. Pinned complete files survive ordinary LRU eviction. */
@UnstableApi
class MediaStore(private val context: Context, private val session: SessionStore, private val api: MollyTimeApi) {
    private val directory = File(context.filesDir, "media-cache")
    private val prefs = context.getSharedPreferences("molly.media.v1", Context.MODE_PRIVATE)
    private val executor = Executors.newSingleThreadExecutor()
    private val busy = AtomicBoolean(false)
    @Volatile private var generation = 0
    @Volatile private var writer: CacheWriter? = null
    private val pinned = java.util.concurrent.ConcurrentHashMap.newKeySet<String>()
    private val evictor = HouseholdEvictor(directory, pinned)
    private val cache: SimpleCache
    init {
        pinned.addAll(prefs.getStringSet("pinned", emptySet())!!)
        cache = SimpleCache(directory, evictor, StandaloneDatabaseProvider(context))
        synchronizeOwner()
    }

    @Synchronized fun synchronizeOwner() {
        val owner = session.server + ":" + session.deviceId
        if (owner != prefs.getString("owner", "") || session.refresh.isEmpty()) {
            generation++
            writer?.cancel()
            pinned.clear()
            cache.keys.forEach { runCatching { cache.removeResource(it) } }
            prefs.edit().clear().putString("owner", owner).commit()
        }
    }

    fun key(info: JSONObject) = info.getString("mediaId") + ":" + info.getString("version")

    /** Credentials are chosen for each request, including redirects, by origin. */
    fun upstream(): DataSource.Factory {
        val server = session.server.toHttpUrl()
        val client = api.http.newBuilder().followRedirects(true).addNetworkInterceptor { chain ->
            val request = chain.request()
            val sameOrigin = MediaRequestPolicy.sameOrigin(server, request.url)
            val builder = request.newBuilder().removeHeader("Authorization").removeHeader("Cookie")
            if (sameOrigin) builder.header("Authorization", "Bearer ${session.access}")
            chain.proceed(builder.build())
        }.build()
        return DefaultDataSource.Factory(context, OkHttpDataSource.Factory(client))
    }

    fun factory(): CacheDataSource.Factory {
        synchronizeOwner()
        return CacheDataSource.Factory().setCache(cache).setUpstreamDataSourceFactory(upstream())
            .setFlags(CacheDataSource.FLAG_BLOCK_ON_CACHE or CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
    }

    fun uri(info: JSONObject): Uri = Uri.parse(info.getString("url")).let {
        if (it.scheme == null) Uri.parse(session.server + it.toString()) else it
    }

    private fun rememberPins() { prefs.edit().putStringSet("pinned", pinned.toSet()).commit() }
    private fun complete(key: String, size: Long) = size > 0 && cache.isCached(key, 0, size)
    private fun verified(key: String) = prefs.getBoolean("verified:$key", false)

    private fun verify(key: String, size: Long, expected: String) {
        require(complete(key, size)) { "视频未下载完整" }
        if (expected.isNotEmpty()) {
            val digest = MessageDigest.getInstance("SHA-256")
            val source = CacheDataSource.Factory().setCache(cache).createDataSource()
            try {
                source.open(DataSpec.Builder().setUri("https://cache.invalid/video").setKey(key).setLength(size).build())
                val buffer = ByteArray(256 * 1024)
                while (true) {
                    val count = source.read(buffer, 0, buffer.size)
                    if (count < 0) break
                    digest.update(buffer, 0, count)
                }
            } finally { source.close() }
            require(digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) } == expected) { "视频校验失败，请重试下载" }
        }
        prefs.edit().putBoolean("verified:$key", true).commit()
    }

    private fun report(row: JSONObject, state: String, bytes: Long, error: String = "") {
        api.json("POST", "/api/device/downloads/${row.getString("id")}/status", JSONObject()
            .put("version", row.getString("version")).put("status", state)
            .put("downloadedBytes", bytes).put("error", error.take(256)))
    }

    /** Called while the application is running; transfers use a separate serial executor. */
    fun poll() {
        synchronizeOwner()
        if (session.deviceId.isEmpty() || session.refresh.isEmpty()) return
        val rows = org.json.JSONArray(api.text("GET", "/api/device/downloads"))
        for (i in 0 until rows.length()) {
            val row = rows.getJSONObject(i)
            val key = row.getString("mediaId") + ":" + row.getString("version")
            if (row.getString("desired") == "removed") {
                if (row.optString("status") != "removed" || key in cache.keys) {
                    generation++
                    writer?.cancel()
                    pinned.remove(key); rememberPins()
                    runCatching { cache.removeResource(key) }
                    prefs.edit().remove("verified:$key").commit()
                    report(row, "removed", 0)
                }
                continue
            }
            val size = row.getLong("size")
            if (row.optString("status") == "saved") {
                if (!complete(key, size) || !verified(key)) report(row, "failed", 0, "电视副本已丢失，请重新保存")
                continue
            }
            if (row.optString("status") !in listOf("queued", "downloading") || !row.has("playback")) continue
            if (!busy.compareAndSet(false, true)) continue
            val owner = generation
            executor.execute {
                try {
                    check(owner == generation) { "下载已取消" }
                    pinned.add(key); rememberPins()
                    val missing = (size - cache.getCachedBytes(key, 0, size)).coerceAtLeast(0)
                    check(directory.usableSpace - missing >= HouseholdEvictor.RESERVE) { "电视空间不足，请清理已保存视频" }
                    report(row, "downloading", size - missing)
                    var info = row.getJSONObject("playback")
                    for (attempt in 0..2) {
                        if (complete(key, size)) break
                        if (attempt > 0) info = api.json("GET", "/api/device/downloads/${row.getString("id")}/playback")
                        val spec = DataSpec.Builder().setUri(uri(info)).setKey(key).setLength(size).build()
                        // Fail instead of bypassing the cache: a download must actually persist bytes.
                        val dataSource = CacheDataSource.Factory().setCache(cache).setUpstreamDataSourceFactory(upstream())
                            .setFlags(CacheDataSource.FLAG_BLOCK_ON_CACHE).createDataSource()
                        var lastReport = 0L
                        val transfer = CacheWriter(dataSource, spec, ByteArray(256 * 1024)) { _, cached, _ ->
                            check(owner == generation) { "下载已取消" }
                            val now = System.currentTimeMillis()
                            if (now - lastReport > 10000) { report(row, "downloading", cached.coerceAtMost(size)); lastReport = now }
                        }
                        writer = transfer
                        try { transfer.cache(); break } catch (error: IOException) { if (attempt == 2 || owner != generation) throw error }
                    }
                    check(owner == generation) { "下载已取消" }
                    verify(key, size, info.optString("sha256"))
                    check(owner == generation) { "下载已取消" }
                    report(row, "saved", size)
                } catch (error: Exception) {
                    pinned.remove(key); rememberPins()
                    if (error.message?.contains("校验") == true) runCatching { cache.removeResource(key) }
                    if (owner == generation) runCatching { report(row, "failed", cache.getCachedBytes(key, 0, size).coerceAtMost(size), error.message ?: "保存失败，请重试") }
                } finally {
                    if (owner != generation) runCatching { cache.removeResource(key) }
                    writer = null; busy.set(false)
                }
            }
        }
    }
}

@UnstableApi
private class HouseholdEvictor(private val directory: File, private val pinned: Set<String>) : CacheEvictor {
    companion object { const val RESERVE = 1024L * 1024 * 1024; const val LIMIT = 5L * 1024 * 1024 * 1024 }
    private val spans = java.util.TreeSet<CacheSpan>(compareBy<CacheSpan> { it.lastTouchTimestamp }.thenBy { it.key }.thenBy { it.position })
    override fun requiresCacheSpanTouches() = true
    override fun onCacheInitialized() {}
    override fun onStartFile(cache: Cache, key: String, position: Long, length: Long) {
        evict(cache, if (length < 0) 2 * 1024 * 1024L else length)
        if (directory.usableSpace < RESERVE + (if (length < 0) 2 * 1024 * 1024L else length)) throw IOException("电视缓存空间不足")
    }
    override fun onSpanAdded(cache: Cache, span: CacheSpan) { spans.add(span); evict(cache, 0) }
    override fun onSpanRemoved(cache: Cache, span: CacheSpan) { spans.remove(span) }
    override fun onSpanTouched(cache: Cache, old: CacheSpan, updated: CacheSpan) { spans.remove(old); spans.add(updated) }
    private fun evict(cache: Cache, incoming: Long) {
        while (spans.isNotEmpty()) {
            val ordinary = spans.filter { it.key !in pinned }
            if (ordinary.isEmpty()) return
            if (ordinary.sumOf { it.length } + incoming <= LIMIT && directory.usableSpace >= RESERVE + incoming) return
            cache.removeSpan(ordinary.first())
        }
    }
}
