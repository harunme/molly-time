package com.molly.parent

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.datasource.*
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import okhttp3.Request
import org.json.JSONObject

fun digest(value: ByteArray, algorithm: String = "SHA-256") =
    MessageDigest.getInstance(algorithm).digest(value).joinToString("") { "%02x".format(it) }

class RangeUnsupportedException : IOException("服务器暂不支持分段读取")

/** Demand-filled 256 KiB chunks. No signed URLs, credentials, eviction or backup. */
class VideoChunkStore(private val directory: File) {
    companion object {
        const val CHUNK_SIZE = 256 * 1024
        private val locks = Array(64) { Any() }
    }

    fun chunk(key: String, index: Long, count: Int, fetch: () -> ByteArray): ByteArray {
        require(index >= 0 && count in 1..CHUNK_SIZE)
        val identity = digest("$key|chunk:$index".toByteArray())
        return synchronized(locks[(identity.hashCode() and Int.MAX_VALUE) % locks.size]) {
            val file = File(directory, identity)
            val cached =
                runCatching { file.takeIf { it.length() == count + 32L }?.readBytes() }.getOrNull()
            if (cached != null) {
                val data = cached.copyOfRange(32, cached.size)
                if (
                    MessageDigest.isEqual(
                        cached.copyOfRange(0, 32),
                        MessageDigest.getInstance("SHA-256").digest(data),
                    )
                )
                    return@synchronized data
            }
            val data = fetch()
            if (data.size != count) throw IOException("视频分段长度不一致")
            runCatching {
                directory.mkdirs()
                val tmp = File.createTempFile("chunk-", ".tmp", directory)
                try {
                    tmp.writeBytes(MessageDigest.getInstance("SHA-256").digest(data) + data)
                    check(tmp.renameTo(file))
                } finally {
                    tmp.delete()
                }
            }
            data
        }
    }
}

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
object MediaDiskCache {
    fun key(scope: String, playback: JSONObject): String? {
        val version = playback.optString("version")
        val mime = playback.optString("mime").lowercase()
        if (
            version.isBlank() ||
                version == "null" ||
                playback.optLong("size") <= 0 ||
                mime !in listOf("video/mp4", "video/quicktime", "video/x-m4v") ||
                playback.optString("mediaId").isBlank()
        )
            return null
        return digest(
            "$scope|${playback.getString("mediaId")}|$version|${playback.getLong("size")}|$mime"
                .toByteArray()
        )
    }

    fun factory(
        api: ParentApi,
        info: JSONObject,
        key: String,
        upstream: DataSource.Factory,
    ): DataSource.Factory {
        val uri = Uri.parse(api.endpoint.resolve(info.getString("url")).toString())
        val size = info.getLong("size")
        val cache = VideoChunkStore(File(api.diskRoot, "MollyVideo-v1"))
        return DataSource.Factory {
            object : BaseDataSource(true) {
                private var fallback: DataSource? = null
                private var opened = false
                private var offset = 0L
                private var remaining = 0L
                private var buffer = byteArrayOf()
                private var bufferStart = 0L

                override fun open(spec: DataSpec): Long {
                    if (spec.uri != uri) {
                        return upstream.createDataSource().also { fallback = it }.open(spec)
                    }
                    if (spec.position !in 0..size) throw IOException("无效的视频读取位置")
                    transferInitializing(spec)
                    offset = spec.position
                    remaining =
                        if (spec.length == C.LENGTH_UNSET.toLong()) size - offset
                        else minOf(spec.length, size - offset)
                    opened = true
                    transferStarted(spec)
                    return remaining
                }

                override fun read(target: ByteArray, start: Int, length: Int): Int {
                    fallback?.let {
                        return it.read(target, start, length)
                    }
                    if (length == 0) return 0
                    if (remaining == 0L) return C.RESULT_END_OF_INPUT
                    if (
                        buffer.isEmpty() || offset !in bufferStart until bufferStart + buffer.size
                    ) {
                        bufferStart =
                            offset / VideoChunkStore.CHUNK_SIZE * VideoChunkStore.CHUNK_SIZE
                        val count =
                            minOf(VideoChunkStore.CHUNK_SIZE.toLong(), size - bufferStart).toInt()
                        buffer =
                            cache.chunk(key, bufferStart / VideoChunkStore.CHUNK_SIZE, count) {
                                val request =
                                    Request.Builder()
                                        .url(uri.toString())
                                        .header(
                                            "Range",
                                            "bytes=$bufferStart-${bufferStart+count-1}",
                                        )
                                        .header("Accept-Encoding", "identity")
                                        .build()
                                api.mediaClient.newCall(request).execute().use { response ->
                                    if (
                                        response.code == 200 &&
                                            !(bufferStart == 0L && count.toLong() == size)
                                    )
                                        throw RangeUnsupportedException()
                                    if (
                                        response.code != 200 &&
                                            (response.code != 206 ||
                                                response.header("Content-Range") !=
                                                    "bytes $bufferStart-${bufferStart+count-1}/$size")
                                    )
                                        throw IOException("视频分段响应无效")
                                    if (
                                        response.header("Content-Length")?.toLongOrNull()?.let {
                                            it != count.toLong()
                                        } == true ||
                                            response.header("Content-Encoding")?.let {
                                                it.lowercase() != "identity"
                                            } == true
                                    )
                                        throw IOException("视频分段响应无效")
                                    response.body!!.byteStream().use { input ->
                                        val data = ByteArray(count)
                                        var read = 0
                                        while (read < count) {
                                            val n = input.read(data, read, count - read)
                                            if (n < 0) throw IOException("视频分段未完整传输")
                                            read += n
                                        }
                                        if (input.read() != -1) throw IOException("视频分段超长")
                                        data
                                    }
                                }
                            }
                    }
                    val count =
                        minOf(length.toLong(), remaining, buffer.size - (offset - bufferStart))
                            .toInt()
                    buffer.copyInto(
                        target,
                        start,
                        (offset - bufferStart).toInt(),
                        (offset - bufferStart).toInt() + count,
                    )
                    offset += count
                    remaining -= count
                    bytesTransferred(count)
                    return count
                }

                override fun getUri(): Uri? = fallback?.uri ?: if (opened) uri else null

                override fun getResponseHeaders(): Map<String, List<String>> =
                    fallback?.responseHeaders ?: emptyMap()

                override fun close() {
                    fallback?.close()
                    fallback = null
                    buffer = byteArrayOf()
                    if (opened) {
                        opened = false
                        transferEnded()
                    }
                }
            }
        }
    }
}
