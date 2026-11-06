package com.molly.parent

import kotlinx.coroutines.*
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

internal suspend fun sendArtwork(
    api: ParentApi, data: ByteArray, item: String, resume: JSONObject? = null,
    io: CoroutineDispatcher = Dispatchers.IO,
    progress: suspend (JSONObject) -> Unit = {},
) =
    withContext(io) {
        require(data.isNotEmpty() && data.size <= 20 * 1024 * 1024)
        var upload =
            if (resume != null) api.request("/api/manage/uploads/${ParentApi.segment(resume.getString("id"))}")
            else api.request(
                "/api/manage/uploads",
                "POST",
                json(
                    "itemId" to item,
                    "filename" to "cover.jpg",
                    "kind" to "image",
                    "size" to data.size,
                    "fingerprint" to digest(data),
                ),
            )
        val path = "/api/manage/uploads/${ParentApi.segment(upload.getString("id"))}"
        progress(upload)
        if (upload.optString("status") == "cancelled") throw ApiFailure(410, "上传已结束")
        if (upload.optString("status") == "failed" && !upload.isNull("taskId") && upload.optString("taskId").isNotBlank()) {
            upload = api.request("/api/manage/tasks/${ParentApi.segment(upload.getString("taskId"))}/retry", "POST")
            progress(upload)
        }
        run {
            if (upload.optString("status") == "uploading") {
                val oss = upload.getString("transport") == "oss"
                val partSize = if (oss) upload.getInt("partSize") else 4 * 1024 * 1024
                require(partSize in 1..8 * 1024 * 1024)
                val existing = if (oss) api.request("$path/parts").getJSONArray("parts").objects() else emptyList()
                var offset = if (oss) 0 else upload.getInt("offset")
                require(offset in 0..data.size)
                var number = 1
                while (offset < data.size) {
                    ensureActive()
                    val end = minOf(offset + partSize, data.size)
                    val chunk = data.copyOfRange(offset, end)
                    if (oss && existing.any { it.optInt("number") == number && it.optInt("size") == chunk.size }) {
                        offset = end; number++; continue
                    }
                    if (oss) {
                        val signed =
                            api.request(
                                "$path/part-url",
                                "POST",
                                json(
                                    "number" to number,
                                    "md5" to
                                        android.util.Base64.encodeToString(
                                            java.security.MessageDigest.getInstance("MD5")
                                                .digest(chunk),
                                            android.util.Base64.NO_WRAP,
                                        ),
                                ),
                            )
                        val request =
                            okhttp3.Request.Builder()
                                .url(api.endpoint.resolve(signed.getString("url")))
                                .put(chunk.toRequestBody())
                        val headers = signed.getJSONObject("headers")
                        headers.keys().forEach { key ->
                            require(
                                key.lowercase() !in
                                    listOf("cookie", "authorization", "x-csrf-token")
                            )
                            request.header(key, headers.getString(key))
                        }
                        api.anonymous.newCall(request.build()).execute().use {
                            check(it.isSuccessful) { "封面上传未完成，请重试。" }
                        }
                    } else {
                        upload =
                            JSONObject(
                                api.raw(
                                        "$path/chunks?offset=$offset",
                                        "PUT",
                                        chunk,
                                        "application/octet-stream",
                                        mapOf("X-Chunk-SHA256" to digest(chunk)),
                                    )
                                    .toString(Charsets.UTF_8)
                            )
                        progress(upload)
                        require(upload.getInt("offset") == end)
                    }
                    offset = end
                    number++
                }
                ensureActive()
                upload = api.request("$path/complete", "POST")
                progress(upload)
            }
            repeat(30) {
                if (upload.optString("status") == "ready") return@withContext
                if (upload.optString("status") == "failed") error(upload.optString("error"))
                delay(1000)
                upload = api.request(path)
                progress(upload)
            }
            throw ApiFailure(409, "封面已上传，仍在处理中，可稍后返回资料库查看。")
        }
    }
