package com.molly.tv

import android.content.Context
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject

/** One persisted allowance per device binding, shared by online, cached and live players. */
class WatchControl(private val context: Context, private val session: SessionStore, private val api: MollyTimeApi) {
    private var owner = ""
    private var state: JSONObject? = null
    private var prepaidUntil = 0L
    private var running = false
    private fun prefs() = context.getSharedPreferences("watch-control-" + CatalogStore.digest(session.server + "|" + session.deviceId), Context.MODE_PRIVATE)
    @Synchronized private fun load(): JSONObject {
        val binding = session.server + "|" + session.deviceId
        if (owner != binding) {
            owner = binding; prepaidUntil = 0L
            state = prefs().getString("state", null)?.let { JSONObject(it) }
        }
        return state ?: throw IllegalStateException("请先联网读取观看安排")
    }
    private fun persist() { check(prefs().edit().putString("state", state!!.toString()).commit()) { "观看安排保存失败，请联网重试" } }
    private fun settle() {
        val round = state?.optJSONObject("round")
        if (round != null && prepaidUntil > 0) {
            val delta = SystemClock.elapsedRealtime() - prepaidUntil
            round.put("playedMs", (round.optLong("playedMs") + delta).coerceAtLeast(0))
        }
        prepaidUntil = 0L
    }
    @Synchronized fun snapshot(): JSONObject {
        val result = JSONObject(load().toString())
        result.optJSONObject("round")?.let { round ->
            round.put("playedMs", (round.optLong("playedMs") + if (prepaidUntil > 0) SystemClock.elapsedRealtime() - prepaidUntil else 0).coerceAtLeast(0))
            if (round.optString("mode") == "minutes") round.put("remainingMs", (round.optLong("limitMs", round.optLong("amount") * 60000) - round.optLong("playedMs")).coerceAtLeast(0))
        }
        return result
    }
    @Synchronized fun accept(incoming: JSONObject): JSONObject {
        val binding = session.server + "|" + session.deviceId
        if (owner != binding) { owner = binding; state = prefs().getString("state", null)?.let { JSONObject(it) }; prepaidUntil = 0L }
        val previous = state
        if (previous != null && previous.optInt("version") > incoming.optInt("version")) return snapshot()
        settle()
        val next = JSONObject(incoming.toString())
        val oldRound = previous?.optJSONObject("round")
        val round = next.optJSONObject("round")
        if (oldRound != null && round != null && oldRound.optString("id") == round.optString("id")) {
            round.put("playedMs", maxOf(round.optLong("playedMs"), oldRound.optLong("playedMs")))
            round.put("cursor", maxOf(round.optInt("cursor"), oldRound.optInt("cursor")))
            if (oldRound.has("activeEpisode") && oldRound.optInt("activeCursor", -1) == round.optInt("cursor") && (round.isNull("episodeId") || round.optString("episodeId") == oldRound.optString("activeEpisode"))) {
                round.put("activeEpisode", oldRound.getString("activeEpisode"))
                round.put("activeCursor", oldRound.optInt("activeCursor"))
                round.put("playlist", oldRound.optJSONArray("playlist"))
            }
            if (previous.optInt("version") == next.optInt("version") && oldRound.optBoolean("ended")) round.put("ended", true)
        }
        state = next
        normalize()
        if (running) tick(true)
        persist()
        return snapshot()
    }
    private fun normalize() {
        val value = state ?: return
        val round = value.optJSONObject("round") ?: return
        if (round.optString("mode") == "minutes" && round.optLong("playedMs") >= round.optLong("limitMs", round.optLong("amount") * 60000) && prepaidUntil <= SystemClock.elapsedRealtime()) round.put("ended", true)
        val list = round.optJSONArray("playlist")
        if (round.optString("mode") == "episodes" && round.optInt("cursor") >= round.optInt("amount")) round.put("ended", true)
        value.put("status", if (!value.optBoolean("enabled")) "off" else if (round.optBoolean("ended")) "resting" else "allowed")
        if (list != null && round.optInt("cursor") < list.length()) round.put("episodeId", list.getString(round.optInt("cursor")))
        else round.put("episodeId", JSONObject.NULL)
    }
    fun sync(): JSONObject {
        val binding = session.server + "|" + session.deviceId
        val before = runCatching { snapshot() }.getOrNull()
        val round = before?.optJSONObject("round")
        val body = JSONObject().put("supported", true).put("acknowledged", before?.optInt("version") ?: 0)
            .put("roundId", round?.optString("id") ?: JSONObject.NULL).put("playedMs", round?.optLong("playedMs") ?: 0)
            .put("cursor", round?.optInt("cursor") ?: 0).put("episodeId", round?.opt("episodeId") ?: JSONObject.NULL)
        val incoming = try { api.json("POST", "/api/watch-control/sync", body) } catch (error: ApiFailure) {
            if (error.status == 404 && before?.optBoolean("enabled") != true) JSONObject().put("enabled", false).put("supported", false).put("status", "off").put("version", 0)
            else throw error
        }
        check(binding == session.server + "|" + session.deviceId) { "电视绑定已改变" }
        return accept(incoming)
    }
    fun refreshOrCached(): JSONObject = try { sync() } catch (error: Exception) {
        if (error is ApiFailure && error.status in listOf(401, 403)) throw error
        snapshot()
    }
    @Synchronized fun requireEpisode(episode: String, offline: Boolean = false) {
        val value = load()
        if (!value.optBoolean("enabled")) return
        normalize()
        require(value.optString("status") == "allowed") { "看完啦，请家长允许观看" }
        val round = value.getJSONObject("round")
        if (round.optString("mode") == "episodes") {
            val active = round.optString("activeEpisode").takeIf { it.isNotEmpty() && round.optInt("activeCursor", -1) == round.optInt("cursor") }
                ?: round.optString("episodeId").takeIf { it.isNotEmpty() && it != "null" }
            val cursor = round.optInt("cursor") + if (active != null && active != episode) 1 else 0
            require(cursor < round.optInt("amount")) { "本次集数已用完，可继续当前视频，或请家长加看" }
            val previous = round.optJSONArray("playlist") ?: JSONArray()
            val playlist = JSONArray()
            for (index in 0 until cursor) playlist.put(previous.optString(index, ""))
            playlist.put(episode)
            round.put("cursor", cursor).put("playlist", playlist).put("episodeId", episode)
            round.put("activeEpisode", episode).put("activeCursor", cursor)
            persist()
        }
    }
    @Synchronized fun requireLive() {
        val value = load()
        if (!value.optBoolean("enabled")) return
        normalize()
        require(value.optString("status") == "allowed" && value.getJSONObject("round").optString("mode") == "minutes") { "看直播需要家长设置观看时间" }
    }
    /** Prepay at most one second before allowing it to play. Normal pause refunds the unused tail. */
    @Synchronized fun tick(playing: Boolean): Boolean {
        running = playing
        val value = load()
        if (!value.optBoolean("enabled")) return true
        val round = value.optJSONObject("round") ?: return false
        if (!playing) { if (prepaidUntil != 0L) { settle(); normalize(); persist() }; return !round.optBoolean("ended") }
        if (round.optBoolean("ended")) return false
        if (round.optString("mode") != "minutes") return true
        val now = SystemClock.elapsedRealtime()
        if (prepaidUntil > now) return true
        if (prepaidUntil > 0L) settle()
        val left = round.optLong("limitMs", round.optLong("amount") * 60000) - round.optLong("playedMs")
        if (left <= 0) { normalize(); persist(); return false }
        val reserved = minOf(1000L, left)
        round.put("playedMs", round.optLong("playedMs") + reserved)
        prepaidUntil = now + reserved
        persist()
        return true
    }
    @Synchronized fun complete(episode: String) {
        running = false
        settle()
        val value = load()
        val round = value.optJSONObject("round") ?: return
        if (!value.optBoolean("enabled") || round.optString("mode") != "episodes") return
        if (round.optString("activeEpisode") == episode && round.optInt("activeCursor", -1) == round.optInt("cursor")) {
            round.put("cursor", round.optInt("cursor") + 1)
            round.remove("activeEpisode"); round.remove("activeCursor")
        }
        normalize(); persist()
    }
    @Synchronized fun next(): String? {
        val value = load()
        if (!value.optBoolean("enabled")) return null
        normalize()
        val round = value.optJSONObject("round") ?: return null
        return if (value.optString("status") == "allowed" && round.optString("mode") == "episodes" && !round.isNull("episodeId")) round.getString("episodeId") else null
    }
    @Synchronized fun warningPath(episode: String): String? {
        val value = load(); val round = value.optJSONObject("round") ?: return null
        if (!value.optBoolean("enabled") || round.optString("mode") != "episodes") return null
        val cursor = round.optInt("cursor")
        val last = cursor + 1 == round.optInt("amount")
        val path = value.optString("warningPath").takeIf { it.isNotEmpty() && it != "null" } ?: return null
        if (!last || !claim("warning:" + round.optString("id") + ":" + cursor)) return null
        return path
    }
    @Synchronized fun farewellPath(): String? {
        val value = load(); val round = value.optJSONObject("round") ?: return null
        if (!value.optBoolean("enabled") || !round.optBoolean("ended")) return null
        val path = value.optString("farewellPath").takeIf { it.isNotEmpty() && it != "null" } ?: return null
        return if (claim("farewell:" + round.optString("id"))) path else null
    }
    @Synchronized fun notice(): String? {
        val value = snapshot(); val round = value.optJSONObject("round") ?: return null
        if (!value.optBoolean("enabled") || value.optString("status") != "allowed") return null
        val id = round.optString("id")
        if (round.optString("mode") == "minutes") {
            if (round.optLong("remainingMs") <= 300000 && claim("five:$id:" + value.optInt("version"))) { claim("start:$id"); return "还有不到 5 分钟就休息啦。" }
            if (claim("start:$id")) return "这次最多看 " + round.optInt("amount") + " 分钟。"
        } else {
            if (round.optInt("amount") == round.optInt("cursor") + 1 && claim("last:$id:" + round.optInt("cursor"))) { claim("start:$id"); return "这是最后一集啦。" }
            if (claim("start:$id")) return "本集看完后，还能看 " + (round.optInt("amount") - round.optInt("cursor") - 1).coerceAtLeast(0) + " 集。"
        }
        return null
    }
    private fun claim(key: String): Boolean {
        if (prefs().getBoolean(key, false)) return false
        check(prefs().edit().putBoolean(key, true).commit()) { "提醒状态保存失败" }
        return true
    }
    @Synchronized fun managedEpisodes(): Boolean = load().let { it.optBoolean("enabled") && it.optJSONObject("round")?.optString("mode") == "episodes" }
}
