package com.molly.tv

import android.app.Application
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [28])
class WebBundleStoreTest {
    @Test fun stagedUpdateBecomesCurrentAfterRestartAndIsNotStagedAgain() {
        val context = RuntimeEnvironment.getApplication()
        val server = MockWebServer()
        server.start()
        try {
            val base = server.url("/").toString().trimEnd('/')
            val version = "test-web-update"
            val bytes = ByteArrayOutputStream().also { output ->
                ZipOutputStream(output).use { zip ->
                    zip.putNextEntry(ZipEntry("index.html"))
                    zip.write("<html>Updated TV</html>".toByteArray())
                    zip.closeEntry()
                }
            }.toByteArray()
            val manifest = JSONObject().put("webVersion", version)
                .put("minBridgeVersion", 1).put("maxBridgeVersion", 1).put("size", bytes.size)
                .put("sha256", MessageDigest.getInstance("SHA-256").digest(bytes)
                    .joinToString("") { "%02x".format(it.toInt() and 255) }).toString()
            fun enqueueManifest() = server.enqueue(MockResponse().setBody(manifest))

            val store = WebBundleStore(context)
            store.selectForLaunch(base)
            enqueueManifest()
            server.enqueue(MockResponse().setBody(Buffer().write(bytes)))
            assertEquals(version, store.checkAndStage(base, 1))
            // Checking again before restart still reports a pending update.
            enqueueManifest()
            assertEquals(version, store.checkAndStage(base, 1))

            val restarted = WebBundleStore(context)
            assertEquals(version, restarted.selectForLaunch(base))
            restarted.confirmLoaded(base, version)
            assertEquals(version, restarted.selectedVersion())
            enqueueManifest()
            assertNull(restarted.checkAndStage(base, 1))

            val nextLaunch = WebBundleStore(context)
            assertEquals(version, nextLaunch.selectForLaunch(base))
            enqueueManifest()
            assertNull(nextLaunch.checkAndStage(base, 1))
            assertEquals(5, server.requestCount)
        } finally {
            server.shutdown()
        }
    }
}
