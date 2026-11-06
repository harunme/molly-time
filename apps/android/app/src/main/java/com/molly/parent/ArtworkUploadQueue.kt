package com.molly.parent

import android.util.AtomicFile
import android.util.Base64
import androidx.compose.runtime.mutableStateMapOf
import java.io.File
import java.util.UUID
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject

/** Main-thread owned optimistic covers; no credentials or signed URLs are persisted. */
class ArtworkUploadQueue(
    private val api: ParentApi,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val backoff: suspend (Int) -> Unit = { delay(listOf(2000L, 5000L, 15000L, 60000L, 300000L)[minOf(it, 4)]) },
) {
    data class Draft(val id: String, val item: String, val data: ByteArray,
        val upload: JSONObject? = null, val savedURL: String? = null)

    val drafts = mutableStateMapOf<String, Draft>()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val directory = api.diskRoot?.resolve("PendingCovers-v1/${digest(api.accountScope.toByteArray())}")
    private val writes = Mutex()
    private val jobs = mutableMapOf<String, Job>()
    private var restored = false
    private var restoring = false
    private var closed = false

    private fun file(item: String) = directory?.resolve(digest(item.toByteArray()) + ".json")
    private suspend fun persist(draft: Draft) = writes.withLock {
        if (closed || drafts[draft.item]?.id != draft.id) return@withLock
        val target = file(draft.item) ?: return@withLock
        val value = json("id" to draft.id, "item" to draft.item,
            "data" to Base64.encodeToString(draft.data, Base64.NO_WRAP),
            "upload" to draft.upload, "savedURL" to draft.savedURL).toString()
        withContext(io) {
            runCatching {
                target.parentFile?.mkdirs()
                val atomic = AtomicFile(target)
                val stream = atomic.startWrite()
                try { stream.write(value.toByteArray()); atomic.finishWrite(stream) }
                catch (e: Exception) { atomic.failWrite(stream); throw e }
            }
        }
    }

    suspend fun enqueue(data: ByteArray, item: String) {
        check(!closed)
        require(data.isNotEmpty() && data.size <= 20 * 1024 * 1024)
        val previous = drafts[item]?.upload
        jobs.remove(item)?.cancel()
        val draft = Draft(UUID.randomUUID().toString(), item, data)
        drafts[item] = draft
        persist(draft)
        cancelObsolete(previous)
        resume()
    }

    private fun cancelObsolete(upload: JSONObject?) {
        if (closed || upload?.optString("status") !in listOf("uploading", "failed")) return
        scope.launch(io) { runCatching { api.request("/api/manage/uploads/${ParentApi.segment(upload!!.getString("id"))}/cancel", "POST") } }
    }

    fun resume() {
        if (closed || restoring) return
        if (!restored) {
            restoring = true
            scope.launch {
                val saved = withContext(io) {
                    directory?.listFiles().orEmpty()
                        .map { if (it.name.endsWith(".json.bak")) File(it.path.removeSuffix(".bak")) else it }
                        .filter { it.extension == "json" }.distinct().mapNotNull { path ->
                        runCatching {
                            val value = JSONObject(AtomicFile(path).readFully().toString(Charsets.UTF_8))
                            Draft(value.getString("id"), value.getString("item"), Base64.decode(value.getString("data"), Base64.NO_WRAP),
                                value.optJSONObject("upload"), value.optString("savedURL").takeUnless { it.isBlank() || it == "null" })
                        }.getOrNull()
                    }
                }
                if (closed) return@launch
                saved.forEach { if (!drafts.containsKey(it.item)) drafts[it.item] = it }
                restored = true; restoring = false; resume()
            }
            return
        }
        for (draft in drafts.values.toList()) {
            if (draft.savedURL != null || jobs.containsKey(draft.item)) continue
            // Lazy start ensures finally cannot remove a job before it has been registered.
            val job = scope.launch(start = CoroutineStart.LAZY) {
                try {
                    repeat(6) { attempt ->
                        ensureActive()
                        val current = drafts[draft.item]?.takeIf { it.id == draft.id } ?: return@launch
                        try {
                            sendArtwork(api, current.data, current.item, current.upload, io) { upload ->
                                withContext(NonCancellable + Dispatchers.Main.immediate) {
                                    if (!closed) {
                                        val value = drafts[current.item]
                                        if (value?.id != current.id) cancelObsolete(upload)
                                        else {
                                            val next = value.copy(upload = upload)
                                            drafts[current.item] = next; persist(next)
                                        }
                                    }
                                }
                            }
                            val resource = withContext(io) { api.request("/api/manage/resources/${ParentApi.segment(current.item)}") }
                            ensureActive()
                            val value = drafts[current.item]?.takeIf { it.id == current.id } ?: return@launch
                            val next = value.copy(savedURL = resource.getString("imageUrl"))
                            drafts[current.item] = next; persist(next)
                            api.onMutation?.invoke(ParentInvalidation(library = true, storage = true))
                            return@launch
                        } catch (e: CancellationException) { throw e }
                        catch (e: Exception) {
                            if (e is ApiFailure && e.status in listOf(400, 401, 403, 413, 422)) return@launch
                            if (e is ApiFailure && e.status in listOf(404, 410)) {
                                drafts[current.item]?.takeIf { it.id == current.id }?.copy(upload = null)?.let {
                                    drafts[current.item] = it; persist(it)
                                }
                            }
                            if (attempt < 5) backoff(attempt)
                        }
                    }
                } finally {
                    if (drafts[draft.item]?.id == draft.id || drafts[draft.item] == null) jobs.remove(draft.item)
                }
            }
            jobs[draft.item] = job; job.start()
        }
    }

    fun acknowledge(item: String, url: String) {
        val draft = drafts[item]?.takeIf { it.savedURL == url } ?: return
        drafts.remove(item)
        scope.launch {
            writes.withLock {
                if (drafts[item] == null) withContext(io) { file(draft.item)?.let { AtomicFile(it).delete() } }
            }
        }
    }

    fun close() { closed = true; scope.cancel(); jobs.clear(); drafts.clear() }
}
