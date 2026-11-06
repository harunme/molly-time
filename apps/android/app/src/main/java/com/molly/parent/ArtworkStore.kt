package com.molly.parent

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import java.io.File
import kotlinx.coroutines.*
import okhttp3.Request

/** Account-scoped memory cache and bounded, versioned-only disk cache, like MollyCore. */
class ArtworkStore(private val api: ParentApi) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private data class Entry(val bitmap: Bitmap, val date: Long)

    private val cache =
        object : LruCache<String, Entry>(64 * 1024 * 1024) {
            override fun sizeOf(key: String, value: Entry) = value.bitmap.allocationByteCount
        }
    private val pending = mutableMapOf<String, Deferred<Bitmap?>>()
    private var closed = false

    @Synchronized fun cached(path: String): Bitmap? = if (closed) null else cache.get(path)?.bitmap

    suspend fun load(path: String): Bitmap? {
        val work =
            synchronized(this) {
                if (closed) return null
                cache
                    .get(path)
                    ?.takeIf { System.currentTimeMillis() - it.date < 600_000 }
                    ?.let {
                        return it.bitmap
                    }
                pending[path]
                    ?: scope
                        .async {
                            val old = cached(path)
                            runCatching {
                                    val url = api.endpoint.resolve(path)
                                    val directory =
                                        api.diskRoot?.resolve("Artwork-v1")?.apply { mkdirs() }
                                    val disk =
                                        if (!url.queryParameter("v").isNullOrBlank())
                                            directory?.resolve(
                                                digest("${api.accountScope}|$path".toByteArray())
                                            )
                                        else null
                                    var bytes =
                                        disk
                                            ?.takeIf {
                                                it.isFile &&
                                                    System.currentTimeMillis() - it.lastModified() <
                                                        7 * 86_400_000L
                                            }
                                            ?.readBytes()
                                    if (bytes == null)
                                        api.mediaClient
                                            .newCall(Request.Builder().url(url).build())
                                            .execute()
                                            .use { response ->
                                                check(response.isSuccessful)
                                                bytes =
                                                    response.body!!.byteStream().use { stream ->
                                                        val out = java.io.ByteArrayOutputStream()
                                                        val buffer = ByteArray(32768)
                                                        while (out.size() <= 8 * 1024 * 1024) {
                                                            val n = stream.read(buffer)
                                                            if (n < 0) break
                                                            out.write(buffer, 0, n)
                                                        }
                                                        out.toByteArray()
                                                    }
                                                require(bytes!!.size <= 8 * 1024 * 1024)
                                            }
                                    val data = bytes!!
                                    val bounds =
                                        BitmapFactory.Options().apply { inJustDecodeBounds = true }
                                    BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
                                    require(bounds.outWidth > 0 && bounds.outHeight > 0)
                                    val options =
                                        BitmapFactory.Options().apply {
                                            inSampleSize = 1
                                            while (
                                                maxOf(bounds.outWidth, bounds.outHeight) /
                                                    inSampleSize > 1200
                                            ) inSampleSize *= 2
                                        }
                                    val image =
                                        BitmapFactory.decodeByteArray(data, 0, data.size, options)
                                            ?: error("无效封面")
                                    if (disk != null && !disk.exists())
                                        runCatching {
                                            val temp =
                                                File.createTempFile("cover-", ".tmp", directory)
                                            temp.writeBytes(data)
                                            if (!temp.renameTo(disk)) temp.delete()
                                            var size =
                                                directory!!.listFiles().orEmpty().sumOf {
                                                    it.length()
                                                }
                                            directory
                                                .listFiles()
                                                .orEmpty()
                                                .sortedBy { it.lastModified() }
                                                .forEach { file ->
                                                    if (
                                                        size > 64 * 1024 * 1024 ||
                                                            System.currentTimeMillis() -
                                                                file.lastModified() >
                                                                7 * 86_400_000L
                                                    ) {
                                                        val length = file.length()
                                                        if (file.delete()) size -= length
                                                    }
                                                }
                                        }
                                    image
                                }
                                .getOrNull() ?: old
                        }
                        .also { pending[path] = it }
            }
        val result = work.await()
        synchronized(this) {
            if (pending[path] === work) pending.remove(path)
            if (!closed && result != null) {
                cache.put(path, Entry(result, System.currentTimeMillis()))
                while (cache.snapshot().size > 200) cache.remove(cache.snapshot().keys.first())
            }
        }
        return result
    }

    @Synchronized
    fun close() {
        closed = true
        scope.cancel()
        pending.clear()
        cache.evictAll()
    }
}
