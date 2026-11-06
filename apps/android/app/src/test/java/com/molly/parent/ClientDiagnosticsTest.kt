package com.molly.parent

import android.content.Context
import android.content.ContextWrapper
import androidx.test.core.app.ApplicationProvider
import com.molly.diagnostics.ClientDiagnostics
import java.io.File
import java.util.UUID
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class ClientDiagnosticsTest {
    private lateinit var context: Context
    private lateinit var directory: File
    private val reporters = mutableListOf<ClientDiagnostics>()
    @Before fun setup() {
        val base = ApplicationProvider.getApplicationContext<ParentApplication>()
        val name = UUID.randomUUID().toString()
        directory = File(base.noBackupFilesDir, name).apply { mkdirs() }
        context = object : ContextWrapper(base) {
            override fun getNoBackupFilesDir() = directory
            override fun getSharedPreferences(key: String, mode: Int) = base.getSharedPreferences("$key-$name", mode)
        }
    }
    @After fun cleanup() { reporters.reversed().forEach { it.close() }; directory.deleteRecursively() }
    private fun reporter() = ClientDiagnostics(context, "android-parent", "1.2 (9)", false).also { reporters.add(it) }

    @Test fun fatalIsSavedSynchronouslyWithoutMessagesAndDelegatesToExistingHandler() {
        val original = Thread.getDefaultUncaughtExceptionHandler()
        var delegated = false
        Thread.setDefaultUncaughtExceptionHandler { _, _ -> delegated = true }
        try {
            val reporter = reporter()
            reporter.bind("account-a") { _, _ -> error("Fatal handler must not use the network") }
            reporter.screen("tab.library"); reporter.breadcrumb("cover.enqueued"); reporter.breadcrumb("tab.select.1")
            reporter.install()
            val error = IllegalStateException("Cookie=private https://private.example/signed?token=secret", IllegalArgumentException("private body"))
            Thread.getDefaultUncaughtExceptionHandler()!!.uncaughtException(Thread.currentThread(), error)
            assertTrue(delegated)
            val persisted = File(directory, "client-diagnostics-v1.json").readText()
            assertFalse(persisted.contains("private")); assertFalse(persisted.contains("secret"))
            reporter.close()
            val restored = reporter()
            val sent = mutableListOf<JSONObject>()
            restored.bind("account-a") { _, body -> sent.add(body); 200 }; restored.flush()
            assertEquals(1, sent.size)
            assertEquals("NATIVE_UNCAUGHT", sent.single().getString("code"))
            assertTrue(sent.single().getBoolean("fatal"))
            assertTrue(sent.single().getJSONArray("stack").toString().contains("IllegalArgumentException"))
            assertEquals("tab.select.1", sent.single().getJSONArray("breadcrumbs").getJSONObject(2).getString("name"))
        } finally { Thread.setDefaultUncaughtExceptionHandler(original) }
    }

    @Test fun retriesPreserveIdsAndAccountSwitchNeverSendsAnotherOwnersEvent() {
        val first = reporter()
        var firstID = ""
        first.bind("account-a") { _, body -> firstID = body.getString("id"); 503 }
        first.capture(IllegalStateException(), fatal = true); first.flush(); first.close()
        val restarted = reporter()
        var calls = 0
        restarted.bind("account-b") { _, _ -> calls++; 200 }; restarted.flush()
        assertEquals(0, calls)
        restarted.bind("account-a") { owner, body ->
            calls++; assertEquals("account-a", owner); assertEquals(firstID, body.getString("id")); 200
        }
        restarted.flush(); restarted.flush()
        assertEquals(1, calls)
    }

    @Test fun boundsQueueAndFramesAndDiscardsInvalidRecordsButRetainsUnauthorized() {
        val reporter = reporter()
        reporter.bind("account") { _, _ -> 401 }
        repeat(50) { reporter.capture(IllegalStateException(), fatal = true) }
        assertTrue(File(directory, "client-diagnostics-v1.json").length() < 512_000)
        reporter.flush()
        var sent = 0
        reporter.bind("account") { _, body -> sent++; assertTrue(body.getJSONArray("stack").length() <= 64); 422 }
        repeat(4) { reporter.flush() }
        assertEquals(32, sent)
        reporter.capture(IllegalStateException(), fatal = true)
        reporter.bind("", null); reporter.flush()
        assertTrue(File(directory, "client-diagnostics-v1.json").readText().contains("NATIVE_HANDLED"))
    }
}
