package com.molly.tv

import android.content.Context
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject

class SessionStore(context: Context, private val onBindingChanged: () -> Unit = {}) {
    companion object {
        const val DEFAULT_SERVER = "https://mollytime.app"
        private const val LEGACY_SERVER = "https://118.89.122.66:8096"
    }

    // New store intentionally does not inherit the previous client's credentials.
    private val prefs = context.getSharedPreferences("molly.shell.v1", Context.MODE_PRIVATE)
    init {
        // The server moved with its database and signing secret. Preserve the
        // existing device credentials while changing only the saved origin.
        val savedServer = prefs.getString("server", "").orEmpty().trimEnd('/')
        if (savedServer.isEmpty() || savedServer == LEGACY_SERVER) {
            prefs.edit().putString("server", DEFAULT_SERVER).commit()
        } else if (!BuildConfig.DEBUG && savedServer != DEFAULT_SERVER) {
            // Credentials for a custom origin must not be sent to production.
            prefs.edit().putString("server", DEFAULT_SERVER).remove("access")
                .remove("refresh").remove("device").remove("child").commit()
        }
    }
    val server: String get() = prefs.getString("server", "")!!
    val access: String get() = prefs.getString("access", "")!!
    val refresh: String get() = prefs.getString("refresh", "")!!
    val deviceId: String get() = prefs.getString("device", "")!!
    // Retain bridge compatibility while ignoring previously selected profiles.
    val childId: String get() = ""

    data class Credentials(val server: String, val device: String, val access: String)
    @Synchronized fun credentials() = Credentials(server, deviceId, access)

    @Synchronized fun connect(value: String) {
        val url = value.trim().toHttpUrl()
        require(url.username.isEmpty() && url.password.isEmpty() && url.query == null && url.fragment == null)
        require(url.encodedPath == "/") { "请输入媒体库根地址，不包含路径" }
        require(BuildConfig.DEBUG || url.isHttps) { "正式版连接需要 HTTPS" }
        val normalized = url.toString().trimEnd('/')
        require(BuildConfig.DEBUG || normalized == DEFAULT_SERVER) { "正式版使用 MollyTime 官方媒体库" }
        if (normalized != server) {
            val edit = prefs.edit()
            if (server.isNotEmpty() && refresh.isNotEmpty()) {
                val binding = JSONObject().put("access", access).put("refresh", refresh)
                    .put("device", deviceId).put("child", childId)
                edit.putString("binding:$server", binding.toString())
            }
            val saved = runCatching { JSONObject(prefs.getString("binding:$normalized", "{}")!!) }
                .getOrDefault(JSONObject())
            edit.putString("server", normalized).putString("access", saved.optString("access"))
                .putString("refresh", saved.optString("refresh")).putString("device", saved.optString("device"))
                .putString("child", saved.optString("child")).commit()
            onBindingChanged()
        }
    }

    @Synchronized fun save(json: JSONObject, clearChild: Boolean = false) {
        val edit = prefs.edit().putString("access", json.getString("accessToken"))
            .putString("refresh", json.getString("refreshToken"))
        if (clearChild) edit.remove("child")
        val device = json.opt("deviceId")
        if (device is String && device.isNotEmpty()) edit.putString("device", device)
        val previousDevice = deviceId
        edit.commit()
        if (previousDevice != deviceId) onBindingChanged()
    }

    @Synchronized fun clear() { prefs.edit().remove("access").remove("refresh").remove("child")
        .remove("device").remove("binding:$server").commit(); onBindingChanged() }
}
