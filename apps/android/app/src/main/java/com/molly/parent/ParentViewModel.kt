package com.molly.parent

import android.app.Application
import android.net.Uri
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.util.UUID
import kotlinx.coroutines.*
import org.json.JSONObject

/** Session and requests survive configuration changes; each list rejects stale responses. */
class ParentViewModel
@JvmOverloads
constructor(
    application: Application,
    private val io: CoroutineDispatcher = Dispatchers.IO,
    private val clock: () -> Long = { android.os.SystemClock.elapsedRealtime() },
) : AndroidViewModel(application) {
    private val app = application as ParentApplication
    var session by mutableStateOf(app.session)
        private set

    var accounts by mutableStateOf(app.vault.records())
        private set

    var libraryChange by mutableIntStateOf(0)
        private set

    var deletionChange by mutableIntStateOf(0)
        private set

    var deletionJobs by mutableStateOf<Map<String, JSONObject>>(emptyMap())
        private set

    private var deletionRevision = 0
    private var deletionJob: Job? = null
    var restoring by mutableStateOf(session == null)
        private set

    var server by mutableStateOf(app.api?.endpoint?.origin?.toString() ?: "https://mollytime.app")
    var loginError by mutableStateOf<String?>(null)
        private set

    var loginBusy by mutableStateOf(false)
        private set

    var tab by mutableStateOf(0)
    var folder by mutableStateOf<JSONObject?>(null)
        private set

    private val parents = mutableListOf<JSONObject?>()
    var resources by mutableStateOf<List<JSONObject>>(emptyList())
        private set

    var total by mutableStateOf(0)
        private set

    var page by mutableStateOf(0)
        private set

    var hasMore by mutableStateOf(false)
        private set

    var libraryBusy by mutableStateOf(false)
        private set

    var libraryError by mutableStateOf<String?>(null)
        private set

    var devices by mutableStateOf<List<JSONObject>>(emptyList())
        private set

    var devicesLoaded by mutableStateOf(false)
        private set

    var devicesBusy by mutableStateOf(false)
        private set

    var devicesError by mutableStateOf<String?>(null)
        private set

    var pinSet by mutableStateOf(false)
        private set

    var watchConflictRevision by mutableIntStateOf(0)
        private set

    private var conflictNeedsRebase = false
    var settings by mutableStateOf<JSONObject?>(null)
        private set

    var storageBusy by mutableStateOf(false)
        private set

    var storageError by mutableStateOf<String?>(null)
        private set

    var operation by mutableStateOf<String?>(null)
        private set

    var notice by mutableStateOf<String?>(null)
    var uploadState by mutableStateOf(app.uploads.state.value)
        private set

    val uploads
        get() = app.uploads

    val reminderUploads
        get() = app.reminderUploads

    val uploadMessage
        get() =
            uploadState
                ?.takeUnless { it.optBoolean("completed") && it.optString("error").isEmpty() }
                ?.optString("phase")

    val uploadRunning
        get() = uploadState?.optBoolean("busy") == true

    val uploadError
        get() = !uploadState?.optString("error").isNullOrBlank()

    var accountGeneration by mutableIntStateOf(0)
        private set

    private var libraryJob: Job? = null
    private var deviceJob: Job? = null
    private var storageJob: Job? = null
    private var uploadJob: Job? = null
    var reordering by mutableStateOf(false)
        private set

    private var reorderDirty = false
    private var uploadEpoch = 0
    val startup = StartupExperience(app)
    private var foreground = false
    private var foregroundJob: Job? = null
    private var controlsJob: Job? = null
    private var statisticsJob: Job? = null
    private var storageRevision = 0
    private var storageAppliedRevision = -1
    private var storageUpdatedAt = 0L
    private val catalogs = linkedMapOf<String, CatalogSnapshot>()
    private var libraryRevision = 0

    private data class CatalogSnapshot(
        val items: List<JSONObject>,
        val total: Int,
        val page: Int,
        val more: Boolean,
        val savedAt: Long,
        val revision: Int,
        val currentFolder: JSONObject? = null,
    )

    var watch by mutableStateOf<JSONObject?>(null)
        private set

    var statisticsError by mutableStateOf<String?>(null)
        private set

    private var deviceBases = emptyList<JSONObject>()

    private fun now() = clock()

    private fun folderKey() = folder?.getString("id") ?: "root"

    val api
        get() = app.api

    val canManage
        get() = app.canManage

    val hasPendingUpload
        get() =
            listOf(app.uploads.state.value, app.reminderUploads.state.value).any {
                it?.has("file") == true && !it.optBoolean("completed")
            }

    val hasActiveUpload
        get() = uploadState?.optBoolean("completed") != true && uploadState != null

    init {
        viewModelScope.launch {
            var previous = ""
            app.uploads.state.collect { value ->
                uploadState = value
                val status = value?.optJSONObject("upload")?.optString("status").orEmpty()
                if (status != previous && status in listOf("ready", "failed", "cancelled")) {
                    libraryRevision++
                    libraryChange++
                    storageRevision++
                    if (foreground) {
                        loadLibrary()
                        loadStorage()
                    }
                }
                previous = status
            }
        }
        if (session == null) restore() else attach(api!!)
    }

    private fun attach(client: ParentApi) {
        client.onUnauthorized = {
            viewModelScope.launch {
                if (api === client) {
                    clearSession(true)
                    loginError = "登录已过期，请重新登录"
                }
            }
        }
        client.onMutation = { invalidation ->
            viewModelScope.launch {
                if (api !== client) return@launch
                if (invalidation.library) {
                    libraryRevision++
                    libraryChange++
                    if (foreground && !reordering) loadLibrary()
                }
                if (invalidation.storage) {
                    storageRevision++
                    if (foreground) loadStorage()
                }
                if (invalidation.devices) {
                    if (foreground) loadDevices() else devicesLoaded = false
                }
            }
        }
        if (foreground) {
            client.artworkUploads.resume()
            app.uploads.resumeAutomatically()
            app.reminderUploads.resumeAutomatically()
            startSync()
        }
    }

    fun foreground(active: Boolean) {
        if (foreground == active) return
        foreground = active
        if (active) {
            if (session != null) {
                api?.artworkUploads?.resume()
                app.uploads.resumeAutomatically()
                app.reminderUploads.resumeAutomatically()
                storageRevision++
                startSync()
                if (tab == 1) {
                    loadDevices()
                    loadStatistics()
                }
                if (
                    tab == 0 &&
                        page > 0 &&
                        catalogs[folderKey()]?.let { now() - it.savedAt >= 60_000 } == true
                )
                    loadLibrary()
            }
        } else {
            startup.stop()
            foregroundJob?.cancel()
            controlsJob?.cancel()
            statisticsJob?.cancel()
            pendingUploadJob?.cancel()
            deletionJob?.cancel()
        }
    }

    private fun startSync() {
        foregroundJob?.cancel()
        foregroundJob =
            viewModelScope.launch {
                launch {
                    while (isActive) {
                        loadStorage()
                        delay(60_000)
                    }
                }
                launch {
                    while (isActive) {
                        if (tab == 1 && devicesLoaded && operation == null) refreshControls()
                        delay(5_000)
                    }
                }
                launch {
                    while (isActive) {
                        checkPendingUpload()
                        delay(5_000)
                    }
                }
                launch {
                    while (isActive) {
                        pollDeletions()
                        delay(
                            if (deletionJobs.values.any { it.optString("status") == "pending" })
                                2000
                            else 30000
                        )
                    }
                }
            }
    }

    override fun onCleared() {
        startup.stop()
        api?.onMutation = null
        api?.onUnauthorized = null
        super.onCleared()
    }

    fun restore() {
        restoring = true
        loginError = null
        viewModelScope.launch {
            try {
                val saved = withContext(io) { app.vault.read() }
                if (saved != null) {
                    server = saved.getString("origin")
                    val client = app.candidate(server, saved.getString("cookie"))
                    val value = withContext(io) { client.restore() }
                    if (session != null && api !== client) resetForSwitch()
                    app.activate(client, value)
                    session = value
                    accounts = app.vault.records()
                    accountGeneration++
                    attach(client)
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                if (e is ApiFailure && e.status == 401) {
                    app.clear(true)
                    accounts = app.vault.records()
                }
                loginError =
                    if (e is ApiFailure && e.status == 401) "登录已过期，请重新登录" else "暂时无法恢复登录，请检查网络后重试"
            } finally {
                restoring = false
            }
        }
    }

    fun login(username: String, password: String) {
        if (loginBusy) return
        if (username.isBlank() || password.isEmpty()) {
            loginError = "请输入账号和密码"
            return
        }
        loginBusy = true
        loginError = null
        viewModelScope.launch {
            try {
                val client = app.candidate(server)
                val value = withContext(io) { client.login(username.trim(), password) }
                if (session != null && api !== client) resetForSwitch()
                app.activate(client, value)
                session = value
                accounts = app.vault.records()
                accountGeneration++
                attach(client)
                tab = 0
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                loginError = e.message ?: "登录失败，请稍后重试"
            } finally {
                loginBusy = false
            }
        }
    }

    fun ensureTab() {
        when (tab) {
            0 -> if (page == 0 && !libraryBusy) loadLibrary()
            1 -> {
                if (!devicesLoaded && !devicesBusy) loadDevices()
                else if (devicesLoaded) refreshControls()
                loadStatistics()
            }
            2 -> if (settings == null && !storageBusy) loadStorage()
        }
    }

    fun refresh() {
        when (tab) {
            0 -> loadLibrary()
            1 -> loadDevices()
            2 -> loadStorage()
        }
    }

    fun openFolder(item: JSONObject) {
        parents.add(folder)
        folder = item
        resetLibrary()
    }

    fun back(): Boolean {
        if (tab == 0 && folder != null) {
            folder = if (parents.isEmpty()) null else parents.removeAt(parents.lastIndex)
            resetLibrary()
            return true
        }
        if (tab != 0) {
            tab = 0
            return true
        }
        return false
    }

    private fun resetLibrary() {
        libraryJob?.cancel()
        libraryBusy = false
        libraryError = null
        val cached = catalogs[folderKey()]
        resources = cached?.items.orEmpty()
        total = cached?.total ?: 0
        page = cached?.page ?: 0
        hasMore = cached?.more ?: false
        if (
            cached == null || cached.revision != libraryRevision || now() - cached.savedAt >= 60_000
        )
            loadLibrary()
    }

    fun loadLibrary(more: Boolean = false) {
        if (more && (libraryBusy || !hasMore)) return
        if (reordering) {
            reorderDirty = true
            return
        }
        libraryJob?.cancel()
        val client = api ?: return
        val folderId = folder?.getString("id")
        val key = folderKey()
        val revision = libraryRevision
        val next = if (more) page + 1 else 1
        val through = if (more) next else maxOf(1, page)
        libraryBusy = true
        libraryError = null
        libraryJob =
            viewModelScope.launch {
                try {
                    val result =
                        withContext(io) {
                            val all = mutableListOf<JSONObject>()
                            var result: JSONObject
                            var number = next
                            do {
                                result = client.resources(folderId, number)
                                ensureActive()
                                all.addAll(result.getJSONArray("items").objects())
                                if (number * result.getInt("pageSize") >= result.getInt("total"))
                                    break
                                number++
                            } while (number <= through)
                            CatalogSnapshot(
                                all,
                                result.getInt("total"),
                                minOf(number, through),
                                minOf(number, through) * result.getInt("pageSize") <
                                    result.getInt("total"),
                                now(),
                                revision,
                                folderId?.let {
                                    client.request("/api/manage/resources/${ParentApi.segment(it)}")
                                },
                            )
                        }
                    if (api !== client || folderKey() != key || libraryRevision != revision)
                        return@launch
                    result.currentFolder?.let {
                        if (it.optString("status") == "archived") {
                            back()
                            return@launch
                        }
                        folder = it
                    }
                    resources = if (more) resources + result.items else result.items
                    page = result.page
                    total = result.total
                    hasMore = result.more
                    catalogs[key] = result.copy(items = resources)
                    while (catalogs.size > 24) catalogs.remove(catalogs.keys.first())
                } catch (e: Exception) {
                    failure(e, client) { libraryError = it }
                } finally {
                    if (isActive) libraryBusy = false
                }
            }
    }

    fun loadDevices() {
        deviceJob?.cancel()
        controlsJob?.cancel()
        val client = api ?: return
        devicesBusy = true
        devicesError = null
        deviceJob =
            viewModelScope.launch {
                try {
                    val result =
                        withContext(io) {
                            val all = mutableListOf<JSONObject>()
                            var page = 1
                            while (true) {
                                val response =
                                    client.request(
                                        "/api/manage/devices?page=$page&pageSize=100&activeOnly=true"
                                    )
                                ensureActive()
                                all.addAll(response.getJSONArray("items").objects())
                                if (page * response.getInt("pageSize") >= response.getInt("total"))
                                    break
                                page++
                            }
                            all to client.request("/api/manage/watch-control")
                        }
                    if (api !== client) return@launch
                    deviceBases = result.first
                    applyControls(result.second)
                    devicesLoaded = true
                    if (conflictNeedsRebase) {
                        conflictNeedsRebase = false
                        watchConflictRevision++
                    }
                    if (foreground) refreshControls()
                } catch (e: Exception) {
                    failure(e, client) { devicesError = it }
                } finally {
                    if (isActive) devicesBusy = false
                }
            }
    }

    private fun applyControls(value: JSONObject, reminders: List<JSONObject> = emptyList()) {
        val controls =
            value.getJSONArray("devices").objects().associateBy { it.getString("deviceId") }
        val reminderMap = reminders.associateBy { it.getString("id") }
        devices =
            deviceBases.map { base ->
                JSONObject(base.toString()).apply {
                    val id = base.getString("id")
                    put("deviceId", id)
                    controls[id]?.let { control ->
                        control.keys().forEach { key -> put(key, control.get(key)) }
                    }
                    reminderMap[id]?.let { put("reminder", it) }
                }
            }
        pinSet = value.optBoolean("pinSet")
    }

    fun refreshControls() {
        if (controlsJob?.isActive == true || operation != null) return
        val client = api ?: return
        controlsJob =
            viewModelScope.launch {
                try {
                    val result =
                        withContext(io) {
                            val controls = client.request("/api/manage/watch-control")
                            val reminders =
                                org.json
                                    .JSONArray(
                                        client
                                            .raw(
                                                "/api/manage/reminders/devices",
                                                "GET",
                                                null,
                                                "application/json",
                                            )
                                            .toString(Charsets.UTF_8)
                                    )
                                    .objects()
                            controls to reminders
                        }
                    if (api === client) {
                        applyControls(result.first, result.second)
                        devicesError = null
                    }
                } catch (e: Exception) {
                    failure(e, client) { devicesError = "电视状态暂未更新：$it" }
                }
            }
    }

    fun loadStatistics() {
        statisticsJob?.cancel()
        val client = api ?: return
        statisticsJob =
            viewModelScope.launch {
                while (isActive) {
                    try {
                        val result =
                            withContext(io) {
                                client.request("/api/manage/overview").getJSONObject("watch")
                            }
                        if (api !== client) return@launch
                        watch = result
                        statisticsError = null
                        if (!result.optBoolean("summaryUpdating")) return@launch
                    } catch (e: Exception) {
                        if (e is CancellationException) throw e
                        if (e is ApiFailure && e.status == 503) {
                            delay(2000)
                            continue
                        }
                        failure(e, client) { statisticsError = it }
                        return@launch
                    }
                    delay(2000)
                }
            }
    }

    fun loadStorage() {
        if (storageJob?.isActive == true) return
        if (
            settings != null &&
                storageRevision == storageAppliedRevision &&
                now() - storageUpdatedAt < 60_000
        )
            return
        val client = api ?: return
        storageBusy = true
        storageJob =
            viewModelScope.launch {
                try {
                    while (isActive && api === client) {
                        val revision = storageRevision
                        val result =
                            try {
                                withContext(io) { client.request("/api/manage/settings") }
                            } catch (e: Exception) {
                                if (e is CancellationException) throw e
                                if (revision != storageRevision && api === client) continue
                                throw e
                            }
                        if (api !== client) return@launch
                        if (revision != storageRevision) continue
                        settings = result
                        storageAppliedRevision = revision
                        storageUpdatedAt = now()
                        storageError = null
                        return@launch
                    }
                } catch (e: Exception) {
                    failure(e, client) { storageError = it }
                } finally {
                    if (api === client) storageBusy = false
                }
            }
    }

    private fun failure(e: Exception, client: ParentApi, show: (String) -> Unit) {
        if (e is CancellationException) throw e
        if (api !== client) return
        if (e is ApiFailure && e.status == 401) {
            clearSession(true)
            loginError = "登录已过期，请重新登录"
        } else show(e.message ?: "网络请求失败，请重试")
    }

    private fun clearSession(expired: Boolean = false) {
        libraryJob?.cancel()
        deviceJob?.cancel()
        storageJob?.cancel()
        uploadJob?.cancel()
        foregroundJob?.cancel()
        controlsJob?.cancel()
        statisticsJob?.cancel()
        deletionJob?.cancel()
        deletionRevision++
        deletionJobs = emptyMap()
        reordering = false
        catalogs.clear()
        watch = null
        statisticsError = null
        deviceBases = emptyList()
        storageRevision = 0
        storageAppliedRevision = -1
        storageUpdatedAt = 0
        pendingUploadJob?.cancel()
        uploadEpoch++
        libraryBusy = false
        devicesBusy = false
        storageBusy = false
        libraryError = null
        devicesError = null
        storageError = null
        app.clear(expired)
        accounts = app.vault.records()
        accountGeneration++
        session = null
        resources = emptyList()
        devices = emptyList()
        settings = null
        page = 0
        folder = null
        parents.clear()
        devicesLoaded = false
    }

    fun mutate(
        path: String,
        method: String = "POST",
        body: JSONObject = JSONObject(),
        done: () -> Unit = {},
    ) {
        runOperation("正在保存") { client ->
            withContext(io) { client.request(path, method, body) }
            done()
        }
    }

    private fun runOperation(label: String, work: suspend (ParentApi) -> Unit) {
        if (operation != null) return
        val client = api ?: return
        controlsJob?.cancel()
        operation = label
        viewModelScope.launch {
            try {
                work(client)
            } catch (e: Exception) {
                failure(e, client) {
                    if (e is ApiFailure && e.status == 409 && label == "正在保存观看安排") {
                        conflictNeedsRebase = true
                        loadDevices()
                        refresh()
                        notice = "$it\n已刷新当前状态，请确认后再操作。"
                    } else notice = it
                }
            } finally {
                operation = null
            }
        }
    }

    fun previewPairing(input: String, show: (String, String) -> Unit) {
        val code = api?.endpoint?.pairingCode(input)
        if (code == null) {
            notice = "请输入四位数字绑定码，或当前服务的配对链接"
            return
        }
        runOperation("正在查找电视") { client ->
            val result = withContext(io) { client.request("/api/manage/pairing/$code") }
            show(code, result.getString("name"))
        }
    }

    fun watchCommand(device: JSONObject, action: String) =
        runOperation("正在保存观看安排") { client ->
            withContext(io) {
                client.request(
                    "/api/manage/watch-control/${ParentApi.segment(device.getString("deviceId"))}/commands",
                    "POST",
                    command(device, action),
                )
            }
        }

    private fun command(device: JSONObject, action: String) =
        json(
            "requestId" to UUID.randomUUID().toString(),
            "version" to device.getInt("version"),
            "action" to action,
        )

    fun saveWatch(
        device: JSONObject,
        enabled: Boolean,
        mode: String,
        amount: Int,
        pin: String,
        done: () -> Unit,
    ) {
        runOperation("正在保存观看安排") { client ->
            val needsPin = enabled && !pinSet
            withContext(io) {
                if (needsPin)
                    client.request("/api/manage/watch-control/pin", "PUT", json("pin" to pin))
                client.request(
                    "/api/manage/watch-control/${ParentApi.segment(device.getString("deviceId"))}/commands",
                    "POST",
                    command(device, "settings")
                        .put("enabled", enabled)
                        .put("mode", mode)
                        .put("amount", amount),
                )
            }
            if (needsPin) pinSet = true
            done()
            loadDevices()
        }
    }

    fun switchAccount(record: JSONObject, done: () -> Unit, relogin: (JSONObject) -> Unit = {}) {
        if (operation != null) return
        if (record.optBoolean("needsLogin")) {
            relogin(record)
            return
        }
        operation = "正在切换账号"
        viewModelScope.launch {
            try {
                val client = app.candidate(record.getString("origin"), record.getString("cookie"))
                val value = withContext(io) { client.restore() }
                resetForSwitch()
                app.activate(client, value)
                session = value
                server = client.endpoint.origin.toString()
                accounts = app.vault.records()
                accountGeneration++
                attach(client)
                tab = 0
                done()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e is ApiFailure && e.status == 401) {
                    app.vault.needsLogin(record.getString("key"))
                    accounts = app.vault.records()
                    relogin(record)
                } else notice = e.message ?: "暂时无法切换账号，请稍后重试。"
            } finally {
                operation = null
            }
        }
    }

    private fun resetForSwitch() {
        libraryJob?.cancel()
        deviceJob?.cancel()
        storageJob?.cancel()
        controlsJob?.cancel()
        statisticsJob?.cancel()
        pendingUploadJob?.cancel()
        deletionJob?.cancel()
        catalogs.clear()
        reordering = false
        reorderDirty = false
        libraryError = null
        devicesError = null
        storageError = null
        statisticsError = null
        conflictNeedsRebase = false
        watchConflictRevision = 0
        pinSet = false
        resources = emptyList()
        page = 0
        folder = null
        parents.clear()
        settings = null
        storageRevision = 0
        storageAppliedRevision = -1
        storageUpdatedAt = 0
        devices = emptyList()
        deviceBases = emptyList()
        devicesLoaded = false
        watch = null
        deletionJobs = emptyMap()
        deletionRevision++
        libraryBusy = false
        devicesBusy = false
        storageBusy = false
    }

    fun forgetAccount(record: JSONObject) {
        if (
            record.optString("origin") == api?.endpoint?.origin.toString() &&
                record.optJSONObject("session")?.optJSONObject("user")?.optString("id") ==
                    session?.optJSONObject("user")?.optString("id")
        )
            return
        app.vault.forget(record.getString("key"))
        accounts = app.vault.records()
    }

    suspend fun updateProfile(name: String, avatar: String?) {
        val client = api ?: return
        val value =
            withContext(io) {
                client.request(
                    "/api/manage/auth/profile",
                    "PUT",
                    json("displayName" to name, "avatarJPEGBase64" to avatar),
                )
            }
        if (api === client) {
            app.activate(client, value)
            session = value
            client.csrf = value.getString("csrfToken")
            accounts = app.vault.records()
        }
    }

    fun trackDeletion(id: String) {
        deletionRevision++
        deletionJobs = deletionJobs + (id to json("id" to id, "status" to "pending", "error" to ""))
        pollDeletions()
    }

    private fun pollDeletions() {
        if (deletionJob?.isActive == true) return
        val client = api ?: return
        val revision = deletionRevision
        deletionJob =
            viewModelScope.launch {
                try {
                    val list =
                        withContext(io) {
                            org.json
                                .JSONArray(
                                    client
                                        .raw(
                                            "/api/manage/trash/deletions",
                                            "GET",
                                            null,
                                            "application/json",
                                        )
                                        .toString(Charsets.UTF_8)
                                )
                                .objects()
                        }
                    if (api !== client || revision != deletionRevision) return@launch
                    val next = list.associateBy { it.getString("id") }
                    val settled =
                        deletionJobs.any { (id, old) ->
                            next[id] == null ||
                                (old.optString("status") == "pending" &&
                                    next[id]?.optString("status") != "pending")
                        }
                    deletionJobs = next
                    if (settled) {
                        deletionChange++
                        libraryChange++
                        libraryRevision++
                        storageRevision++
                        loadStorage()
                        if (tab == 0) loadLibrary()
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {}
            }
    }

    fun updateReordering(value: Boolean) {
        reordering = value
        if (value) {
            libraryJob?.cancel()
            libraryBusy = false
            reorderDirty = false
        } else if (reorderDirty) {
            reorderDirty = false
            loadLibrary()
        }
    }

    suspend fun reorder(source: Int, target: Int) {
        val client = api ?: return
        val previous = resources
        require(source in previous.indices && target in previous.indices)
        if (source == target) return
        reorderDirty = true
        val reordered = previous.toMutableList()
        val moved = reordered.removeAt(source)
        reordered.add(target, moved)
        resources = reordered
        catalogs[folderKey()]?.let {
            catalogs[folderKey()] = it.copy(items = reordered, revision = libraryRevision)
        }
        val body =
            if (target < reordered.lastIndex)
                json("beforeId" to reordered[target + 1].getString("id"))
            else json("afterId" to reordered[target - 1].getString("id"))
        try {
            withContext(io) {
                client.request(
                    "/api/manage/resources/${ParentApi.segment(moved.getString("id"))}/position",
                    "PUT",
                    body,
                )
            }
        } catch (e: Exception) {
            if (e is CancellationException) throw e
            if (api === client) {
                loadLibrary()
                notice = "未能确认排序，已重新读取资料库的实际顺序。"
            }
        }
    }

    fun logout() =
        runOperation("正在退出登录") { client ->
            withContext(io) { client.request("/api/manage/auth/logout", "POST") }
            clearSession()
        }

    private var pendingUploadJob: Job? = null

    private fun checkPendingUpload() {
        if (pendingUploadJob?.isActive == true) return
        pendingUploadJob =
            viewModelScope.launch {
                if (app.uploads.pending && !app.uploads.busy) app.uploads.checkCompletion()
                if (app.reminderUploads.pending && !app.reminderUploads.busy)
                    app.reminderUploads.checkCompletion()
            }
    }

    fun startUpload(uri: Uri) {
        app.uploads.prepare(uri, false, folder)
    }

    fun cancelUpload() {
        viewModelScope.launch {
            try {
                app.uploads.cancel()
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                notice = e.message
            }
        }
    }

    fun clearUpload() {
        if (uploadState?.optBoolean("completed") == true) app.uploads.clear()
    }
}
