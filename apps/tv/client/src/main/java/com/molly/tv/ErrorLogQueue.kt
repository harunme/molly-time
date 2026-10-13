package com.molly.tv

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** Keep recent device errors across network failures and process restarts. Run on app.io. */
class ErrorLogQueue(context: Context, private val session: SessionStore, private val api: MollyTimeApi) {
    private val file = File(context.filesDir, "error-log-queue.json")
    private var rows = runCatching { JSONArray(file.readText()) }.getOrDefault(JSONArray())

    private fun save() {
        val temp = File(file.parentFile, "error-log-queue.tmp")
        temp.outputStream().use { it.write(rows.toString().toByteArray()); it.flush(); it.fd.sync() }
        check(temp.renameTo(file))
    }

    fun enqueue(body: JSONObject) {
        if (rows.length() >= 100) rows.remove(0)
        rows.put(JSONObject().put("server", session.server).put("device", session.deviceId).put("body", body))
        save()
        flush()
    }

    fun flush() {
        if (session.access.isEmpty() || session.deviceId.isEmpty()) return
        var processed = 0
        while (rows.length() > 0 && processed < 20) {
            val row = rows.getJSONObject(0)
            if (row.optString("server") != session.server || row.optString("device") != session.deviceId) {
                rows.remove(0); save(); continue
            }
            try {
                api.json("POST", "/api/device/error-logs", row.getJSONObject("body"))
            } catch (error: Exception) {
                if (error is ApiFailure && error.status in listOf(400, 404, 409, 422)) {
                    rows.remove(0); save(); processed++; continue
                }
                return
            }
            rows.remove(0); save(); processed++
        }
    }
}
