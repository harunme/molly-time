package com.molly.tv

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest

/** One database per binding. Staging rows are never mixed with the last complete version. */
class CatalogStore(private val context: Context, val owner: String) : SQLiteOpenHelper(context,
    "catalog-${digest(owner)}.sqlite", null, 1) {
    companion object {
        const val BUDGET = 128L * 1024 * 1024
        fun digest(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it.toInt() and 255) }
    }
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execSQL("CREATE TABLE collections (id TEXT PRIMARY KEY, active TEXT, pending TEXT, next_page INTEGER NOT NULL DEFAULT 1, complete INTEGER NOT NULL DEFAULT 0, info TEXT NOT NULL DEFAULT '{}')")
        db.execSQL("CREATE TABLE items (collection TEXT NOT NULL, version TEXT NOT NULL, ordinal INTEGER NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(collection,version,ordinal), UNIQUE(collection,version,id))")
        db.execSQL("CREATE INDEX item_ids ON items(id)")
        db.execSQL("CREATE TABLE watch_state (id TEXT PRIMARY KEY, started INTEGER NOT NULL, payload TEXT NOT NULL)")
        db.execSQL("CREATE TABLE offline_sessions (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
        db.execSQL("CREATE TABLE offline_events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(session_id,seq))")
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
    fun get(key: String): String? = readableDatabase.rawQuery("SELECT value FROM meta WHERE key=?", arrayOf(key)).use { if (it.moveToFirst()) it.getString(0) else null }
    fun put(key: String, value: String) { writableDatabase.insertWithOnConflict("meta", null, ContentValues().apply { put("key", key); put("value", value) }, SQLiteDatabase.CONFLICT_REPLACE) }
    fun remove(key: String) { writableDatabase.delete("meta", "key=?", arrayOf(key)) }
    fun info(id: String): JSONObject? = readableDatabase.rawQuery("SELECT active,pending,next_page,complete,info FROM collections WHERE id=?", arrayOf(id)).use {
        if (!it.moveToFirst()) null else JSONObject(it.getString(4)).put("active", it.getString(0)).put("pending", it.getString(1)).put("nextPage", it.getInt(2)).put("complete", it.getInt(3) == 1)
    }
    fun needs(id: String, version: String) = info(id)?.let { it.optString("active") != version || !it.optBoolean("complete") } ?: true
    fun nextPage(id: String, version: String): Int = info(id)?.let { if (it.optString("pending") == version) it.optInt("nextPage", 1) else 1 } ?: 1
    fun accept(id: String, version: String, page: Int, rows: JSONArray, more: Boolean, details: JSONObject) {
        val metadata = JSONObject(details.toString()).apply { remove("items"); remove("episodes") }
        val db = writableDatabase
        check(context.filesDir.usableSpace >= 1024L * 1024 * 1024) { "目录缓存空间不足" }
        require(db.maximumSize >= BUDGET)
        if (db.pageSize * android.database.DatabaseUtils.longForQuery(db, "PRAGMA page_count", null) > BUDGET) throw IllegalStateException("目录缓存空间不足")
        db.beginTransaction()
        try {
            val old = info(id)
            if (old?.optString("pending") != version || page == 1) {
                if (id.startsWith("home:")) {
                    val visible = get("home")?.let { JSONObject(it).optString("version") }.orEmpty()
                    db.delete("items", "collection=? AND version NOT IN (?,?)", arrayOf(id, visible, version))
                }
                if (!id.startsWith("home:")) db.delete("items", "collection=? AND version!=?", arrayOf(id, old?.optString("active") ?: ""))
                db.delete("items", "collection=? AND version=?", arrayOf(id, version))
            }
            var ordinal = if (page == 1) 0 else android.database.DatabaseUtils.longForQuery(db,
                "SELECT COUNT(*) FROM items WHERE collection=? AND version=?", arrayOf(id, version)).toInt()
            for (i in 0 until rows.length()) {
                val row = rows.getJSONObject(i)
                db.insertOrThrow("items", null, ContentValues().apply {
                    put("collection", id); put("version", version); put("ordinal", ordinal++); put("id", row.getString("id")); put("payload", row.toString())
                })
            }
            check(db.pageSize * android.database.DatabaseUtils.longForQuery(db, "PRAGMA page_count", null) <= BUDGET) { "目录缓存空间不足" }
            if (!more && ordinal != details.optInt("total", ordinal)) throw IllegalStateException("目录分页数量不一致")
            val active = if (!more) version else old?.optString("active")?.takeIf { it.isNotEmpty() }
            db.insertWithOnConflict("collections", null, ContentValues().apply {
                put("id", id); put("active", active); put("pending", version); put("next_page", page + 1); put("complete", if (more) 0 else 1); put("info", if (more && !old?.optString("active").isNullOrEmpty()) JSONObject(old.toString()).put("pendingTotal", details.optInt("total")).toString() else metadata.toString())
            }, SQLiteDatabase.CONFLICT_REPLACE)
            if (!more && !id.startsWith("home:")) db.delete("items", "collection=? AND version!=?", arrayOf(id, version))
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }
    fun publishHome(definition: String, version: String) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            put("home", definition); put("homeVersion", version)
            db.delete("items", "collection LIKE 'home:%' AND version!=?", arrayOf(version))
            val ids = JSONObject(definition).getJSONArray("rows")
            val keep = (0 until ids.length()).map { "home:" + ids.getJSONObject(it).getString("id") }.toSet()
            val obsolete = db.rawQuery("SELECT id FROM collections WHERE id LIKE 'home:%'", null).use { c -> buildList { while (c.moveToNext()) if (c.getString(0) !in keep) add(c.getString(0)) } }
            for (id in obsolete) { db.delete("collections", "id=?", arrayOf(id)); db.delete("items", "collection=?", arrayOf(id)) }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }
    fun resetStaging(id: String) {
        val current = info(id) ?: return
        writableDatabase.delete("items", "collection=? AND version!=?", arrayOf(id, current.optString("active")))
        writableDatabase.execSQL("UPDATE collections SET pending=NULL,next_page=1 WHERE id=?", arrayOf(id))
    }
    fun prune(manifest: JSONObject) {
        val ids = (0 until manifest.getJSONArray("folders").length()).map { "folder:" + manifest.getJSONArray("folders").getJSONObject(it).getString("id") }.toSet()
        val removed = readableDatabase.rawQuery("SELECT id FROM collections WHERE id LIKE 'folder:%'", null).use { cursor -> buildList { while (cursor.moveToNext()) if (cursor.getString(0) !in ids) add(cursor.getString(0)) } }
        writableDatabase.beginTransaction()
        try { for (id in removed) { writableDatabase.delete("collections", "id=?", arrayOf(id)); writableDatabase.delete("items", "collection=?", arrayOf(id)) }; put("manifest", manifest.toString()); writableDatabase.setTransactionSuccessful() }
        finally { writableDatabase.endTransaction() }
    }
    fun rows(id: String, offset: Int, limit: Int, atVersion: String? = null): JSONArray? {
        val state = info(id) ?: return null
        val version = atVersion ?: state.optString("active").ifEmpty { state.optString("pending") }
        if (version.isEmpty()) return null
        val count = android.database.DatabaseUtils.longForQuery(readableDatabase,
            "SELECT COUNT(*) FROM items WHERE collection=? AND version=?", arrayOf(id, version))
        if (version == state.optString("pending") && !state.optBoolean("complete") && offset >= count) return null
        return readableDatabase.rawQuery("SELECT payload FROM items WHERE collection=? AND version=? ORDER BY ordinal LIMIT ? OFFSET ?", arrayOf(id, version, limit.toString(), offset.toString())).use {
            JSONArray().apply { while (it.moveToNext()) put(JSONObject(it.getString(0))) }
        }
    }
    fun progress(): JSONObject = JSONObject(get("progress") ?: "{\"progress\":[],\"recent\":{\"rows\":[]}}")
    fun overlay(item: JSONObject): JSONObject {
        val id = item.optString("id")
        val local = get("local:$id")?.let { JSONObject(it) }
        val remote = readableDatabase.rawQuery("SELECT payload FROM watch_state WHERE id=?", arrayOf(id)).use { if (it.moveToFirst()) JSONObject(it.getString(0)) else null }
        val value = local ?: remote
        if (value != null) { item.put("positionMs", value.optLong("positionMs")).put("completed", value.optBoolean("completed")) }
        return item
    }
    fun recordPosition(id: String, position: Long, completed: Boolean, sessionId: String = "", seq: Int = -1, startedAt: Long = 0) {
        put("local:$id", JSONObject().put("episodeId", id).put("positionMs", position).put("completed", completed).put("updatedAt", System.currentTimeMillis()).put("sessionId", sessionId).put("seq", seq).put("startedAt", startedAt).toString())
    }
    private inline fun <T> readSnapshot(block: () -> T): T {
        val db = readableDatabase
        db.beginTransactionNonExclusive()
        try { val result = block(); db.setTransactionSuccessful(); return result }
        finally { db.endTransaction() }
    }
    fun readHome(page: Int, size: Int, rowId: String?): JSONObject? {
        return readSnapshot {
            val definition = get("home")?.let { JSONObject(it) } ?: return@readSnapshot null
            val manifest = get("manifest")?.let { JSONObject(it) }
            val allowed = manifest?.getJSONArray("folders")?.let { a -> (0 until a.length()).map { a.getJSONObject(it).getString("id") }.toSet() }
            val result = JSONArray()
            if (rowId == null || rowId == "recently-played") {
                val serverRecent = progress().optJSONObject("recent")?.optJSONArray("rows")?.optJSONObject(0)?.optJSONArray("items") ?: JSONArray()
                val recent = JSONArray(); val seen = mutableSetOf<String>()
                val local = readableDatabase.rawQuery("SELECT value FROM meta WHERE key LIKE 'local:%'", null).use { c -> buildList { while (c.moveToNext()) add(JSONObject(c.getString(0))) } }.sortedByDescending { it.optLong("updatedAt") }
                for (entry in local) {
                    val id = entry.getString("episodeId")
                    val item = readableDatabase.rawQuery("SELECT i.payload FROM items i JOIN collections c ON c.id=i.collection WHERE i.id=? AND i.collection LIKE 'folder:%' AND i.version=COALESCE(c.active,c.pending) LIMIT 1", arrayOf(id)).use { if (it.moveToFirst()) JSONObject(it.getString(0)) else null }
                    if (item != null && seen.add(id) && recent.length() < 10) recent.put(item.put("type", "episode"))
                }
                for (i in 0 until serverRecent.length()) { val item = serverRecent.getJSONObject(i); if (seen.add(item.getString("id")) && recent.length() < 10) recent.put(item) }
                if (recent.length() > 0) result.put(JSONObject().put("id", "recently-played").put("title", "最近播放").put("items", JSONArray().apply { for (i in 0 until recent.length()) put(overlay(recent.getJSONObject(i))) }).put("hasMore", false))
            }
            val defs = definition.getJSONArray("rows")
            for (i in 0 until defs.length()) {
                val def = defs.getJSONObject(i); val id = def.getString("id")
                if (rowId != null && rowId != id) continue
                val values = rows("home:$id", (page - 1) * size, size, definition.optString("version").takeIf { it.isNotEmpty() }) ?: return@readSnapshot null
                val filtered = JSONArray()
                for (j in 0 until values.length()) { val item = values.getJSONObject(j); if (allowed == null || item.getString("id") in allowed) filtered.put(item) }
                val state = def
                result.put(JSONObject(def.toString()).put("items", filtered).put("page", page).put("pageSize", size)
                    .put("hasMore", page * size < state.optInt("total")).put("total", state.optInt("total")))
            }
            return@readSnapshot JSONObject().put("rows", result)
        }
    }
    fun readPlaylist(id: String, page: Int, size: Int): JSONObject? {
        return readSnapshot {
            val collection = "folder:$id"
            val values = rows(collection, (page - 1) * size, size) ?: return@readSnapshot null
            for (i in 0 until values.length()) overlay(values.getJSONObject(i))
            val state = info(collection)!!
            // Resume is independent of static ordering and may be on a later local page.
            val stateVersion = state.optString("active").ifEmpty { state.optString("pending") }
            var resume: JSONObject? = readableDatabase.rawQuery("""
                SELECT i.payload FROM items i JOIN watch_state p ON p.id=i.id
                WHERE i.collection=? AND i.version=? ORDER BY p.started DESC,p.id DESC LIMIT 1
            """.trimIndent(), arrayOf(collection, stateVersion)).use { if (it.moveToFirst()) overlay(JSONObject(it.getString(0))) else null }
            val locals = readableDatabase.rawQuery("SELECT value FROM meta WHERE key LIKE 'local:%'", null).use { cursor -> buildList { while (cursor.moveToNext()) add(JSONObject(cursor.getString(0))) } }
            for (p in locals.sortedBy { it.optLong("updatedAt") }) { find(collection, p.optString("episodeId"))?.let { resume = overlay(it) } }
            val current = resume
            if (current?.optBoolean("completed") == true) {
                nextEpisode(current.getString("id"))?.let { next -> find(collection, next)?.let { resume = overlay(it) } }
            }
            val first = rows(collection, 0, 1)?.optJSONObject(0)
            return@readSnapshot JSONObject().put("episodes", values).put("total", state.optInt("total")).put("page", page).put("pageSize", size)
                .put("hasMore", page * size < state.optInt("total")).put("hasProgress", resume != null)
                .put("episodeId", resume?.optString("id") ?: first?.optString("id") ?: JSONObject.NULL).put("resumeEpisode", resume ?: JSONObject.NULL)
        }
    }
    fun find(collection: String, id: String): JSONObject? {
        val state = info(collection) ?: return null
        val version = state.optString("active").ifEmpty { state.optString("pending") }
        return readableDatabase.rawQuery("SELECT payload FROM items WHERE collection=? AND version=? AND id=?", arrayOf(collection, version, id)).use { if (it.moveToFirst()) JSONObject(it.getString(0)) else null }
    }
    fun cachedImages(): List<JSONObject> = readableDatabase.rawQuery("SELECT DISTINCT payload FROM items", null).use { cursor -> buildList { while (cursor.moveToNext()) JSONObject(cursor.getString(0)).optJSONObject("image")?.let { add(it) } } }
    fun nextEpisode(id: String): String? = readableDatabase.rawQuery("""
        SELECT n.id FROM items i JOIN collections c ON i.collection=c.id
        JOIN items n ON n.collection=i.collection AND n.version=i.version AND n.ordinal=i.ordinal+1
        WHERE i.id=? AND i.collection LIKE 'folder:%' AND i.version=COALESCE(c.active,c.pending) LIMIT 1
    """.trimIndent(), arrayOf(id)).use { if (it.moveToFirst()) it.getString(0) else null }
    fun session(id: String, data: JSONObject) { writableDatabase.insertWithOnConflict("offline_sessions", null, ContentValues().apply { put("id", id); put("payload", data.toString()) }, SQLiteDatabase.CONFLICT_IGNORE) }
    fun enqueue(id: String, event: JSONObject) {
        if (get("offlineClosed:$id") == "true") return
        val session = readableDatabase.rawQuery("SELECT payload FROM offline_sessions WHERE id=?", arrayOf(id)).use { if (it.moveToFirst()) JSONObject(it.getString(0)) else null }
        if (session?.has("expiresAt") == true) {
            val maximum = (session.getLong("expiresAt") - session.getLong("startedAt")).coerceAtLeast(0)
            if (event.optLong("endMs") > maximum) {
                val start = event.optLong("startMs").coerceAtMost(maximum)
                event.put("startMs", start).put("endMs", maximum).put("playedMs", if (event.optLong("playedMs") > 0) maximum - start else 0).put("stopped", true)
            }
        }
        check(android.database.DatabaseUtils.longForQuery(readableDatabase, "SELECT COUNT(*) FROM offline_events", null) < 5000) { "离线观看记录队列已满，请联网同步" }
        writableDatabase.insertWithOnConflict("offline_events", null, ContentValues().apply { put("session_id", id); put("seq", event.getInt("seq")); put("payload", event.toString()) }, SQLiteDatabase.CONFLICT_IGNORE)
        if (event.optBoolean("stopped")) put("offlineClosed:$id", "true")
    }
    fun hasPendingEvents() = android.database.DatabaseUtils.longForQuery(readableDatabase, "SELECT EXISTS(SELECT 1 FROM offline_events)", null) != 0L
    fun pendingEvents(): JSONArray = readableDatabase.rawQuery("SELECT DISTINCT s.id,s.payload FROM offline_sessions s JOIN offline_events e ON s.id=e.session_id LIMIT 20", null).use { c -> JSONArray().apply {
        while (c.moveToNext()) {
            val id = c.getString(0); val data = JSONObject(c.getString(1)); val events = JSONArray()
            readableDatabase.rawQuery("SELECT payload FROM offline_events WHERE session_id=? ORDER BY seq LIMIT 100", arrayOf(id)).use { e -> while (e.moveToNext()) events.put(JSONObject(e.getString(0))) }
            put(data.put("events", events))
        }
    } }
    fun acknowledge(rows: JSONArray) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val ids = mutableSetOf<String>()
            for (i in 0 until rows.length()) {
                val row = rows.getJSONObject(i); val id = row.getString("id"); ids.add(id)
                db.delete("offline_events", "session_id=? AND seq=?", arrayOf(id, row.getInt("seq").toString()))
            }
            for (id in ids) if (get("offlineClosed:$id") == "true" && android.database.DatabaseUtils.longForQuery(db, "SELECT COUNT(*) FROM offline_events WHERE session_id=?", arrayOf(id)) == 0L) {
                db.delete("offline_sessions", "id=?", arrayOf(id)); remove("offlineClosed:$id")
            }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }
    fun acceptProgress(value: JSONObject) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val pending = db.rawQuery("SELECT DISTINCT s.payload FROM offline_sessions s JOIN offline_events e ON e.session_id=s.id", null).use { c -> buildSet { while (c.moveToNext()) add(JSONObject(c.getString(0)).getString("episodeId")) } }
            val entries = value.optJSONArray("progress") ?: JSONArray()
            db.delete("watch_state", null, null)
            val latest = (0 until entries.length()).map { entries.getJSONObject(it) }.groupBy { it.getString("episodeId") }.mapValues { (_, values) -> values.maxBy { it.optLong("startedAt") } }
            for ((id, entry) in latest) {
                db.insertOrThrow("watch_state", null, ContentValues().apply { put("id", id); put("started", entry.optLong("startedAt")); put("payload", entry.toString()) })
                val local = get("local:$id")?.let { JSONObject(it) }
                val acknowledged = local == null || local.optString("sessionId").isEmpty() ||
                    entry.optString("sessionId") == local.optString("sessionId") && entry.optInt("seq", -1) >= local.optInt("seq") ||
                    entry.optLong("startedAt") > local.optLong("startedAt")
                if (id !in pending && acknowledged) remove("local:$id")
            }
            put("progress", value.toString()); put("playbackVersion", value.getString("version"))
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }
    fun requireEventCapacity() { check(android.database.DatabaseUtils.longForQuery(readableDatabase, "SELECT COUNT(*) FROM offline_events", null) < 4900) { "离线观看记录队列已满，请联网同步" } }
    fun savedPlayback(id: String): JSONObject? = get("media:$id")?.let { JSONObject(it) }
    fun removePlayback(id: String) = remove("media:$id")
}
