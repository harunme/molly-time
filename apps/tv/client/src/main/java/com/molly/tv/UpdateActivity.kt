package com.molly.tv

import android.app.PendingIntent
import android.app.ActivityOptions
import android.content.Intent
import android.content.pm.PackageInstaller
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Native, remote-friendly update UI. The webpage cannot supply an APK URL or file. */
class UpdateActivity : AppCompatActivity() {
    private val app get() = application as MollyTimeApplication
    private val prefs get() = getSharedPreferences("molly.updates", MODE_PRIVATE)
    private lateinit var status: TextView
    private lateinit var detail: TextView
    private lateinit var action: Button
    private lateinit var progress: ProgressBar
    private var release: ClientUpdates.Release? = null
    private var downloaded: File? = null
    private val operation = ClientUpdates.Operation()
    private var awaitingSettings = false
    private var installing = false

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(72, 48, 72, 40)
            setBackgroundColor(Color.rgb(15, 27, 46))
        }
        layout.addView(TextView(this).apply { text = "客户端更新"; textSize = 32f; setTextColor(Color.WHITE) })
        status = TextView(this).apply { textSize = 24f; setTextColor(Color.WHITE); setPadding(0, 24, 0, 16) }
        detail = TextView(this).apply { textSize = 18f; setTextColor(Color.LTGRAY); setPadding(0, 0, 0, 24) }
        progress = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply { max = 100; visibility = android.view.View.GONE }
        action = Button(this)
        layout.addView(status); layout.addView(detail); layout.addView(progress); layout.addView(action)
        layout.addView(Button(this).apply { text = "返回媒体库"; setOnClickListener { operation.cancel(); finish() } })
        setContentView(layout)
        if (intent.action == INSTALL_RESULT) handleInstallResult(intent)
        else {
            val saved = state?.getString("release") ?: intent.getStringExtra("release")
            release = saved?.let { runCatching { ClientUpdates.Release.parse(JSONObject(it)) }.getOrNull() }
            // After process recreation, recheck/download instead of resuming a stale install session.
            awaitingSettings = false
            if (release == null) checkUpdate() else offerRelease()
        }
    }

    private fun checkUpdate() {
        status.text = "正在检查更新…"
        detail.text = "当前版本 ${BuildConfig.VERSION_NAME}"
        action.isEnabled = false
        app.updates.executor.execute {
            val result = runCatching { app.updates.check(app.session.server) }
            ui {
                result.onSuccess { latest ->
                    release = latest
                    if (latest == null) {
                        status.text = "当前已是最新版本"
                        button("再次检查") { checkUpdate() }
                    } else offerRelease()
                }.onFailure { fail(it) }
            }
        }
    }

    private fun offerRelease() {
        val latest = release ?: return
        status.text = "发现新版本 ${latest.versionName}"
        detail.text = "当前版本 ${BuildConfig.VERSION_NAME} · 更新包 ${latest.size / (1024 * 1024)} MB\n${latest.notes}"
        button("下载更新") { download() }
    }

    private fun download() {
        val latest = release ?: return
        status.text = "正在下载更新…"
        action.isEnabled = false
        progress.visibility = android.view.View.VISIBLE
        app.updates.executor.execute {
            var lastPercent = -1
            val result = runCatching { app.updates.download(latest, operation) { received ->
                val percent = (received * 100 / latest.size).toInt()
                if (percent != lastPercent) { lastPercent = percent; ui { progress.progress = percent } }
            } }
            ui {
                progress.visibility = android.view.View.GONE
                result.onSuccess {
                    downloaded = it
                    status.text = "更新包已校验，可以安装"
                    button("安装更新") { requestInstall() }
                }.onFailure { fail(it) }
            }
        }
    }

    private fun requestInstall() {
        if (Build.VERSION.SDK_INT >= 26 && !packageManager.canRequestPackageInstalls()) {
            status.text = "请允许 MollyTime 安装应用，然后返回继续"
            button("允许安装应用") { requestInstall() }
            try {
                awaitingSettings = true
                startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName")))
            } catch (_: Exception) {
                awaitingSettings = false
                status.text = "电视未提供安装授权入口，请在系统设置中允许安装应用"
            }
            return
        }
        install()
    }

    private fun install() {
        if (installing) return
        val latest = release ?: return
        val file = downloaded ?: return
        installing = true
        action.isEnabled = false
        status.text = "正在准备安装…"
        app.updates.executor.execute {
            val installer = packageManager.packageInstaller
            var sessionId: Int? = null
            var committed = false
            try {
                operation.ensureActive()
                app.updates.verify(file, latest)
                // Abandon a previous interrupted attempt owned by this app.
                val previous = prefs.getInt("session", -1)
                if (previous >= 0) runCatching { installer.abandonSession(previous) }
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                    setAppPackageName(packageName)
                    setSize(latest.size)
                    if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
                }
                val id = installer.createSession(params)
                sessionId = id
                val nonce = UUID.randomUUID().toString()
                prefs.edit().putInt("session", id).putString("nonce", nonce).commit()
                val callback = Intent(this, UpdateActivity::class.java).setAction(INSTALL_RESULT)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra("nonce", nonce)
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
                // Android 15+ requires explicit creator opt-in for installation callbacks.
                @Suppress("DEPRECATION")
                val options = if (Build.VERSION.SDK_INT >= 35) ActivityOptions.makeBasic().apply {
                    setPendingIntentCreatorBackgroundActivityStartMode(
                        if (Build.VERSION.SDK_INT >= 36) ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOW_ALWAYS
                        else ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
                }.toBundle() else null
                val sender = PendingIntent.getActivity(this, id, callback, flags, options).intentSender
                installer.openSession(id).use { session ->
                    session.openWrite("base.apk", 0, latest.size).use { output ->
                        file.inputStream().use { input ->
                            val buffer = ByteArray(128 * 1024)
                            while (true) {
                                operation.ensureActive()
                                val count = input.read(buffer)
                                if (count < 0) break
                                output.write(buffer, 0, count)
                            }
                        }
                        session.fsync(output)
                    }
                    operation.ensureActive()
                    session.commit(sender)
                    committed = true
                }
                ui { status.text = "请在系统安装界面确认更新" }
            } catch (error: Exception) {
                ui { installing = false; fail(error) }
            } finally {
                if (!committed && sessionId != null) runCatching { installer.abandonSession(sessionId) }
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun handleInstallResult(result: Intent) {
        val id = result.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        if (id < 0 || id != prefs.getInt("session", -1) || result.getStringExtra("nonce") != prefs.getString("nonce", null)) {
            status.text = "安装结果已失效，请重新检查更新"
            button("检查更新") { checkUpdate() }
            return
        }
        when (result.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                val confirmation = result.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                try {
                    require(confirmation != null) { "系统安装界面不可用" }
                    status.text = "请在系统安装界面确认更新"
                    action.isEnabled = false
                    startActivity(confirmation)
                } catch (error: Exception) { installing = false; fail(error) }
            }
            PackageInstaller.STATUS_SUCCESS -> {
                prefs.edit().clear().commit()
                status.text = "更新已安装，请重新打开 MollyTime"
                detail.text = ""
                button("打开媒体库") {
                    startActivity(Intent(this, ShellActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
                    finish()
                }
            }
            else -> {
                prefs.edit().clear().commit()
                installing = false
                status.text = if (result.getIntExtra(PackageInstaller.EXTRA_STATUS, 0) == PackageInstaller.STATUS_FAILURE_ABORTED)
                    "安装已取消" else "安装失败，请检查系统安装权限和存储空间后重试"
                button("重新检查更新") { checkUpdate() }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.action == INSTALL_RESULT) handleInstallResult(intent)
    }
    override fun onResume() {
        super.onResume()
        if (awaitingSettings) {
            awaitingSettings = false
            if (Build.VERSION.SDK_INT < 26 || packageManager.canRequestPackageInstalls()) install()
            else button("允许安装应用") { requestInstall() }
        }
    }
    override fun onSaveInstanceState(outState: Bundle) {
        release?.let { outState.putString("release", it.json().toString()) }
        super.onSaveInstanceState(outState)
    }
    override fun onDestroy() { operation.cancel(); super.onDestroy() }
    private fun ui(block: () -> Unit) { runOnUiThread { if (!isFinishing && !isDestroyed) block() } }
    private fun button(label: String, click: () -> Unit) {
        action.text = label; action.isEnabled = true; action.setOnClickListener { click() }; action.requestFocus()
    }
    private fun fail(error: Throwable) {
        progress.visibility = android.view.View.GONE
        status.text = if (error is IllegalArgumentException || error is IllegalStateException)
            error.message ?: "更新失败" else "更新失败，请检查网络后重试"
        button("重新检查更新") { checkUpdate() }
    }
    companion object { private const val INSTALL_RESULT = "com.molly.tv.INSTALL_RESULT" }
}
