package com.molly.tv

import android.content.Context
import android.net.Uri
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.StandaloneDatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.datasource.cache.Cache
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheEvictor
import androidx.media3.datasource.cache.CacheSpan
import androidx.media3.datasource.cache.SimpleCache
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject
import java.io.File
import java.io.IOException

/** Playback writes read-through cache spans; repeat playback reuses them across signed URLs. */
@UnstableApi
class MediaStore(private val context: Context, private val session: SessionStore, private val api: MollyTimeApi) {
    private val directory = File(context.filesDir, "media-cache")
    private val prefs = context.getSharedPreferences("molly.media.v1", Context.MODE_PRIVATE)
    private val database = StandaloneDatabaseProvider(context)
    private val evictor = HouseholdEvictor(directory)
    private val cache: SimpleCache
    init {
        // Previously saved copies now follow the same eviction rules as playback cache.
        prefs.edit().remove("pinned").apply()
        cache = SimpleCache(directory, evictor, database)
        synchronizeOwner()
    }

    @Synchronized fun synchronizeOwner() {
        val owner = session.server + ":" + session.deviceId
        if (owner != prefs.getString("owner", "") || session.refresh.isEmpty()) {
            cache.keys.forEach { runCatching { cache.removeResource(it) } }
            prefs.edit().clear().putString("owner", owner).commit()
        }
    }

    internal fun close() { cache.release(); database.close() }

    fun key(info: JSONObject) = info.getString("mediaId") + ":" + info.getString("version")

    /** Credentials are chosen for each request, including redirects, by origin. */
    fun upstream(): DataSource.Factory {
        val client = api.http.newBuilder().followRedirects(true).addNetworkInterceptor { chain ->
            val request = chain.request()
            val credentials = session.credentials()
            val sameOrigin = credentials.server.isNotEmpty() && MediaRequestPolicy.sameOrigin(credentials.server.toHttpUrl(), request.url)
            val builder = request.newBuilder().removeHeader("Authorization").removeHeader("Cookie")
            if (sameOrigin) builder.header("Authorization", "Bearer ${credentials.access}")
            chain.proceed(builder.build())
        }.build()
        return DefaultDataSource.Factory(context, OkHttpDataSource.Factory(client))
    }

    fun factory(cacheWrites: Boolean = true): CacheDataSource.Factory {
        synchronizeOwner()
        val factory = CacheDataSource.Factory().setCache(cache).setUpstreamDataSourceFactory(upstream())
            .setFlags(CacheDataSource.FLAG_BLOCK_ON_CACHE or CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
        // Streaming must still work when the TV has too little free space for a new cache span.
        // Existing cached spans remain readable; only new writes are disabled.
        if (!cacheWrites || directory.usableSpace < HouseholdEvictor.RESERVE + 5L * 1024 * 1024) {
            factory.setCacheWriteDataSinkFactory(null)
        }
        return factory
    }

    fun uri(info: JSONObject): Uri = Uri.parse(info.getString("url")).let {
        if (it.scheme == null) Uri.parse(session.server + it.toString()) else it
    }

    // Read-only compatibility for previously saved, verified copies. Playback cache
    // does not create offline descriptors or request complete downloads.
    fun offlineFactory(): DataSource.Factory = androidx.media3.datasource.DefaultDataSource.Factory(context, CacheDataSource.Factory().setCache(cache)
        .setCacheReadDataSourceFactory(androidx.media3.datasource.FileDataSource.Factory())
        .setUpstreamDataSourceFactory(null).setCacheWriteDataSinkFactory(null))

    fun offline(episode: String, store: CatalogStore): JSONObject {
        val detail = store.savedPlayback(episode) ?: throw IllegalStateException("此视频尚未完整保存，需要联网播放")
        val info = detail.getJSONObject("playback")
        val permission = OfflinePolicy.permission(store, session.deviceId, episode, info.getString("mediaId"), info.getString("version"))
        check(permission.optString("sha256").matches(Regex("[a-f0-9]{64}"))) { "此副本缺少完整性校验，请联网重新保存" }
        check(complete(key(info), permission.getLong("size")) && verified(key(info))) { "离线视频副本不完整，请联网重新保存" }
        val subs = info.optJSONArray("subtitles") ?: org.json.JSONArray()
        for (i in 0 until subs.length()) {
            val path = Uri.parse(subs.getJSONObject(i).getString("url"))
            check(path.scheme == "file" && File(path.path!!).canonicalPath.startsWith(File(context.filesDir, "offline-subtitles").canonicalPath + "/") && File(path.path!!).isFile) { "离线字幕不完整，请联网同步" }
        }
        info.put("url", "cache://offline/" + info.getString("mediaId")).put("offline", true)
        return detail
    }

    fun decorateOffline(items: org.json.JSONArray, store: CatalogStore) {
        val permissions = runCatching { OfflinePolicy.permissions(store, session.deviceId) }.getOrNull() ?: return
        val allowed = (0 until permissions.length()).map { permissions.getJSONObject(it) }.associateBy { it.getString("episodeId") }
        for (i in 0 until items.length()) {
            val item = items.getJSONObject(i); val p = allowed[item.optString("id")] ?: continue
            val info = store.savedPlayback(item.getString("id"))?.optJSONObject("playback") ?: continue
            val subs = info.optJSONArray("subtitles") ?: org.json.JSONArray()
            val ready = info.optString("mediaId") == p.optString("mediaId") && info.optString("version") == p.optString("version") &&
                p.optString("sha256").matches(Regex("[a-f0-9]{64}")) && complete(key(info), p.optLong("size")) && verified(key(info)) &&
                (0 until subs.length()).all { val uri = Uri.parse(subs.getJSONObject(it).optString("url")); uri.scheme == "file" && uri.path?.let { path -> File(path).isFile } == true }
            item.put("offlineAvailable", ready)
        }
    }
    private fun complete(key: String, size: Long) = size > 0 && cache.isCached(key, 0, size)
    private fun verified(key: String) = prefs.getBoolean("verified:$key", false)
}

@UnstableApi
private class HouseholdEvictor(private val directory: File) : CacheEvictor {
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
            if (cache.cacheSpace + incoming <= LIMIT && directory.usableSpace >= RESERVE + incoming) return
            cache.removeSpan(spans.first())
        }
    }
}
