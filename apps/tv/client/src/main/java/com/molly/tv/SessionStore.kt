package com.molly.tv

import android.content.Context
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.json.JSONObject

class SessionStore(context: Context) {
    // New store intentionally does not inherit the previous client's credentials.
    private val prefs = context.getSharedPreferences("molly.shell.v1", Context.MODE_PRIVATE)
    val server: String get() = prefs.getString("server", "")!!
    val access: String get() = prefs.getString("access", "")!!
    val refresh: String get() = prefs.getString("refresh", "")!!
    val deviceId: String get() = prefs.getString("device", "")!!
    var childId: String
        get() = prefs.getString("child", "")!!
        set(value) { prefs.edit().putString("child", value).commit() }

    fun connect(value: String) {
        val url = value.trim().toHttpUrl()
        require(url.username.isEmpty() && url.password.isEmpty() && url.query == null && url.fragment == null)
        require(url.encodedPath == "/") { "请输入媒体库根地址，不包含路径" }
        require(BuildConfig.DEBUG || url.isHttps) { "正式版连接需要 HTTPS" }
        val normalized = url.toString().trimEnd('/')
        if (normalized != server) {
            prefs.edit().clear().putString("server", normalized).commit()
        }
    }

    fun save(json: JSONObject) {
        val edit = prefs.edit().putString("access", json.getString("accessToken"))
            .putString("refresh", json.getString("refreshToken"))
        val device = json.opt("deviceId")
        if (device is String && device.isNotEmpty()) edit.putString("device", device)
        edit.commit()
    }

    fun clear() { prefs.edit().remove("access").remove("refresh").remove("child").commit() }
}
