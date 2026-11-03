package com.molly.tv

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.Executors

/** Foreground-only, best-effort installation metrics, independent of login state. */
class InstallationTelemetry(private val app: MollyTimeApplication) : Application.ActivityLifecycleCallbacks {
    private val prefs = app.getSharedPreferences("molly.installation.v1", Application.MODE_PRIVATE)
    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()
    private var started = 0
    private var inFlight = false
    private var failures = 0
    private val installationId: String by lazy {
        prefs.getString("id", null) ?: UUID.randomUUID().toString().also {
            check(prefs.edit().putString("id", it).commit())
        }
    }
    private val tick = Runnable { send() }

    init { if (!BuildConfig.DEBUG) app.registerActivityLifecycleCallbacks(this) }

    private fun send() {
        if (started == 0 || inFlight || BuildConfig.DEBUG) return
        inFlight = true
        executor.execute {
            val success = runCatching {
                val credentials = app.session.credentials()
                // Per-origin enrollment secrets never travel to another server.
                val key = "token:" + credentials.server
                val token = prefs.getString(key, null) ?: ByteArray(32).also { SecureRandom().nextBytes(it) }
                    .joinToString("") { "%02x".format(it.toInt() and 0xff) }.also {
                        check(prefs.edit().putString(key, it).commit())
                    }
                val body = JSONObject().put("installationId", installationId)
                    .put("installationToken", token).put("version", BuildConfig.VERSION_NAME)
                    .put("channel", "release")
                // Validate the built request before execution, including auth retries.
                check(credentials.server == app.session.server)
                app.api.json("POST", "/api/client/telemetry", body,
                    credentials.access.isNotEmpty() && credentials.device.isNotEmpty()) { call ->
                    check(call.request().url.toString() == credentials.server + "/api/client/telemetry")
                }
            }.isSuccess
            handler.post {
                inFlight = false
                failures = if (success) 0 else (failures + 1).coerceAtMost(5)
                handler.removeCallbacks(tick)
                if (started > 0) handler.postDelayed(tick,
                    if (success) 60000L else minOf(300000L, 10000L * (1L shl (failures - 1))))
            }
        }
    }

    override fun onActivityStarted(activity: Activity) {
        started++
        if (started == 1) { handler.removeCallbacks(tick); handler.post(tick) }
    }
    override fun onActivityStopped(activity: Activity) {
        started = (started - 1).coerceAtLeast(0)
        if (started == 0) handler.removeCallbacks(tick)
    }
    override fun onActivityCreated(activity: Activity, state: Bundle?) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
}
