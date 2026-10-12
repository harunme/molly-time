package com.molly.tv

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Persist before sending. A crash after acknowledgement safely resends the same sequence. */
class WatchQueue(context: Context, private val session: SessionStore, private val api: MollyApi) {
    private val file = File(context.filesDir, "watch-queue.json")
    private var rows = runCatching { JSONArray(file.readText()) }.getOrDefault(JSONArray())
    private fun save() {
        val temp = File(file.parentFile, "watch-queue.tmp")
        temp.outputStream().use { it.write(rows.toString().toByteArray()); it.flush(); it.fd.sync() }
        check(temp.renameTo(file))
    }
    fun enqueue(id: String, event: JSONObject) {
        // Bounded storage. Preserve pending history rather than silently evicting it.
        if (rows.length() >= 5000) { android.util.Log.w("MollyWatch", "Pending watch queue is full"); return }
        rows.put(JSONObject().put("server", session.server).put("device", session.deviceId)
            .put("id", id).put("body", event))
        save()
        flush()
    }
    fun flush() {
        if (session.access.isEmpty()) return
        var processed = 0
        while (rows.length() > 0 && processed < 100) {
            val row = rows.getJSONObject(0)
            // Old identity entries cannot be submitted as a different household/device.
            if (row.getString("server") != session.server || row.optString("device") != session.deviceId) {
                rows.remove(0); save(); continue
            }
            try {
                api.json("POST", "/api/playback/sessions/${row.getString("id")}/events", row.getJSONObject("body"))
            } catch (error: Exception) {
                if (error is ApiFailure && error.status in listOf(404, 422)) {
                    rows.remove(0); save(); processed++; continue
                }
                return
            }
            rows.remove(0); save(); processed++
        }
    }
}
