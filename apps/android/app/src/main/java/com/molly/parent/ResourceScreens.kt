@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.molly.parent

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.*
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

@Composable
internal fun FolderPicker(
    api: ParentApi,
    excluding: Set<String>,
    allowRoot: Boolean,
    dismiss: () -> Unit,
    select: (JSONObject?) -> Unit,
) {
    var folders by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var path by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var failure by remember { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    val parent = path.lastOrNull()
    LaunchedEffect(api, parent) {
        loading = true
        failure = null
        try {
            folders =
                withContext(Dispatchers.IO) {
                    val all = mutableListOf<JSONObject>()
                    var page = 1
                    while (true) {
                        val result = api.resources(parent?.getString("id"), page)
                        ensureActive()
                        all.addAll(
                            result.getJSONArray("items").objects().filter {
                                it.optString("type") != "Episode" &&
                                    it.getString("id") !in excluding
                            }
                        )
                        if (page * result.getInt("pageSize") >= result.getInt("total")) break
                        page++
                    }
                    all
                }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failure = e.message
        } finally {
            loading = false
        }
    }
    ModalBottomSheet(
        onDismissRequest = dismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    ) {
        Column(
            Modifier.fillMaxWidth().navigationBarsPadding().padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            Text(parent?.getString("name") ?: "选择目标合集", style = MaterialTheme.typography.titleLarge)
            if (path.isNotEmpty()) QuietAction("返回上一级") { path = path.dropLast(1) }
            if (loading) StorageSkeleton()
            failure?.let { ErrorMessage(it) }
            LazyColumn(Modifier.weight(1f, false).heightIn(max = 400.dp)) {
                items(folders.size) { index ->
                    val child = folders[index]
                    SettingsRow(
                        Icons.Outlined.FolderOpen,
                        child.getString("name"),
                        action = { path = path + child },
                    )
                }
            }
            if (!loading && folders.isEmpty()) Hint("没有下级合集")
            if (parent != null || allowRoot)
                PrimaryAction(if (parent == null) "移到资料库首页" else "选这个合集") { select(parent) }
            QuietAction("取消", onClick = dismiss)
        }
    }
}

@Composable
internal fun ResourceActions(model: ParentViewModel, item: JSONObject, done: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val api = model.api!!
    var action by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    var name by remember { mutableStateOf(item.getString("name")) }
    val id = ParentApi.segment(item.getString("id"))
    val path = "/api/manage/resources/$id"
    BackHandler(busy) {}
    fun perform(kind: String, body: JSONObject = JSONObject()) {
        scope.launch {
            busy = true
            failure = null
            try {
                withContext(Dispatchers.IO) {
                    api.request(
                        if (kind == "rename") path else "$path/$kind",
                        if (kind == "rename") "PATCH" else "POST",
                        body,
                    )
                }
                done()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = e.message
            } finally {
                busy = false
            }
        }
    }
    val cover =
        rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            if (uri != null)
                scope.launch {
                    busy = true
                    try {
                        val data =
                            withContext(Dispatchers.IO) {
                                MediaPreparation.jpeg(context, uri, 1200, 85)
                            }
                        sendArtwork(api, data, item.getString("id"))
                        done()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        failure = e.message
                    } finally {
                        busy = false
                    }
                }
        }
    SurfaceBlock {
        SettingsRow(
            Icons.Outlined.Edit,
            "重命名",
            action = if (!busy && model.canManage) ({ action = "rename" }) else null,
        )
        SettingsRow(
            Icons.Outlined.Image,
            "更换封面",
            action = if (!busy && model.canManage) ({ cover.launch("image/*") }) else null,
        )
        SettingsRow(
            Icons.Outlined.FolderOpen,
            "移动到…",
            action = if (!busy && model.canManage) ({ action = "move" }) else null,
        )
    }
    SurfaceBlock {
        val published = item.optString("status") == "published"
        SettingsRow(
            if (published) Icons.Outlined.PersonOutline else Icons.Outlined.Tv,
            if (published) "仅家长可看" else "允许孩子观看",
            action =
                if (!busy && model.canManage)
                    ({ perform(if (published) "unpublish" else "publish") })
                else null,
        )
        if (item.optString("type") != "Episode") Hint("调整合集只改变整个合集的可见性，里面的视频保留各自的观看设置。")
        else
            item.optJSONObject("hiddenByFolder")?.let {
                Hint("所在合集「${it.getString("name")}」也需允许孩子观看。")
            }
    }
    SurfaceBlock {
        SettingsRow(
            Icons.Outlined.DeleteOutline,
            "移到最近删除",
            destructive = true,
            action = if (!busy && model.canManage) ({ action = "archive" }) else null,
        )
    }
    if (busy) Hint("正在保存…")
    failure?.let { ErrorMessage(it) }
    if (action == "move")
        FolderPicker(
            api,
            setOf(item.getString("id")),
            item.optString("type") == "Series",
            { action = "" },
        ) { folder ->
            action = ""
            perform("move", json("folderId" to folder?.getString("id")))
        }
    if (action == "rename")
        AlertDialog(
            onDismissRequest = { if (!busy) action = "" },
            title = { Text("重命名") },
            text = { MollyTextField(name, { name = it }, "名称") },
            confirmButton = {
                QuietAction("保存", name.isNotBlank() && !busy) {
                    action = ""
                    perform("rename", json("name" to name.trim()))
                }
            },
            dismissButton = { QuietAction("取消") { action = "" } },
        )
    if (action == "archive")
        AlertDialog(
            onDismissRequest = { action = "" },
            title = { Text("移到最近删除？") },
            text = {
                Text(
                    "「${item.getString("name")}」将从资料库移除。${if(item.optString("type")!="Episode")"合集内的内容会一起移入。"else""}可在「我的 → 最近删除」中恢复。"
                )
            },
            confirmButton = {
                QuietAction("移到最近删除") {
                    action = ""
                    perform("archive")
                }
            },
            dismissButton = { QuietAction("取消") { action = "" } },
        )
}

@Composable
internal fun VideoDetailsScreen(model: ParentViewModel, resource: JSONObject, back: () -> Unit) {
    val api = model.api!!
    var item by remember { mutableStateOf(resource) }
    var failure by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var revision by remember { mutableIntStateOf(0) }
    var managing by remember { mutableStateOf(false) }
    var publishing by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    LaunchedEffect(api, revision, model.libraryChange) {
        try {
            val fresh =
                withContext(Dispatchers.IO) {
                    api.request(
                        "/api/manage/resources/${ParentApi.segment(resource.getString("id"))}"
                    )
                }
            if (fresh.optString("status") == "archived") back() else item = fresh
            failure = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failure = e.message
        } finally {
            refreshing = false
        }
    }
    DetailFrame(
        "",
        back,
        actions = {
            if (model.canManage)
                IconButton(onClick = { managing = true }) { Icon(Icons.Outlined.MoreHoriz, "整理视频") }
        },
        refreshing = refreshing,
        onRefresh = {
            refreshing = true
            revision++
        },
    ) {
        ResourceCover(item, api, Modifier.fillMaxWidth().aspectRatio(16f / 10))
        Text(item.getString("name"), style = MaterialTheme.typography.headlineLarge)
        val runtime = item.optLong("runtimeMs")
        Hint(
            "${if(runtime>0)"${runtime/60000}:${(runtime/1000%60).toString().padStart(2,'0')}"else"时长待更新"} · ${visibilityLabel(item)}"
        )
        PrimaryAction("在手机上播放", Icons.Outlined.PlayArrow, enabled = item.optBoolean("ready")) {
            context.startActivity(
                Intent(context, PlayerActivity::class.java)
                    .putExtra("id", item.getString("id"))
                    .putExtra("name", item.getString("name"))
            )
        }
        if (item.optString("overview").isNotBlank()) Hint(item.optString("overview"))
        if (model.canManage)
            PrimaryAction(
                if (item.optString("status") == "published") "改为仅家长可看" else "允许孩子观看",
                enabled = !busy && item.optBoolean("ready"),
            ) {
                publishing = true
            }
        if (!item.optBoolean("ready")) Hint("视频还在处理中，完成后即可播放。下拉可以刷新状态。")
        failure?.let { RetryMessage(it) { revision++ } }
    }
    if (managing)
        ModalBottomSheet(onDismissRequest = { managing = false }) {
            Column(
                Modifier.verticalScroll(rememberScrollState())
                    .padding(24.dp)
                    .navigationBarsPadding(),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                ResourceActions(model, item) {
                    managing = false
                    revision++
                }
            }
        }
    if (publishing)
        AlertDialog(
            onDismissRequest = { publishing = false },
            title = {
                Text(if (item.optString("status") == "published") "改为仅家长可看？" else "允许孩子观看？")
            },
            text = {
                Text(
                    if (item.optString("status") == "published")
                        "「${item.getString("name")}」将不再显示在孩子的电视上，你仍可在手机上观看。"
                    else "孩子可在已绑定的电视上观看「${item.getString("name")}」。所在合集也需要允许孩子观看。"
                )
            },
            confirmButton = {
                QuietAction("确认") {
                    publishing = false
                    scope.launch {
                        busy = true
                        try {
                            item =
                                withContext(Dispatchers.IO) {
                                    api.request(
                                        "/api/manage/resources/${ParentApi.segment(item.getString("id"))}/${if(item.optString("status")=="published")"unpublish"else"publish"}",
                                        "POST",
                                    )
                                }
                        } catch (e: Exception) {
                            if (e is CancellationException) throw e
                            failure = e.message
                        } finally {
                            busy = false
                        }
                    }
                }
            },
            dismissButton = { QuietAction("取消") { publishing = false } },
        )
}

@Composable
internal fun TrashScreen(model: ParentViewModel, back: () -> Unit) {
    var items by remember { mutableStateOf<List<JSONObject>>(emptyList()) }
    var page by remember { mutableIntStateOf(0) }
    var total by remember { mutableIntStateOf(0) }
    var more by remember { mutableStateOf(false) }
    var retention by remember { mutableIntStateOf(7) }
    var failure by remember { mutableStateOf<String?>(null) }
    var deleting by remember { mutableStateOf<JSONObject?>(null) }
    var revision by remember { mutableIntStateOf(0) }
    var busy by remember { mutableStateOf<Set<String>>(emptySet()) }
    var loading by remember { mutableStateOf(false) }
    var requestGeneration by remember { mutableIntStateOf(0) }
    val api = model.api!!
    val scope = rememberCoroutineScope()
    suspend fun load(next: Int) {
        if (next > 1 && loading) return
        val request = ++requestGeneration
        loading = true
        try {
            val last = if (next == 1) maxOf(1, page) else next
            val result =
                withContext(Dispatchers.IO) {
                    val all = mutableListOf<JSONObject>()
                    var response = JSONObject()
                    for (number in (if (next == 1) 1 else next)..last) {
                        response = api.request("/api/manage/trash?page=$number")
                        ensureActive()
                        all.addAll(response.getJSONArray("items").objects())
                        if (number * response.getInt("pageSize") >= response.getInt("total")) break
                    }
                    response to all
                }
            if (request != requestGeneration || api !== model.api) return
            items =
                (if (next == 1) result.second else items + result.second).distinctBy {
                    it.getString("id")
                }
            val response = result.first
            page = response.getInt("page")
            total = response.getInt("total")
            retention = response.getInt("retentionDays")
            more = page * response.getInt("pageSize") < total
            failure = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (request == requestGeneration) failure = e.message
        } finally {
            if (request == requestGeneration) loading = false
        }
    }
    LaunchedEffect(api, revision, model.deletionChange) { load(1) }
    DetailFrame("最近删除", back, refreshing = loading && page > 0, onRefresh = { revision++ }) {
        if (page == 0 && failure == null) StorageSkeleton()
        if (page > 0 && items.isEmpty()) Hint("最近没有删除内容")
        items.forEach { item ->
            val id = item.getString("id")
            val job = model.deletionJobs[id]
            val pending =
                job?.optString("status") == "pending" ||
                    (job == null &&
                        item.optBoolean("deleting") &&
                        item.optString("error").isEmpty())
            val error = job?.optString("error") ?: item.optString("error")
            SurfaceBlock {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(item.getString("name"), style = MaterialTheme.typography.titleMedium)
                    Hint(
                        if (pending) "正在删除，可离开此页面"
                        else if (item.optBoolean("deleting")) "删除未完成，可重试"
                        else if (!item.isNull("deleteAt"))
                            "计划于 ${item.getString("deleteAt").take(10)} 自动删除"
                        else "保留至手动删除"
                    )
                    if (item.optString("type") != "Episode")
                        Hint("包含 ${item.optInt("videoCount")} 个视频")
                    if (error.isNotEmpty()) ErrorMessage(error)
                    if (model.canManage)
                        Row {
                            QuietAction(
                                "恢复",
                                job == null && !item.optBoolean("deleting") && id !in busy,
                            ) {
                                scope.launch {
                                    busy = busy + id
                                    try {
                                        withContext(Dispatchers.IO) {
                                            api.request(
                                                "/api/manage/trash/${ParentApi.segment(id)}/restore",
                                                "POST",
                                            )
                                        }
                                        load(1)
                                    } catch (e: Exception) {
                                        if (e is CancellationException) throw e
                                        failure = e.message
                                    } finally {
                                        busy = busy - id
                                    }
                                }
                            }
                            Spacer(Modifier.weight(1f))
                            QuietAction(
                                if (error.isEmpty()) "彻底删除" else "重试删除",
                                !pending && id !in busy,
                            ) {
                                deleting = item
                            }
                        }
                }
            }
        }
        if (more) QuietAction("加载更多", !loading) { scope.launch { load(page + 1) } }
        Hint(
            (if (retention == 0) "已删除的内容保留至手动清理。" else "删除后保留 $retention 天，到期自动清理。") +
                "恢复后沿用删除前的观看设置。"
        )
        failure?.let { RetryMessage(it) { revision++ } }
    }
    deleting?.let { item ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text("彻底删除？") },
            text = { Text("「${item.getString("name")}」将永久删除，无法恢复。") },
            confirmButton = {
                QuietAction("彻底删除") {
                    deleting = null
                    scope.launch {
                        val id = item.getString("id")
                        busy = busy + id
                        try {
                            val result =
                                withContext(Dispatchers.IO) {
                                    api.request(
                                        "/api/manage/trash/${ParentApi.segment(id)}",
                                        "DELETE",
                                    )
                                }
                            if (result.optBoolean("deleting")) model.trackDeletion(id)
                            load(1)
                        } catch (e: Exception) {
                            if (e is CancellationException) throw e
                            failure = e.message
                        } finally {
                            busy = busy - id
                        }
                    }
                }
            },
            dismissButton = { QuietAction("取消") { deleting = null } },
        )
    }
}

internal suspend fun sendArtwork(api: ParentApi, data: ByteArray, item: String) =
    withContext(Dispatchers.IO) {
        require(data.isNotEmpty() && data.size <= 20 * 1024 * 1024)
        var upload =
            api.request(
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
        try {
            if (upload.optString("status") == "uploading") {
                val oss = upload.getString("transport") == "oss"
                val partSize = if (oss) upload.getInt("partSize") else 4 * 1024 * 1024
                require(partSize in 1..8 * 1024 * 1024)
                var offset = if (oss) 0 else upload.getInt("offset")
                var number = 1
                while (offset < data.size) {
                    ensureActive()
                    val end = minOf(offset + partSize, data.size)
                    val chunk = data.copyOfRange(offset, end)
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
                        require(upload.getInt("offset") == end)
                    }
                    offset = end
                    number++
                }
                upload = api.request("$path/complete", "POST")
            }
            repeat(30) {
                if (upload.optString("status") == "ready") return@withContext
                if (upload.optString("status") == "failed") error(upload.optString("error"))
                delay(1000)
                upload = api.request(path)
            }
            throw ApiFailure(409, "封面已上传，仍在处理中，可稍后返回资料库查看。")
        } catch (e: Exception) {
            if (upload.optString("status") == "uploading")
                runCatching { api.request("$path/cancel", "POST") }
            throw e
        }
    }
