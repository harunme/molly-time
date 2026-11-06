package com.molly.parent

import android.content.Intent
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import androidx.core.content.ContextCompat
import java.io.*
import java.time.LocalDateTime
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

/** Persisted per-account task; failures pause rather than discarding confirmed server parts. */
class UploadController(
    private val app: ParentApplication,
    private val kind: String = "library",
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mutable = MutableStateFlow<JSONObject?>(null)
    val state = mutable.asStateFlow()
    private var client: ParentApi? = null
    private var directory: File? = null
    private var job: Job? = null
    private var epoch = 0
    val busy
        get() = mutable.value?.optBoolean("busy") == true

    val pending
        get() = mutable.value?.optJSONObject("upload")?.optString("status") == "processing"

    fun bind(api: ParentApi?, account: String) {
        pause()
        epoch++
        client = api
        directory =
            File(app.noBackupFilesDir, "Uploads-v1/${digest(account.toByteArray())}/$kind").apply {
                mkdirs()
            }
        mutable.value =
            runCatching { JSONObject(File(directory, "draft.json").readText()).put("busy", false) }
                .getOrNull()
    }

    private fun publish(value: JSONObject?) {
        mutable.value = value?.let { JSONObject(it.toString()) }
        val dir = directory ?: return
        val file = File(dir, "draft.json")
        if (value == null) {
            file.delete()
            return
        }
        val tmp = File(dir, "draft.tmp")
        tmp.writeText(value.toString())
        check(tmp.renameTo(file)) { "无法保存上传任务" }
    }

    private fun update(block: JSONObject.() -> Unit) {
        val value = mutable.value ?: return
        publish(JSONObject(value.toString()).apply(block))
    }

    fun configure(name: String? = null, folder: JSONObject? = null, allow: Boolean? = null) {
        if (busy || mutable.value?.optJSONObject("resource") != null) return
        update {
            if (name != null) put("name", name)
            if (folder != null) put("folder", folder)
            if (allow != null) put("allowChildren", allow)
        }
    }

    fun prepare(uri: Uri, photo: Boolean, folder: JSONObject?, reminderKind: String? = null) {
        if (busy) return
        epoch++
        clear()
        val api = client ?: return
        val token = epoch
        publish(
            json(
                "busy" to true,
                "phase" to "正在准备视频，请稍候…",
                "name" to "",
                "folder" to folder,
                "allowChildren" to false,
                "reminderKind" to reminderKind,
            )
        )
        job =
            scope.launch {
                var input: File? = null
                var output: File? = null
                try {
                    var filename = "video.mp4"
                    withContext(io) {
                        app.contentResolver
                            .query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                            ?.use { if (it.moveToFirst()) filename = it.getString(0) ?: filename }
                    }
                    if (!photo) require(filename.endsWith(".mp4", true)) { "请选择 MP4 视频" }
                    val limit =
                        withContext(io) {
                            api.request("/api/manage/uploads/options").getLong("video")
                        }
                    input =
                        File(
                            directory,
                            "source-${System.nanoTime()}.${if(photo)"movie" else "mp4"}",
                        )
                    withContext(io) {
                        app.contentResolver.openInputStream(uri)!!.use { source ->
                            input!!.outputStream().use { target ->
                                val buffer = ByteArray(262144)
                                var total = 0L
                                while (true) {
                                    ensureActive()
                                    val n = source.read(buffer)
                                    if (n < 0) break
                                    total += n
                                    require(total <= limit) { "视频超过服务器大小上限" }
                                    target.write(buffer, 0, n)
                                }
                                require(total > 0) { "视频文件为空" }
                            }
                        }
                    }
                    val video =
                        if (photo) {
                            output = File(directory, "video-${System.nanoTime()}.mp4")
                            MediaPreparation.mp4(app, input!!, output!!)
                            input!!.delete()
                            output!!
                        } else input!!
                    val metadata = withContext(io) { metadata(video) }
                    require(video.length() <= limit) { "视频超过服务器大小上限" }
                    if (token != epoch || api !== client) {
                        video.delete()
                        return@launch
                    }
                    val stem = filename.substringBeforeLast('.').trim()
                    val name =
                        if (
                            stem.isEmpty() ||
                                stem.lowercase() in
                                    listOf("video", "movie", "fullsizerender", "tmp", "temp") ||
                                stem.matches(Regex("[0-9a-fA-F-]{32,36}"))
                        )
                            "视频 ${LocalDateTime.now().toString().replace('T',' ').take(19)}"
                        else clipTitle(stem, 256)
                    update {
                        put("file", video.path)
                        put("filename", filename.substringBeforeLast('.') + ".mp4")
                        put("name", name)
                        put("metadata", metadata)
                        put("busy", false)
                        put("phase", "准备好了，可以开始上传")
                    }
                } catch (e: CancellationException) {
                    input?.delete()
                    output?.delete()
                    throw e
                } catch (e: Exception) {
                    input?.delete()
                    output?.delete()
                    if (token == epoch)
                        update {
                            put("busy", false)
                            put("error", e.message ?: "视频准备未完成，请重新选择")
                        }
                } finally {
                    UploadService.finishIfIdle(app)
                }
            }
    }

    private fun metadata(file: File): JSONObject {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.setDataSource(file.path)
            val duration =
                retriever
                    .extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)
                    ?.toLongOrNull() ?: 0
            require(
                duration > 0 &&
                    retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO) ==
                        "yes"
            ) {
                "没有读到有效的视频轨道或时长"
            }
            var cover: String? = null
            if (android.os.Build.VERSION.SDK_INT >= 27)
                runCatching {
                        retriever.getScaledFrameAtTime(
                            0,
                            MediaMetadataRetriever.OPTION_CLOSEST_SYNC,
                            640,
                            360,
                        )
                    }
                    .getOrNull()
                    ?.let { bitmap ->
                        val out = ByteArrayOutputStream()
                        bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 70, out)
                        bitmap.recycle()
                        if (out.size() < 240000)
                            cover =
                                "data:image/jpeg;base64," +
                                    Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                    }
            return json("runtimeMs" to duration, "cover" to cover)
        } finally {
            retriever.release()
        }
    }

    fun begin() {
        if (busy || client == null || mutable.value?.has("file") != true) return
        if ((if (kind == "library") app.reminderUploads else app.uploads).busy) return
        update { put("autoResume", true) }
        ContextCompat.startForegroundService(app, Intent(app, UploadService::class.java))
    }

    internal fun run() {
        if (busy) return
        val api = client ?: return
        val token = epoch
        val initial = mutable.value ?: return
        if (!initial.optBoolean("autoResume") || pending || initial.optBoolean("completed")) return
        update {
            put("busy", true)
            remove("error")
            put("phase", "正在上传，可以离开此页面")
        }
        job =
            scope.launch {
                try {
                    withContext(io) {
                        var draft = JSONObject(initial.toString())
                        val file = File(draft.getString("file"))
                        require(file.isFile) { "原视频不在本机，请重新选择" }
                        suspend fun save() {
                            withContext(Dispatchers.Main) {
                                if (token != epoch || api !== client) throw CancellationException()
                                publish(JSONObject(draft.toString()).put("busy", true))
                            }
                        }
                        var resource = draft.optJSONObject("resource")
                        if (resource == null) {
                            val reminder =
                                draft.optString("reminderKind").takeUnless {
                                    it.isEmpty() || it == "null"
                                }
                            resource =
                                if (reminder != null) {
                                    val target =
                                        api.request(
                                            "/api/manage/reminders/$reminder/upload-target",
                                            "POST",
                                        )
                                    json(
                                        "id" to target.getString("itemId"),
                                        "name" to "休息提醒视频",
                                        "type" to "Episode",
                                    )
                                } else {
                                    val folder =
                                        draft.optJSONObject("folder") ?: findUploadFolder(api)
                                    draft.put("folder", folder)
                                    createNamedVideo(
                                        api,
                                        draft.getString("name"),
                                        folder.getString("id"),
                                    )
                                }
                            draft.put("resource", resource)
                            save()
                        }
                        var upload =
                            draft.optJSONObject("upload")?.let {
                                api.request(
                                    "/api/manage/uploads/${ParentApi.segment(it.getString("id"))}"
                                )
                            }
                                ?: api.request(
                                    "/api/manage/uploads",
                                    "POST",
                                    json(
                                        "itemId" to resource.getString("id"),
                                        "filename" to draft.getString("filename"),
                                        "kind" to "video",
                                        "size" to file.length(),
                                        "fingerprint" to
                                            digest(
                                                "${file.name}|${file.length()}|${file.lastModified()}"
                                                    .toByteArray()
                                            ),
                                    ),
                                )
                        draft.put("upload", upload)
                        save()
                        val id = ParentApi.segment(upload.getString("id"))
                        val path = "/api/manage/uploads/$id"
                        if (upload.getString("status") == "uploading") {
                            val oss = upload.getString("transport") == "oss"
                            val partSize = if (oss) upload.getInt("partSize") else 4 * 1024 * 1024
                            require(partSize in 1..8 * 1024 * 1024)
                            val parts =
                                if (oss)
                                    api.request("$path/parts")
                                        .getJSONArray("parts")
                                        .objects()
                                        .associate { it.getInt("number") to it.getLong("size") }
                                else emptyMap()
                            var offset = if (oss) 0 else upload.getLong("offset")
                            require(offset in 0..file.length())
                            var number = 1
                            RandomAccessFile(file, "r").use { source ->
                                while (offset < file.length()) {
                                    ensureActive()
                                    val count =
                                        minOf(partSize.toLong(), file.length() - offset).toInt()
                                    if (!oss || parts[number] != count.toLong()) {
                                        val data = ByteArray(count)
                                        source.seek(offset)
                                        source.readFully(data)
                                        if (oss) {
                                            val signed =
                                                api.request(
                                                    "$path/part-url",
                                                    "POST",
                                                    json(
                                                        "number" to number,
                                                        "md5" to
                                                            Base64.encodeToString(
                                                                java.security.MessageDigest
                                                                    .getInstance("MD5")
                                                                    .digest(data),
                                                                Base64.NO_WRAP,
                                                            ),
                                                    ),
                                                )
                                            val request =
                                                Request.Builder()
                                                    .url(
                                                        api.endpoint.resolve(
                                                            signed.getString("url")
                                                        )
                                                    )
                                                    .put(data.toRequestBody())
                                            val headers = signed.getJSONObject("headers")
                                            headers.keys().forEach { key ->
                                                require(
                                                    key.lowercase() !in
                                                        listOf(
                                                            "cookie",
                                                            "authorization",
                                                            "x-csrf-token",
                                                        )
                                                )
                                                request.header(key, headers.getString(key))
                                            }
                                            api.anonymous.newCall(request.build()).execute().use {
                                                check(it.isSuccessful) {
                                                    "分片上传未完成，可以继续上传（${it.code}）"
                                                }
                                            }
                                        } else {
                                            upload =
                                                JSONObject(
                                                    api.raw(
                                                            "$path/chunks?offset=$offset",
                                                            "PUT",
                                                            data,
                                                            "application/octet-stream",
                                                            mapOf("X-Chunk-SHA256" to digest(data)),
                                                        )
                                                        .toString(Charsets.UTF_8)
                                                )
                                            require(upload.getLong("offset") == offset + count)
                                            draft.put("upload", upload)
                                        }
                                    }
                                    offset += count
                                    number++
                                    draft.put("progress", offset.toDouble() / file.length())
                                    save()
                                }
                            }
                            ensureActive()
                            upload =
                                api.request(
                                    "$path/complete",
                                    "POST",
                                    draft.getJSONObject("metadata"),
                                )
                            draft.put("upload", upload)
                            draft.put("phase", "已上传，正在处理")
                            draft.put("progress", 1)
                            save()
                        }
                    }
                    if (token == epoch) checkCompletion()
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (token == epoch)
                        update {
                            put("error", e.message ?: "上传暂未完成，可以继续上传")
                            put("autoResume", false)
                        }
                } finally {
                    if (token == epoch) update { put("busy", false) }
                    UploadService.finishIfIdle(app)
                }
            }
    }

    suspend fun checkCompletion() {
        val api = client ?: return
        val token = epoch
        val current = mutable.value?.optJSONObject("upload") ?: return
        try {
            val value =
                withContext(io) {
                    api.request("/api/manage/uploads/${ParentApi.segment(current.getString("id"))}")
                }
            if (token != epoch || api !== client) return
            update { put("upload", value) }
            when (value.getString("status")) {
                "ready" -> {
                    update {
                        put("completed", true)
                        put("autoResume", false)
                        put("progress", 1)
                        put("phase", "可以在手机观看")
                        remove("error")
                    }
                    if (
                        mutable.value?.optBoolean("allowChildren") == true &&
                            mutable.value?.optBoolean("published") != true
                    ) {
                        try {
                            val updated =
                                withContext(io) {
                                    api.request(
                                        "/api/manage/resources/${ParentApi.segment(mutable.value!!.getJSONObject("resource").getString("id"))}/publish",
                                        "POST",
                                    )
                                }
                            if (token == epoch)
                                update {
                                    put("resource", updated)
                                    put("published", true)
                                    put("phase", "已允许孩子观看")
                                }
                        } catch (e: Exception) {
                            if (e is CancellationException) throw e
                            update { put("error", "视频已上传，但还未开放给孩子。请重试，或在视频详情中允许孩子观看。") }
                        }
                    }
                }
                "failed" ->
                    update {
                        put("error", value.optString("error").ifEmpty { "视频处理失败，可重试处理或重新添加。" })
                        put("autoResume", false)
                    }
                "processing" -> update { put("phase", "视频仍在处理中，稍后再看看") }
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (token == epoch) update { put("error", e.message ?: "进度暂未更新") }
        }
    }

    fun retryProcessing() {
        val api = client ?: return
        val task = mutable.value?.optJSONObject("upload")?.optString("taskId") ?: return
        job =
            scope.launch {
                update { put("busy", true) }
                try {
                    withContext(io) {
                        api.request("/api/manage/tasks/${ParentApi.segment(task)}/retry", "POST")
                    }
                    checkCompletion()
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    update { put("error", e.message) }
                } finally {
                    update { put("busy", false) }
                }
            }
    }

    fun pause() {
        epoch++
        job?.cancel()
        if (mutable.value != null)
            update {
                put("busy", false)
                put("autoResume", false)
                put("phase", "已暂停，可以继续上传")
            }
        UploadService.finishIfIdle(app)
    }

    fun resumeAutomatically() {
        if (
            mutable.value?.optBoolean("autoResume") == true &&
                !pending &&
                mutable.value?.optBoolean("completed") != true
        )
            begin()
    }

    suspend fun cancel() {
        pause()
        val token = epoch
        val api = client
        val upload = mutable.value?.optJSONObject("upload")
        if (
            api != null &&
                upload != null &&
                upload.optString("status") in listOf("uploading", "failed")
        )
            withContext(io) {
                api.request(
                    "/api/manage/uploads/${ParentApi.segment(upload.getString("id"))}/cancel",
                    "POST",
                )
            }
        if (token == epoch && api === client) clear()
    }

    fun clear() {
        check(!busy)
        mutable.value?.optString("file")?.let { File(it).delete() }
        publish(null)
    }

    private fun findUploadFolder(api: ParentApi): JSONObject {
        var page = 1
        while (true) {
            val response = api.resources(null, page)
            response
                .getJSONArray("items")
                .objects()
                .firstOrNull { it.optString("name") == "手机添加" && it.optString("type") != "Episode" }
                ?.let {
                    return it
                }
            if (page * response.getInt("pageSize") >= response.getInt("total")) break
            page++
        }
        return api.request(
            "/api/manage/resources",
            "POST",
            json("name" to "手机添加", "type" to "Series"),
        )
    }

    private fun createNamedVideo(api: ParentApi, name: String, folder: String): JSONObject {
        var candidate = name
        val names = mutableSetOf<String>()
        repeat(5) {
            try {
                return api.request(
                    "/api/manage/resources",
                    "POST",
                    json("name" to candidate, "type" to "Episode", "parentId" to folder),
                )
            } catch (e: ApiFailure) {
                if (e.status != 409 || e.message != "同一目录已有这个名称") throw e
                names.add(candidate)
                for (status in listOf("", "archived")) {
                    var page = 1
                    while (true) {
                        val response =
                            api.request(
                                "/api/manage/resources?parentId=${ParentApi.segment(folder)}&resourceType=Episode&status=$status&page=$page&pageSize=100&summary=true"
                            )
                        names.addAll(
                            response.getJSONArray("items").objects().map { it.getString("name") }
                        )
                        if (page * response.getInt("pageSize") >= response.getInt("total")) break
                        page++
                    }
                }
                candidate = availableUploadTitle(name, names)
            }
        }
        error("同名内容正在添加，请稍后重试或换个名称。")
    }
}

internal fun clipTitle(value: String, limit: Int): String {
    val points = value.codePoints().limit(limit.toLong()).toArray()
    return String(points, 0, points.size)
}

internal fun availableUploadTitle(requested: String, existing: Set<String>): String {
    fun fold(value: String) =
        java.text.Normalizer.normalize(value, java.text.Normalizer.Form.NFKD)
            .replace(Regex("\\p{M}"), "")
            .lowercase(java.util.Locale.ROOT)
    val base = clipTitle(requested.trim(), 256)
    val occupied = existing.map(::fold).toSet()
    if (fold(base) !in occupied) return base
    for (number in 2..existing.size + 2) {
        val suffix = " ($number)"
        val candidate = clipTitle(base, 256 - suffix.length) + suffix
        if (fold(candidate) !in occupied) return candidate
    }
    error("无法生成视频名称")
}
