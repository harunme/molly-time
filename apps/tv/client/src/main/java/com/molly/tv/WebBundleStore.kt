package com.molly.tv

import android.content.Context
import android.webkit.MimeTypeMap
import androidx.webkit.WebViewAssetLoader
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.zip.ZipInputStream

/** Versioned, per-server TV web bundles. The APK assets are the permanent offline baseline. */
class WebBundleStore(context: Context) {
    data class Release(val version: String, val minBridge: Int, val maxBridge: Int, val size: Long, val sha256: String)

    private val root = File(context.filesDir, "tv-web").apply { mkdirs() }
    private val assets = context.assets
    private val http = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS).callTimeout(3, TimeUnit.MINUTES)
        .followRedirects(false).followSslRedirects(false).build()
    private var selectedDirectory: File? = null
    private var loadedVersion: String? = null

    private fun bundledVersion(): String? = runCatching {
        JSONObject(assets.open("web-release.json").bufferedReader().use { it.readText() }).getString("webVersion")
    }.getOrNull()
    fun selectedVersion(): String? = loadedVersion ?: bundledVersion()

    fun selectForLaunch(server: String): String? {
        selectedDirectory = null
        loadedVersion = null
        if (server.isBlank()) return bundledVersion()
        val directory = serverDirectory(server)
        val pending = File(directory, "pending")
        val candidate = pending.takeIf { it.isFile }?.readText()?.trim()
        val active = File(directory, "active").takeIf { it.isFile }?.readText()?.trim()
        val selected = listOfNotNull(candidate, active).firstOrNull { version ->
            VERSION.matches(version) && File(directory, "versions/$version").let { folder ->
                File(folder, "index.html").isFile && compatible(File(folder, "web-release.json"), BRIDGE_VERSION)
            }
        }
        if (candidate != null && selected != candidate) pending.delete()
        if (selected != null) selectedDirectory = File(directory, "versions/$selected")
        loadedVersion = selectedDirectory?.name ?: bundledVersion()
        return loadedVersion
    }

    fun pathHandler() = object : WebViewAssetLoader.PathHandler {
        override fun handle(path: String): android.webkit.WebResourceResponse? {
            val normalized = WebBundlePolicy.safeRelative(path) ?: return null
            val directory = selectedDirectory ?: return openPackaged(normalized)
            val file = File(directory, normalized).takeIf { it.isFile } ?: return null
            return response(FileInputStream(file), normalized)
        }
    }

    private fun openPackaged(path: String) = runCatching {
        response(assets.open(path), path)
    }.getOrNull()

    private fun response(input: InputStream, path: String) = runCatching {
        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(path.substringAfterLast('.', "").lowercase())
            ?: "application/octet-stream"
        val headers = if (path == "index.html") mapOf("Content-Security-Policy" to
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: https://*.aliyuncs.com; connect-src 'self'; media-src 'self' https:; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'") else emptyMap()
        android.webkit.WebResourceResponse(mime, if (mime.startsWith("text/") || mime.contains("javascript") || mime.contains("json")) "utf-8" else null,
            200, "OK", headers, input)
    }.getOrNull()

    fun confirmLoaded(server: String, version: String?) {
        if (server.isBlank()) return
        val directory = serverDirectory(server)
        val pending = File(directory, "pending")
        val candidate = pending.takeIf { it.isFile }?.readText()?.trim()
        if (candidate != null && candidate == version && selectedDirectory?.name == candidate) {
            atomicText(File(directory, "active"), candidate)
            pending.delete()
            prune(directory, candidate)
        }
        loadedVersion = version
    }

    fun rollback(server: String) {
        if (server.isBlank()) { selectedDirectory = null; return }
        val directory = serverDirectory(server)
        File(directory, "pending").delete()
        val active = File(directory, "active").takeIf { it.isFile }?.readText()?.trim()
        selectedDirectory = active?.let { File(directory, "versions/$it") }?.takeIf { File(it, "index.html").isFile }
        loadedVersion = selectedDirectory?.name ?: bundledVersion()
    }

    fun checkAndStage(server: String, bridgeVersion: Int, progress: (Long, Long) -> Unit = { _, _ -> }): String? {
        require(server.isNotBlank()) { "请先连接媒体库" }
        val base = server.trimEnd('/')
        val manifestUrl = "$base/tv/web-release.json"
        val manifestBytes = http.newCall(Request.Builder().url(manifestUrl).build()).execute().use { response ->
            require(response.isSuccessful) { "检查网页更新失败（${response.code}）" }
            val body = response.body ?: throw IllegalArgumentException("网页更新信息为空")
            require(body.contentLength() in 0..32768) { "网页更新信息过大" }
            body.byteStream().use { readBounded(it, 32768) }
        }
        val json = JSONObject(String(manifestBytes, Charsets.UTF_8))
        val release = Release(json.getString("webVersion"), json.getInt("minBridgeVersion"),
            json.getInt("maxBridgeVersion"), json.getLong("size"), json.getString("sha256"))
        require(VERSION.matches(release.version) && release.sha256.matches(HEX) && release.size in 1..MAX_BUNDLE_BYTES) {
            "网页更新清单无效"
        }
        require(WebBundlePolicy.bridgeCompatible(bridgeVersion, release.minBridge, release.maxBridge)) {
            "网页版本需要更新电视客户端"
        }
        if (release.version == selectedVersion()) return release.version
        val directory = serverDirectory(server)
        val installed = listOf("active", "pending").mapNotNull { name ->
            File(directory, name).takeIf { it.isFile }?.readText()?.trim()
        }.toSet()
        if (release.version == selectedVersion()) return null
        if (release.version in installed && File(directory, "versions/${release.version}/index.html").isFile) {
            return release.version.takeIf { File(directory, "pending").takeIf(File::isFile)?.readText()?.trim() == it }
        }

        val partial = File(directory, "${release.version}.part")
        val archive = File(directory, "${release.version}.zip")
        val url = "$base/tv/web-bundle.zip"
        try {
            http.newCall(Request.Builder().url(url).build()).execute().use { response ->
                require(response.isSuccessful) { "下载网页更新失败（${response.code}）" }
                val body = response.body ?: throw IllegalArgumentException("网页更新包为空")
                require(body.contentLength() == -1L || body.contentLength() == release.size) { "网页更新包大小不一致" }
                body.byteStream().use { input -> partial.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        require(total <= release.size) { "网页更新包超出声明大小" }
                        output.write(buffer, 0, count)
                        progress(total, release.size)
                    }
                    require(total == release.size) { "网页更新包下载不完整" }
                } }
            }
            require(sha256(partial) == release.sha256) { "网页更新包校验失败" }
            check(partial.renameTo(archive)) { "网页更新包保存失败" }
            val versionDirectory = File(directory, "versions/${release.version}")
            val temporary = File(directory, "versions/.${release.version}.tmp")
            temporary.deleteRecursively()
            extract(archive, temporary)
            require(File(temporary, "index.html").isFile) { "网页更新包缺少入口文件" }
            File(temporary, "web-release.json").writeText(json.toString())
            check(versionDirectory.deleteRecursively() || !versionDirectory.exists()) { "无法替换网页版本" }
            check(temporary.renameTo(versionDirectory)) { "网页版本保存失败" }
            atomicText(File(directory, "pending"), release.version)
            prune(directory, null)
            return release.version
        } finally {
            partial.delete()
            archive.delete()
        }
    }

    private fun extract(archive: File, destination: File) {
        destination.mkdirs()
        var count = 0
        var total = 0L
        ZipInputStream(archive.inputStream().buffered()).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                val relative = WebBundlePolicy.safeRelative(entry.name) ?: throw IllegalArgumentException("网页更新包路径无效")
                count++
                require(count <= MAX_FILES) { "网页更新包文件过多" }
                val target = File(destination, relative)
                val destinationPath = destination.canonicalPath.trimEnd(File.separatorChar) + File.separator
                require(target.canonicalPath.startsWith(destinationPath)) { "网页更新包路径越界" }
                if (entry.isDirectory) target.mkdirs() else {
                    target.parentFile?.mkdirs()
                    target.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val n = zip.read(buffer)
                            if (n < 0) break
                            total += n
                            require(total <= MAX_UNPACKED_BYTES) { "网页更新包解压后过大" }
                            output.write(buffer, 0, n)
                        }
                    }
                }
                zip.closeEntry()
            }
        }
    }

    private fun serverDirectory(server: String): File {
        val digest = MessageDigest.getInstance("SHA-256").digest(server.trimEnd('/').toByteArray())
            .joinToString("") { "%02x".format(it.toInt() and 255) }
        return File(root, digest).apply { mkdirs() }
    }

    private fun atomicText(file: File, text: String) {
        val temporary = File(file.parentFile, "${file.name}.tmp")
        temporary.writeText(text)
        check(temporary.renameTo(file)) { "网页版本状态保存失败" }
    }

    private fun prune(directory: File, keep: String?) {
        val active = File(directory, "active").takeIf { it.isFile }?.readText()?.trim()
        val pending = File(directory, "pending").takeIf { it.isFile }?.readText()?.trim()
        val retained = setOfNotNull(keep, active, pending)
        val versions = File(directory, "versions").listFiles()?.filter { it.isDirectory } ?: return
        val previous = versions.filter { it.name !in retained }.sortedByDescending { it.lastModified() }.firstOrNull()
        versions.filter { it.name !in retained && it != previous }.forEach { it.deleteRecursively() }
    }

    private fun readBounded(input: InputStream, limit: Int): ByteArray {
        val output = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(4096)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            require(output.size() + count <= limit) { "网页更新信息过大" }
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    private fun compatible(file: File, bridge: Int): Boolean = runCatching {
        val metadata = JSONObject(file.readText())
        metadata.getString("webVersion") == file.parentFile?.name && WebBundlePolicy.bridgeCompatible(
            bridge, metadata.getInt("minBridgeVersion"), metadata.getInt("maxBridgeVersion"))
    }.getOrDefault(false)

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) { val count = input.read(buffer); if (count < 0) break; digest.update(buffer, 0, count) }
        }
        return digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
    }

    companion object {
        const val BRIDGE_VERSION = 1
        const val LOCAL_ORIGIN = "https://appassets.androidplatform.net"
        private const val MAX_BUNDLE_BYTES = 32L * 1024 * 1024
        private const val MAX_UNPACKED_BYTES = 64L * 1024 * 1024
        private const val MAX_FILES = 512
        private val VERSION = Regex("[A-Za-z0-9._-]{1,64}")
        private val HEX = Regex("[a-f0-9]{64}")
    }
}
