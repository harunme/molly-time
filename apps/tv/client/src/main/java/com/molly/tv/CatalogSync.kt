package com.molly.tv

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ConcurrentHashMap

/** Native local-first repository. Network steps never occupy the local-read executor. */
class CatalogSync(private val context: Context, private val session: SessionStore, private val api: MollyTimeApi,
                  val covers: CoverStore, private val emit: (String, JSONObject) -> Unit,
                  private val now: () -> Long = System::currentTimeMillis) {
    private val executor = Executors.newSingleThreadScheduledExecutor()
    private val coverExecutor = Executors.newFixedThreadPool(2)
    val reads = Executors.newSingleThreadExecutor()
    @Volatile private var closed = false
    private var scheduled: ScheduledFuture<*>? = null
    private var scheduledAt = Long.MAX_VALUE
    @Volatile private var retryAt = 0L
    @Volatile private var requestedCheckAt = Long.MAX_VALUE
    private val queuedCovers = java.util.Collections.newSetFromMap(ConcurrentHashMap<String, Boolean>())
    @Volatile private var owner = ""
    @Volatile private var current: CatalogStore? = null
    @Volatile private var paused = false
    @Volatile private var online = false
    @Volatile private var unsupported = false
    @Volatile private var message = ""
    @Volatile private var preferred = ""
    @Volatile private var lastCheck = 0L
    @Volatile private var call: okhttp3.Call? = null
    @Volatile private var coverPending = false
    @Volatile private var coversComplete = false
    @Volatile private var metadataComplete = false
    @Volatile private var pendingUpload = false
    @Volatile private var prefetchAt = 0L
    private var failures = 0

    fun store(): CatalogStore {
        val binding = session.server + "|" + session.deviceId
        check(session.refresh.isNotEmpty() && session.deviceId.isNotEmpty()) { "请先绑定电视" }
        synchronized(this) {
            if (binding != owner || current == null) {
                // Old handles are left open for already-running readers; no other binding can query them.
                owner = binding; current = CatalogStore(context, binding); lastCheck = 0; unsupported = false; online = false
                message = ""; metadataComplete = false; coverPending = false
            }
            return current!!
        }
    }
    fun close() { closed = true; call?.cancel(); covers.cancel(); executor.shutdownNow(); coverExecutor.shutdownNow(); reads.shutdownNow(); current?.close() }
    fun start() = schedule(1000)
    fun resume() { paused = false; checkSoon() }
    fun pause() { paused = true; call?.cancel(); covers.cancel() }
    fun networkLost() {
        online = false; message = "当前离线，使用本地内容"; call?.cancel(); covers.cancel()
        reads.execute { if (session.refresh.isNotEmpty()) changed("status") }
    }
    fun checkSoon() {
        requestedCheckAt = minOf(requestedCheckAt, if (now() - lastCheck >= 10000) now() else lastCheck + 10000)
        retryAt = 0; schedule(0)
    }
    @Synchronized private fun schedule(delay: Long) {
        if (closed) return
        val due = android.os.SystemClock.elapsedRealtime() + delay
        if (scheduled != null && scheduledAt <= due) return
        scheduled?.cancel(false)
        scheduledAt = due
        scheduled = executor.schedule({
            synchronized(this) { scheduled = null; scheduledAt = Long.MAX_VALUE }
            if (!paused && now() >= requestedCheckAt) { lastCheck = 0; requestedCheckAt = Long.MAX_VALUE }
            if (!paused && session.refresh.isNotEmpty() && session.deviceId.isNotEmpty() && now() >= retryAt) tick()
            val wait = (retryAt - now()).coerceAtLeast(0)
            val delay = if (wait > 0) wait else if (paused) 60000 else if (preferred.isEmpty() && now() < prefetchAt) prefetchAt - now() else if (hasMetadataWork() || coverPending || pendingUpload) 250 else 60000
            schedule(if (paused) delay else minOf(delay, (requestedCheckAt - now()).coerceAtLeast(0)))
        }, delay, TimeUnit.MILLISECONDS)
    }
    private fun json(path: String): JSONObject = api.catalogResponse(path) { call = it }.use { JSONObject(it.body!!.string()) }
    private fun hasMetadataWork(): Boolean = runCatching {
        val s = store(); val manifest = s.get("manifest")?.let { JSONObject(it) } ?: return@runCatching false
        if (s.get("homeVersion") != manifest.getString("homeVersion")) return@runCatching true
        val folders = manifest.getJSONArray("folders")
        (0 until folders.length()).any { val f = folders.getJSONObject(it); s.needsFolder(f.getString("id"), f.getString("version")) }
    }.getOrDefault(false)
    internal fun tick() {
        if (paused || closed) return
        var s: CatalogStore? = null
        try {
            s = store(); val binding = owner
            if (now() - lastCheck >= 60000) {
                val state = json("/api/tv/sync-state")
                check(binding == session.server + "|" + session.deviceId)
                OfflinePolicy.accept(s, state)
                s.put("scope", state.getString("scope"))
                s.put("lastSync", state.getLong("serverTime").toString())
                lastCheck = now(); online = true; unsupported = false; message = ""
                if (s.get("catalogVersion") != state.getString("catalogVersion")) {
                    val manifest = json("/api/tv/catalog/manifest?version=" + state.getString("catalogVersion"))
                    s.prune(manifest)
                    s.put("catalogVersion", state.getString("catalogVersion"))
                    // Recent cards also contain titles, visibility and artwork.
                    s.remove("playbackVersion")
                    changed("manifest")
                }
                if (s.get("policyVersion") != state.getString("policyVersion")) {
                    s.put("policyVersion", state.getString("policyVersion")); changed("availability")
                }
                if (s.get("playbackVersion") != state.getString("playbackVersion") && !s.hasPendingEvents()) {
                    val progress = json("/api/tv/playback-state")
                    s.acceptProgress(progress); changed("progress")
                }
            }
            if (paused || !online || unsupported) return
            if (flushOffline(s)) {
                if (!pendingUpload) { s.acceptProgress(json("/api/tv/playback-state")); changed("progress") }
                return
            }
            if (preferred.isEmpty() && now() < prefetchAt) return
            val manifest = s.get("manifest")?.let { JSONObject(it) } ?: return
            val homeVersion = manifest.getString("homeVersion")
            if (s.get("homeVersion") != homeVersion && s.get("homeStageVersion") != homeVersion) {
                val data = json("/api/tv/catalog/home?version=$homeVersion&page=1&pageSize=48")
                val rows = data.getJSONArray("rows")
                val definitions = JSONArray()
                for (i in 0 until rows.length()) {
                    val row = rows.getJSONObject(i)
                    s.accept("home:" + row.getString("id"), homeVersion, 1, row.getJSONArray("items"), row.getBoolean("hasMore"), row)
                    definitions.put(JSONObject(row.toString()).apply { remove("items") })
                    queueImages(row.getJSONArray("items"))
                }
                failures = 0
                s.put("homeStage", JSONObject().put("version", homeVersion).put("rows", definitions).toString()); s.put("homeStageVersion", homeVersion)
                if (s.get("home") == null) { s.put("home", s.get("homeStage")!!); prefetchAt = now() + 1000 }
                changed("home")
                return
            }
            val folders = manifest.getJSONArray("folders")
            val ordered = (0 until folders.length()).map { folders.getJSONObject(it) }.sortedBy { if (it.getString("id") == preferred) 0 else 1 }
            // Finish the opened folder first, then home rows, then the rest of the library.
            val active = ordered.find { it.getString("id") == preferred && s.needsFolder(it.getString("id"), it.getString("version")) }
            if (active != null) { folderStep(s, active); return }
            if (s.get("homeVersion") != homeVersion) {
                val definition = JSONObject(s.get("homeStage") ?: "{\"rows\":[]}").getJSONArray("rows")
                for (i in 0 until definition.length()) {
                    val row = definition.getJSONObject(i); val id = row.getString("id")
                    if (s.needs("home:$id", homeVersion)) {
                        val page = s.nextPage("home:$id", homeVersion)
                        val data = json("/api/tv/catalog/home?version=$homeVersion&page=$page&pageSize=48&rowId=$id").getJSONArray("rows").getJSONObject(0)
                        s.accept("home:$id", homeVersion, page, data.getJSONArray("items"), data.getBoolean("hasMore"), data)
                        queueImages(data.getJSONArray("items")); changed("home"); return
                    }
                }
                s.publishHome(s.get("homeStage")!!, homeVersion); changed("home")
            }
            val next = ordered.find { s.needsFolder(it.getString("id"), it.getString("version")) }
            if (next != null) { folderStep(s, next); return }
            failures = 0
            if (queuedCovers.size < 64) {
                val missing = s.cachedImages().filter { covers.cached(it.optString("url").substringBefore('?'), it.optString("version")) == null && it.optString("version").matches(Regex("[a-f0-9]{64}")) }
                coversComplete = missing.isEmpty()
                val untried = missing.filter { s.get("coverAttempt:" + CatalogStore.digest(it.optString("url").substringBefore('?') + "|" + it.optString("version"))) == null }
                coverPending = untried.isNotEmpty()
                queueImages(JSONArray().apply { untried.forEach { put(JSONObject().put("image", it)) } })
            }
        } catch (error: Exception) {
            if (paused) return
            when {
                error is ApiFailure && error.status in listOf(401, 403) -> {
                    s?.put("authorizationDenied", "true"); s?.remove("grant"); online = false; message = "电视授权已失效，请重新绑定"; changed("authorization")
                }
                error is ApiFailure && error.status == 404 && s?.get("manifest") == null -> { unsupported = true; online = false }
                error is ApiFailure && error.status == 409 -> { s?.remove("homeStageVersion"); lastCheck = 0; message = "内容已更新，正在重新同步" }
                else -> { online = false; message = if (error is IOException) "当前离线，使用本地内容" else error.message ?: "同步暂时失败" }
            }
            failures++
            val backoff = longArrayOf(5000, 15000, 60000, 300000)[(failures - 1).coerceIn(0, 3)]
            // Preserve the last attempted clock; the next retry performs a fresh policy check.
            lastCheck = 0; retryAt = now() + backoff
            changed("status")
        } finally {
            call = null
            val complete = !hasMetadataWork() && s?.get("home") != null
            if (metadataComplete != complete) { metadataComplete = complete; emit("molly:catalogStatus", status()) }
        }
    }
    private fun folderStep(s: CatalogStore, folder: JSONObject) {
        val id = folder.getString("id"); val version = folder.getString("version"); val page = s.nextFolderPage(id, version)
        val data = json("/api/tv/catalog/folders/$id?version=$version&page=$page&pageSize=48")
        s.acceptFolder(id, version, page, data)
        failures = 0; queueImages(data.getJSONArray("episodes")); data.optJSONArray("items")?.let { queueImages(it) }; changed("folder:$id")
    }
    private fun queueImages(items: JSONArray) {
        val binding = owner
        val cacheStore = current ?: return
        for (i in 0 until items.length()) {
            val image = items.getJSONObject(i).optJSONObject("image") ?: continue
            val version = image.optString("version"); val path = image.optString("url").substringBefore('?')
            if (!version.matches(Regex("[a-f0-9]{64}")) || covers.cached(path, version) != null) continue
            val key = "$binding|$path|$version"
            val attempt = "coverAttempt:" + CatalogStore.digest("$path|$version")
            if (cacheStore.get(attempt) != null) continue
            if (queuedCovers.size >= 128 || !queuedCovers.add(key)) continue
            coverExecutor.execute {
                try { if (!paused && binding == owner && session.refresh.isNotEmpty()) runCatching { covers.fetch(path, version); if (binding == owner) cacheStore.put(attempt, "true") }.onFailure { coverPending = false; retryAt = now() + 60000 } }
                finally { queuedCovers.remove(key) }
            }
        }
    }
    fun mediaChanged() = changed("availability")
    private fun changed(collection: String) {
        emit("molly:catalogChanged", JSONObject().put("collection", collection))
        emit("molly:catalogStatus", status())
    }
    fun status(): JSONObject = runCatching {
        val s = store()
        JSONObject().put("supported", !unsupported).put("online", online).put("message", message.ifEmpty { s.get("offlineUploadError").orEmpty() })
            .put("lastSync", s.get("lastSync")?.toLongOrNull() ?: 0).put("catalogComplete", metadataComplete)
            .put("coversComplete", metadataComplete && coversComplete && queuedCovers.isEmpty()).put("paused", paused).put("offlineBlocked", s.get("offlineBlocked") == "true")
    }.getOrElse { JSONObject().put("supported", true).put("online", false) }
    fun read(args: JSONObject): JSONObject {
        if (unsupported) return JSONObject().put("unsupported", true)
        val s = store()
        check(s.get("authorizationDenied") != "true") { "电视授权已失效，请重新绑定" }
        val page = args.optInt("page", 1); val size = args.optInt("pageSize", 24)
        require(page in 1..1000000 && size in 1..48)
        val data = when (args.getString("kind")) {
            "home" -> { preferred = ""; s.readHome(page, size, args.optString("rowId").takeIf { it.isNotEmpty() }) }
            "playlist" -> {
                val id = args.getString("folderId"); require(BridgePolicy.id.matches(id)); preferred = id
                val folders = s.get("manifest")?.let { JSONObject(it).getJSONArray("folders") }
                if (folders != null && (0 until folders.length()).none { folders.getJSONObject(it).getString("id") == id })
                    JSONObject().put("items", JSONArray()).put("itemTotal", 0).put("itemsHasMore", false).put("episodes", JSONArray()).put("total", 0).put("hasMore", false).put("hasProgress", false).put("episodeId", JSONObject.NULL).put("unavailable", true)
                else s.readPlaylist(id, page, size)
            }
            else -> throw IllegalArgumentException("目录类型无效")
        }
        if (data == null) { schedule(0); return JSONObject().put("pending", true).put("offline", !online && message.isNotEmpty()).put("message", message) }
        return JSONObject().put("data", data)
    }
    private fun flushOffline(s: CatalogStore): Boolean {
        val pending = s.pendingEvents()
        pendingUpload = false
        if (pending.length() > 0) {
            try {
                val result = api.json("POST", "/api/tv/offline-events", JSONObject().put("sessions", pending))
                s.acknowledge(result.getJSONArray("acknowledged")); s.remove("offlineUploadError")
                // Force a fresh progress projection after uploaded events.
                s.remove("playbackVersion")
                pendingUpload = s.pendingEvents().length() > 0
                return true
            } catch (error: ApiFailure) {
                if (error.status != 403 && error.status != 409) throw error
                s.put("offlineUploadError", "离线观看记录需要核验，已保留在本机")
            }
        }
        return false
    }
}
