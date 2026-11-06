package com.molly.parent

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.compose.runtime.*
import androidx.lifecycle.AndroidViewModel
import java.io.File

/**
 * One update operation survives rotation; callbacks from another server or cancelled work are
 * ignored.
 */
class UpdateViewModel
@JvmOverloads
constructor(
    application: Application,
    private val client: ClientUpdates = (application as ParentApplication).updates,
) : AndroidViewModel(application) {
    private val app = application as ParentApplication
    private val main = Handler(Looper.getMainLooper())
    private var epoch = 0
    private var operation = ClientUpdates.Operation()
    private var server = ""
    private var checked = ""
    private var file: File? = null
    var release by mutableStateOf<ClientUpdates.Release?>(null)
        private set

    var stage by mutableStateOf("idle")
        private set

    var message by mutableStateOf("")
        private set

    var received by mutableLongStateOf(0)
        private set

    var visible by mutableStateOf(false)
        private set

    private var permissionPending = false
    val busy
        get() = stage in listOf("checking", "downloading", "installing")

    fun check(source: String, manual: Boolean = false) {
        val origin = runCatching { Endpoint(source).origin.toString() }.getOrNull() ?: return
        if (origin != server) {
            cancel()
            server = origin
            checked = ""
            release = null
            file = null
            visible = false
            stage = "idle"
        }
        if (manual) visible = true
        if (busy || (!manual && checked == origin)) return
        checked = origin
        stage = "checking"
        message = "正在检查更新…"
        val token = ++epoch
        client.executor.execute {
            val result = runCatching { client.check(origin) }
            main.post {
                if (token == epoch) {
                    result.fold(
                        onSuccess = { value ->
                            release = value
                            file = null
                            stage = if (value == null) "latest" else "available"
                            message =
                                if (value == null) "当前已是最新版本" else "发现新版本 ${value.versionName}"
                            visible = manual || value != null
                        },
                        onFailure = { error ->
                            stage = "error"
                            message = error.message ?: "暂时无法检查更新"
                            visible = manual
                        },
                    )
                }
            }
        }
    }

    fun show(source: String) {
        if (release != null && source.trimEnd('/') == server.trimEnd('/')) visible = true
        else check(source, true)
    }

    fun download() {
        val value = release ?: return
        if (busy) return
        stage = "downloading"
        message = "正在下载更新…"
        received = 0
        operation = ClientUpdates.Operation()
        val active = operation
        val token = ++epoch
        client.executor.execute {
            val result = runCatching {
                client.download(value, active) { bytes ->
                    main.post { if (token == epoch) received = bytes }
                }
            }
            main.post {
                if (token == epoch)
                    result.fold(
                        onSuccess = {
                            file = it
                            stage = "ready"
                            message = "更新包已校验，可以安装"
                        },
                        onFailure = {
                            stage = "error"
                            message = it.message ?: "下载未完成，可以重试"
                        },
                    )
            }
        }
    }

    fun cancel() {
        epoch++
        operation.cancel()
        if (stage == "downloading") {
            stage = "available"
            message = "下载已取消"
        }
        if (stage == "checking") stage = "idle"
    }

    fun dismiss() {
        if (stage in listOf("checking", "downloading")) cancel()
        visible = false
    }

    fun install(activity: Activity) {
        val value = release ?: return
        val apk = file ?: return
        if (stage == "installing") return
        if (!activity.packageManager.canRequestPackageInstalls()) {
            permissionPending = true
            try {
                activity.startActivity(
                    Intent(
                        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:${activity.packageName}"),
                    )
                )
                message = "请允许 MollyTime 安装应用，返回后继续"
            } catch (_: Exception) {
                permissionPending = false
                message = "请在系统设置中允许 MollyTime 安装应用"
            }
            return
        }
        stage = "installing"
        message = "正在准备安装…"
        ClientUpdateInstaller(activity).install(apk, value, operation) { text, waiting ->
            message = text
            stage = if (waiting) "awaiting" else "ready"
            visible = true
        }
    }

    fun permissionReturned(activity: Activity) {
        if (!permissionPending) return
        permissionPending = false
        if (activity.packageManager.canRequestPackageInstalls()) install(activity)
        else {
            stage = "ready"
            message = "尚未允许安装应用，更新包已保留"
        }
    }

    fun result(activity: Activity, intent: Intent) {
        if (intent.action != ClientUpdateInstaller.INSTALL_RESULT) return
        val prefs = app.getSharedPreferences("molly.updates", Activity.MODE_PRIVATE)
        val id = prefs.getInt("session", -1)
        val nonce = prefs.getString("nonce", null)
        if (
            id < 0 ||
                nonce == null ||
                nonce != intent.getStringExtra("nonce") ||
                intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1) != id
        )
            return
        val status =
            intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
        visible = true
        if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            @Suppress("DEPRECATION")
            val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
            if (confirm != null)
                runCatching { activity.startActivity(confirm) }
                    .onFailure {
                        stage = "ready"
                        message = "无法打开系统安装界面，可重试安装"
                    }
            else {
                stage = "ready"
                message = "系统没有提供安装确认界面，请重试"
            }
            return
        }
        prefs.edit().remove("session").remove("nonce").apply()
        stage = if (file != null) "ready" else "error"
        message =
            when (status) {
                PackageInstaller.STATUS_SUCCESS -> {
                    release = null
                    file = null
                    stage = "latest"
                    "更新已安装，请重新打开 MollyTime"
                }
                PackageInstaller.STATUS_FAILURE_ABORTED -> "尚未安装，更新包已保留"
                else -> "安装未完成（状态 $status），请重试；无需卸载当前应用"
            }
    }

    override fun onCleared() {
        operation.cancel()
        super.onCleared()
    }
}
