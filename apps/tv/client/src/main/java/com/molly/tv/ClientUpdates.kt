package com.molly.tv

import android.content.Context
import android.os.Build
import okhttp3.Call
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

class ClientUpdates(private val context: Context) {
    // APK downloads must not block token refresh, playback or watch-event delivery.
    val executor = Executors.newSingleThreadExecutor()
    private val http = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS).callTimeout(10, TimeUnit.MINUTES)
        .followRedirects(false).followSslRedirects(false).build()
    private val directory get() = File(context.filesDir, "client-updates").apply { mkdirs() }

    data class Release(val packageName: String, val versionCode: Long, val versionName: String,
                       val minSdk: Int, val size: Long, val sha256: String, val notes: String, val url: String) {
        fun json() = JSONObject().put("packageName", packageName).put("versionCode", versionCode)
            .put("versionName", versionName).put("minSdk", minSdk).put("size", size)
            .put("sha256", sha256).put("notes", notes).put("url", url)
        companion object {
            fun parse(value: JSONObject) = Release(value.getString("packageName"), value.getLong("versionCode"),
                value.getString("versionName"), value.getInt("minSdk"), value.getLong("size"),
                value.getString("sha256"), value.optString("notes").take(4000), value.getString("url"))
        }
    }

    class Operation {
        val canceled = AtomicBoolean(false)
        @Volatile var call: Call? = null
        fun cancel() { canceled.set(true); call?.cancel() }
        fun ensureActive() { check(!canceled.get()) { "更新已取消" } }
    }

    fun check(server: String): Release? {
        val base = server.toHttpUrl()
        require(BuildConfig.DEBUG || base.isHttps) { "更新检查需要 HTTPS" }
        val endpoint = base.newBuilder().encodedPath("/api/client/releases/latest")
            .addQueryParameter("packageName", context.packageName).build()
        return http.newCall(Request.Builder().url(endpoint).build()).execute().use { response ->
            if (response.code == 404) return null // Older backends have no update API.
            require(response.isSuccessful) { "检查更新失败（${response.code}）" }
            val body = response.body ?: throw IllegalArgumentException("更新信息为空")
            require(body.contentLength() <= 32768) { "更新信息过大" }
            val bytes = body.byteStream().use { it.readBytesBounded(32768) }
            val value = JSONObject(String(bytes, Charsets.UTF_8)).optJSONObject("release") ?: return null
            val release = Release.parse(value)
            require(release.packageName == context.packageName) { "更新包不属于当前客户端" }
            if (release.versionCode <= BuildConfig.VERSION_CODE) return null
            validate(release)
            val url = base.resolve(release.url) ?: throw IllegalArgumentException("更新下载地址无效")
            require(url.username.isEmpty() && url.password.isEmpty() && url.fragment == null) { "更新下载地址无效" }
            require(url.isHttps || (BuildConfig.DEBUG && url.scheme == base.scheme && url.host == base.host && url.port == base.port)) {
                "更新下载需要 HTTPS"
            }
            release.copy(url = url.toString())
        }
    }

    private fun java.io.InputStream.readBytesBounded(limit: Int): ByteArray {
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (true) {
            val count = read(buffer)
            if (count < 0) break
            require(output.size() + count <= limit) { "更新信息过大" }
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    private fun validate(release: Release) = UpdatePolicy.validate(release.packageName, release.versionCode,
        release.minSdk, release.size, release.sha256, context.packageName, BuildConfig.VERSION_CODE.toLong(), Build.VERSION.SDK_INT)

    fun download(release: Release, operation: Operation, progress: (Long) -> Unit): File {
        validate(release)
        operation.ensureActive()
        val target = File(directory, "${release.sha256}.apk")
        if (target.isFile && runCatching { verify(target, release) }.isSuccess) return target
        directory.listFiles()?.forEach { it.delete() }
        require(directory.usableSpace > release.size * 2 + 64 * 1024 * 1024) { "电视存储空间不足，请清理后重试" }
        val partial = File(directory, "${release.sha256}.part")
        try {
            // No Molly credentials are ever attached to external APK requests.
            val call = http.newCall(Request.Builder().url(release.url).build())
            operation.call = call
            operation.ensureActive()
            call.execute().use { response ->
                require(response.isSuccessful) { "下载更新失败（${response.code}），请重新检查更新" }
                val body = response.body ?: throw IllegalArgumentException("更新包为空")
                require(body.contentLength() == -1L || body.contentLength() == release.size) { "更新包大小不一致" }
                var received = 0L
                body.byteStream().use { input -> partial.outputStream().use { output ->
                    val buffer = ByteArray(128 * 1024)
                    while (true) {
                        operation.ensureActive()
                        val count = input.read(buffer)
                        if (count < 0) break
                        received += count
                        require(received <= release.size) { "更新包超出声明大小" }
                        output.write(buffer, 0, count)
                        progress(received)
                    }
                } }
                require(received == release.size) { "更新包下载不完整，请重试" }
            }
            operation.ensureActive()
            verify(partial, release)
            require(partial.renameTo(target)) { "更新包保存失败" }
            return target
        } finally {
            operation.call = null
            partial.delete()
        }
    }

    fun verify(file: File, release: Release) {
        validate(release)
        require(file.isFile && file.length() == release.size) { "更新包大小不一致" }
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(128 * 1024)
            while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) }
        }
        require(hex(digest.digest()) == release.sha256) { "更新包校验失败，请重新下载" }
        // Publication checks APK identity and signing with apksigner/aapt. On the TV,
        // PackageInstaller is the authority for package, version, SDK and signature
        // compatibility. Some TVs return incorrect metadata for uninstalled archives.
    }

    private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
}
