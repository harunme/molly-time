package com.molly.tv

import android.os.SystemClock
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class ApiFailure(val status: Int) : Exception(when (status) {
    401 -> "电视授权已失效，请重新扫码绑定"
    403 -> "没有访问权限"
    404 -> "内容不存在或不可访问"
    else -> "媒体库请求失败（$status）"
})

class MollyTimeApi(private val session: SessionStore, private val deviceName: () -> String) {
    private var pairingCode = ""
    private var pairingServer = ""
    @Volatile var homeSchemaVersion = 1
    val http = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(25, TimeUnit.SECONDS).followRedirects(false).build()
    private val jsonType = "application/json; charset=utf-8".toMediaType()

    @Synchronized fun pairingStart(): JSONObject {
        pairingCancel()
        val server = session.server
        val result = json("POST", "/api/auth/pairing/start", JSONObject().put("name", deviceName()), false)
        require(server == session.server) { "媒体库地址已变化，请重新配对" }
        pairingCode = result.getString("deviceCode")
        pairingServer = server
        result.remove("deviceCode") // The polling secret must never enter the WebView.
        return result
    }

    @Synchronized fun pairingPoll(): JSONObject {
        require(pairingCode.isNotEmpty() && pairingServer == session.server) { "请重新生成配对码" }
        val server = pairingServer
        val result = json("POST", "/api/auth/pairing/poll", JSONObject().put("deviceCode", pairingCode), false)
        require(server == session.server) { "媒体库地址已变化，请重新配对" }
        if (result.optString("status") == "authorized") {
            session.save(result.getJSONObject("auth"), clearChild = true)
            pairingCode = ""
            pairingServer = ""
        }
        result.remove("auth") // Return only pairing status; native storage owns credentials.
        return result
    }

    @Synchronized fun pairingCancel(): JSONObject {
        val code = pairingCode
        val server = pairingServer
        pairingCode = ""
        pairingServer = ""
        if (code.isNotEmpty() && server == session.server) runCatching {
            json("POST", "/api/auth/pairing/cancel", JSONObject().put("deviceCode", code), false)
        }
        return JSONObject().put("ok", true)
    }

    @Synchronized fun pairingReset(): JSONObject {
        try {
            json("POST", "/api/auth/pairing/reset")
        } catch (failure: ApiFailure) {
            if (failure.status != 401) throw failure
            // Already revoked: the old binding cannot authorize anything.
        }
        session.clear()
        pairingCode = ""
        pairingServer = ""
        return JSONObject().put("ok", true)
    }

    // Every response is closed, including errors and a retried 401.
    fun response(method: String, path: String, body: JSONObject? = null,
                 authenticated: Boolean = true): Response = perform(catalogHttp, method, path, body, authenticated)

    private val catalogHttp by lazy { http.newBuilder().callTimeout(10, TimeUnit.SECONDS).build() }
    fun catalogResponse(path: String, register: (okhttp3.Call) -> Unit = {}): Response =
        perform(catalogHttp, "GET", path, null, true, register)

    private fun perform(client: OkHttpClient, method: String, path: String, body: JSONObject?,
                        authenticated: Boolean, register: (okhttp3.Call) -> Unit = {}): Response {
        val credentials = session.credentials()
        val server = credentials.server
        val device = credentials.device
        val token = credentials.access
        fun execute(access: String): Response {
            check(server == session.server && device == session.deviceId) { "电视绑定已变化" }
            val builder = Request.Builder().url(server + path)
                .header("X-Molly-Client", "tv-shell/2").header("X-Molly-Home-Schema", homeSchemaVersion.toString())
            if (session.childId.isNotEmpty()) builder.header("X-Molly-Child", session.childId)
            if (authenticated) builder.header("Authorization", "Bearer $access")
            if (authenticated && path == "/api/me") session.bootId?.let {
                builder.header("X-Molly-Boot-Id", it)
                    .header("X-Molly-Boot-Elapsed-Ms", SystemClock.elapsedRealtime().toString())
            }
            when (method) {
                "GET" -> builder.get()
                "POST" -> builder.post((body ?: JSONObject()).toString().toRequestBody(jsonType))
                "PUT" -> builder.put((body ?: JSONObject()).toString().toRequestBody(jsonType))
                else -> throw IllegalArgumentException("不支持的请求方法：$method")
            }
            val call = client.newCall(builder.build())
            register(call)
            return call.execute()
        }
        var res = execute(token)
        if (authenticated && res.code == 401 && session.refresh.isNotEmpty()) {
            res.close()
            // Only rotation is serialized; ordinary reads never hold this lock.
            synchronized(session) {
                check(server == session.server && device == session.deviceId) { "电视绑定已变化" }
                if (session.access == token) {
                    try { session.save(json("POST", "/api/auth/refresh", JSONObject().put("refreshToken", session.refresh), false)) }
                    catch (error: ApiFailure) { if (error.status == 401) session.clear(); throw error }
                }
            }
            res = execute(session.access)
        }
        if (server != session.server || device != session.deviceId) { res.close(); throw IllegalStateException("电视绑定已变化") }
        if (!res.isSuccessful) { val code = res.code; res.close(); throw ApiFailure(code) }
        return res
    }

    fun text(method: String, path: String, body: JSONObject? = null): String =
        response(method, path, body).use { it.body!!.string() }

    /** Covers must not hold the API/refresh lock while waiting on the network.
     * A 401 still goes through the existing serialized refresh path. */
    fun imageResponse(path: String): Response {
        val credentials = session.credentials()
        val server = credentials.server
        val device = credentials.device
        val access = credentials.access
        val result = http.newCall(Request.Builder().url(server + path)
            .header("Authorization", "Bearer $access")
            .header("X-Molly-Client", "tv-shell/2").build()).execute()
        if (server != session.server || device != session.deviceId) {
            result.close()
            throw IllegalStateException("电视绑定已变化")
        }
        if (result.code == 401) {
            result.close()
            return response("GET", path)
        }
        if (!result.isSuccessful) {
            val code = result.code
            result.close()
            throw ApiFailure(code)
        }
        return result
    }

    fun json(method: String, path: String, body: JSONObject? = null,
             authenticated: Boolean = true): JSONObject =
        response(method, path, body, authenticated).use { JSONObject(it.body!!.string()) }

    fun progressPath(id: String, child: String) = "/api/episodes/$id/progress" +
        if (child.isEmpty()) "" else "?childId=$child"

    fun report(id: String, child: String, position: Long, duration: Long,
               event: String, completed: Boolean) {
        val body = JSONObject().put("positionMs", position.coerceAtLeast(0))
            .put("durationMs", duration.coerceAtLeast(0)).put("event", event)
            .put("completed", completed)
        if (child.isNotEmpty()) body.put("childId", child)
        json("POST", "/api/episodes/$id/progress", body)
    }
}
