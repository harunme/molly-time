package com.molly.tv

import android.content.Context
import java.io.File
import java.util.concurrent.ConcurrentHashMap

class CoverStore(context: Context, private val session: SessionStore, private val api: MollyTimeApi) {
    private val root = File(context.filesDir, "catalog-covers").apply { mkdirs() }
    private val calls = java.util.Collections.newSetFromMap(ConcurrentHashMap<okhttp3.Call, Boolean>())
    fun cancel() { calls.forEach { it.cancel() } }
    private val pending = java.util.Collections.newSetFromMap(ConcurrentHashMap<String, Boolean>())
    private fun directory() = File(root, CatalogStore.digest(session.server + "|" + session.deviceId)).apply { mkdirs() }
    private fun file(path: String, version: String) = File(directory(), CatalogStore.digest("$path|$version|480") + ".jpg")
    fun cached(path: String, version: String): File? {
        if (!version.matches(Regex("[a-f0-9]{64}")) || !BridgePolicy.image.matches(path)) return null
        return file(path, version).takeIf { it.isFile }?.also { it.setLastModified(System.currentTimeMillis()) }
    }
    fun fetch(path: String, version: String) {
        require(BridgePolicy.image.matches(path) && version.matches(Regex("[a-f0-9]{64}")))
        if (cached(path, version) != null) return
        val owner = session.server + "|" + session.deviceId
        val key = "$owner|$path|$version"
        if (!pending.add(key)) return
        val target = file(path, version)
        var active: okhttp3.Call? = null
        val temporary = File(target.parentFile, target.name + ".tmp")
        try {
            check(root.usableSpace >= 1024L * 1024 * 1024) { "封面缓存空间不足" }
            api.catalogResponse("$path?w=480") { active = it; calls.add(it) }.use { res ->
                check(res.header("X-Molly-Image-Version") == version) { "封面版本已变化" }
                val body = res.body ?: error("封面为空")
                require(body.contentLength() <= 8L * 1024 * 1024) { "封面过大" }
                body.byteStream().use { input -> temporary.outputStream().use { output ->
                    val buffer = ByteArray(32768); var total = 0
                    while (true) { val n = input.read(buffer); if (n < 0) break; total += n; require(total <= 8 * 1024 * 1024); output.write(buffer, 0, n) }
                } }
            }
            active?.let { calls.remove(it) }
            check(owner == session.server + "|" + session.deviceId)
            check(temporary.renameTo(target))
            val files = directory().listFiles()?.filter { it.extension == "jpg" }?.sortedBy { it.lastModified() } ?: emptyList()
            var bytes = files.sumOf { it.length() }
            for (old in files) { if (bytes <= 256L * 1024 * 1024) break; val length = old.length(); if (old.delete()) bytes -= length }
        } finally { active?.let { calls.remove(it) }; temporary.delete(); pending.remove(key) }
    }
}
