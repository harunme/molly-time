package com.molly.tv

import android.app.Activity
import android.app.ActivityOptions
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageInstaller
import android.os.Build
import java.io.File
import java.util.UUID

/** Hands a verified APK to Android's installer. All progress UI remains in the WebView. */
class ClientUpdateInstaller(private val activity: Activity) {
    private val app get() = activity.application as MollyTimeApplication
    private val prefs get() = activity.getSharedPreferences("molly.updates", Activity.MODE_PRIVATE)

    fun install(file: File, release: ClientUpdates.Release, operation: ClientUpdates.Operation, state: (String, Boolean) -> Unit) {
        app.updates.executor.execute {
            val installer = activity.packageManager.packageInstaller
            var sessionId: Int? = null
            var committed = false
            try {
                operation.ensureActive()
                app.updates.verify(file, release)
                val previous = prefs.getInt("session", -1)
                if (previous >= 0) runCatching { installer.abandonSession(previous) }
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                    setAppPackageName(activity.packageName)
                    setSize(release.size)
                    if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
                }
                val id = installer.createSession(params)
                sessionId = id
                val nonce = UUID.randomUUID().toString()
                prefs.edit().putInt("session", id).putString("nonce", nonce).commit()
                val callback = Intent(activity, ShellActivity::class.java).setAction(INSTALL_RESULT)
                    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra("nonce", nonce)
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                    if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
                @Suppress("DEPRECATION")
                val options = if (Build.VERSION.SDK_INT >= 35) ActivityOptions.makeBasic().apply {
                    setPendingIntentCreatorBackgroundActivityStartMode(
                        if (Build.VERSION.SDK_INT >= 36) ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOW_ALWAYS
                        else ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
                }.toBundle() else null
                val sender = PendingIntent.getActivity(activity, id, callback, flags, options).intentSender
                installer.openSession(id).use { session ->
                    session.openWrite("base.apk", 0, release.size).use { output ->
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
                activity.runOnUiThread { state("请在系统安装界面确认更新", true) }
            } catch (error: Exception) {
                activity.runOnUiThread { state(error.message ?: "准备安装失败", false) }
            } finally {
                if (!committed && sessionId != null) runCatching { installer.abandonSession(sessionId) }
            }
        }
    }

    companion object { const val INSTALL_RESULT = "com.molly.tv.INSTALL_RESULT" }
}
