package com.molly.diagnostics

import android.content.Context
import android.os.Build
import android.util.AtomicFile
import java.io.File
import java.security.MessageDigest
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

/** Bounded, account-scoped crash persistence. The fatal path performs no networking. */
class ClientDiagnostics(context: Context, private val source: String, private val version: String,
                        private val automatic: Boolean = true) {
    companion object {
        private fun dateFormat() = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
        private fun timestamp(time: Long = System.currentTimeMillis()) = dateFormat().format(Date(time))
        fun scope(origin: String, account: String): String = if (account.isBlank()) "" else
            MessageDigest.getInstance("SHA-256").digest("$origin|$account".toByteArray())
                .joinToString("") { "%02x".format(it) }
    }
    private val prefs = context.getSharedPreferences("client-diagnostics-v1", Context.MODE_PRIVATE)
    private val installation = prefs.getString("installation", null) ?: UUID.randomUUID().toString().also {
        prefs.edit().putString("installation", it).commit()
    }
    private val file = AtomicFile(File(context.noBackupFilesDir, "client-diagnostics-v1.json"))
    private val lock = Any()
    private var rows = runCatching {
        require(file.baseFile.length() <= 1_024_000 && File(file.baseFile.path + ".bak").length() <= 1_024_000)
        val saved = JSONArray(String(file.readFully(), Charsets.UTF_8))
        JSONArray((0 until saved.length()).toList().takeLast(32).mapNotNull { saved.optJSONObject(it) })
    }.getOrDefault(JSONArray())
    private var crumbs = runCatching { JSONArray(prefs.getString("crumbs", "[]")) }.getOrDefault(JSONArray())
    private var screen = prefs.getString("screen", "startup").orEmpty()
    @Volatile private var owner = prefs.getString("owner", "").orEmpty()
    @Volatile private var sender: ((String, JSONObject) -> Int)? = null
    @Volatile private var retryAt = 0L
    private val flushRequested = java.util.concurrent.atomic.AtomicBoolean(false)
    private var lastError = ""
    private var lastErrorAt = 0L
    private val worker = Executors.newSingleThreadScheduledExecutor { task -> Thread(task, "client-diagnostics").apply { isDaemon = true } }
    private var previous: Thread.UncaughtExceptionHandler? = null
    private var installed: Thread.UncaughtExceptionHandler? = null

    init {
        if (automatic) {
            collectPreviousExit(context)
            crumbs = JSONArray(); screen = "startup"
            worker.scheduleWithFixedDelay({ runCatching { flush() } }, 1, 60, TimeUnit.SECONDS)
        }
        prefs.edit().putString("version", version).apply()
    }

    private class ProcessExit : RuntimeException()
    private fun collectPreviousExit(context: Context) {
        if (Build.VERSION.SDK_INT < 30 || owner.isEmpty()) return
        runCatching {
            val exits = context.getSystemService(android.app.ActivityManager::class.java)
                .getHistoricalProcessExitReasons(context.packageName, 0, 5)
            val seen = prefs.getLong("lastExit", 0)
            for (exit in exits.filter { it.processName == context.packageName }.sortedByDescending { it.timestamp }.take(1)) {
                if (exit.timestamp <= seen || exit.timestamp < System.currentTimeMillis() - 30L * 86400_000) continue
                if (exit.reason !in listOf(android.app.ApplicationExitInfo.REASON_CRASH,
                        android.app.ApplicationExitInfo.REASON_CRASH_NATIVE,
                        android.app.ApplicationExitInfo.REASON_ANR,
                        android.app.ApplicationExitInfo.REASON_LOW_MEMORY)) continue
                val alreadySaved = synchronized(lock) { (0 until rows.length()).any {
                    val body = rows.getJSONObject(it).getJSONObject("body")
                    body.optBoolean("fatal") && runCatching { kotlin.math.abs(dateFormat().parse(body.getString("occurredAt"))!!.time - exit.timestamp) < 10_000 }.getOrDefault(false)
                } }
                if (!alreadySaved) {
                    val error = ProcessExit().apply { stackTrace = arrayOf(StackTraceElement("AndroidProcess", "reason${exit.reason}_status${exit.status}", null, -1)) }
                    capture(error, "ANDROID_PROCESS_EXIT_${exit.reason}", true, exit.timestamp, prefs.getString("version", version).orEmpty())
                }
                prefs.edit().putLong("lastExit", exit.timestamp).commit()
            }
        }
    }

    fun install() {
        if (installed != null) return
        previous = Thread.getDefaultUncaughtExceptionHandler()
        installed = Thread.UncaughtExceptionHandler { thread, error ->
            try { runCatching { capture(error, "NATIVE_UNCAUGHT", true) } }
            finally {
                val handler = previous
                if (handler != null) handler.uncaughtException(thread, error)
                else { android.os.Process.killProcess(android.os.Process.myPid()); kotlin.system.exitProcess(10) }
            }
        }
        Thread.setDefaultUncaughtExceptionHandler(installed)
    }

    fun bind(nextOwner: String, send: ((String, JSONObject) -> Int)?) {
        synchronized(lock) {
            if (owner != nextOwner) { crumbs = JSONArray(); screen = "startup"; lastError = "" }
            owner = nextOwner; sender = send
            retryAt = 0
            prefs.edit().putString("owner", nextOwner).putString("screen", screen).putString("crumbs", crumbs.toString()).commit()
        }
        if (automatic) flushSoon()
    }

    fun screen(name: String) = synchronized(lock) {
        if (!name.matches(Regex("[A-Za-z0-9_.:/-]{1,80}"))) return@synchronized
        screen = name; breadcrumb("screen:$name")
    }

    fun breadcrumb(name: String) = synchronized(lock) {
        if (!name.matches(Regex("[A-Za-z0-9_.:/-]{1,80}"))) return@synchronized
        while (crumbs.length() >= 20) crumbs.remove(0)
        crumbs.put(JSONObject().put("name", name).put("at", timestamp()))
        prefs.edit().putString("screen", screen).putString("crumbs", crumbs.toString()).apply()
    }

    fun capture(error: Throwable, code: String = "NATIVE_HANDLED", fatal: Boolean = false,
                occurredAt: Long = System.currentTimeMillis(), appVersion: String = version) {
        runCatching {
            synchronized(lock) {
                if (owner.isEmpty()) return
                val signature = "$code|${error.javaClass.name}|${error.stackTrace.firstOrNull()}"
                if (!fatal && signature == lastError && System.currentTimeMillis() - lastErrorAt < 30_000) return
                lastError = signature; lastErrorAt = System.currentTimeMillis()
                val frames = JSONArray()
                var current: Throwable? = error
                val seen = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<Throwable, Boolean>())
                while (current != null && seen.size < 6 && seen.add(current)) {
                    if (frames.length() < 64) frames.put(current.javaClass.name.take(128))
                    current.stackTrace.take(24).forEach { frame ->
                        if (frames.length() < 64) frames.put("at ${frame.className}.${frame.methodName}(${frame.fileName ?: "Unknown"}:${frame.lineNumber})".take(300))
                    }
                    current = current.cause
                }
                val body = JSONObject().put("id", UUID.randomUUID().toString())
                    .put("installationId", installation).put("source", source).put("code", code)
                    .put("fatal", fatal).put("errorType", error.javaClass.name.take(128))
                    .put("stack", frames).put("breadcrumbs", JSONArray(crumbs.toString())).put("screen", screen)
                    .put("appVersion", appVersion.take(80)).put("osVersion", "Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
                    .put("deviceModel", "${Build.MANUFACTURER} ${Build.MODEL}".take(128)).put("occurredAt", timestamp(occurredAt))
                val cutoff = System.currentTimeMillis() - 30L * 86400_000
                val retained = JSONArray()
                for (i in 0 until rows.length()) {
                    val row = rows.optJSONObject(i) ?: continue
                    if (runCatching { (dateFormat().parse(row.getJSONObject("body").getString("occurredAt")))!!.time > cutoff }.getOrDefault(false)) retained.put(row)
                }
                rows = retained
                while (rows.length() >= 32) {
                    val disposable = (0 until rows.length()).firstOrNull { !rows.getJSONObject(it).getJSONObject("body").optBoolean("fatal") } ?: 0
                    rows.remove(disposable)
                }
                rows.put(JSONObject().put("owner", owner).put("body", body))
                save()
            }
        }
        if (!fatal && automatic) flushSoon()
    }

    private fun save() {
        val stream = file.startWrite()
        try { stream.write(rows.toString().toByteArray()); file.finishWrite(stream) }
        catch (error: Throwable) { file.failWrite(stream); throw error }
    }

    fun flushSoon() {
        if (!flushRequested.compareAndSet(false, true)) return
        runCatching { worker.execute { try { runCatching { flush() } } finally { flushRequested.set(false) } } }
            .onFailure { flushRequested.set(false) }
    }

    internal fun flush() {
        val expected = owner
        val send = sender ?: return
        if (expected.isBlank() || System.currentTimeMillis() < retryAt) return
        val pending = synchronized(lock) { (0 until rows.length()).map { rows.getJSONObject(it) }
            .filter { it.optString("owner") == expected }.take(10) }
        for (row in pending) {
            if (owner != expected) return
            val status = try { send(expected, row.getJSONObject("body")) } catch (_: Exception) { retryAt = System.currentTimeMillis() + 60_000; return }
            if (status !in 200..299 && status !in listOf(400, 409, 413, 422)) { retryAt = System.currentTimeMillis() + 60_000; return }
            synchronized(lock) {
                val id = row.getJSONObject("body").getString("id")
                for (i in rows.length() - 1 downTo 0) if (rows.getJSONObject(i).getJSONObject("body").optString("id") == id) rows.remove(i)
                save()
            }
        }
    }

    fun close() {
        worker.shutdownNow()
        if (Thread.getDefaultUncaughtExceptionHandler() === installed) Thread.setDefaultUncaughtExceptionHandler(previous)
    }
}
