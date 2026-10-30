package com.molly.tv

import android.app.Application
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okio.Buffer
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [28])
class StartupSoundTest {
    @Test fun unconfiguredLaunchDoesNotRequestAudioOrCredentials() {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"configured":false}"""))
        server.start()
        val sound = StartupSound(RuntimeEnvironment.getApplication(), OkHttpClient())
        try {
            sound.start(server.url("/").toString().trimEnd('/')) { false }
            val request = server.takeRequest(2, TimeUnit.SECONDS)!!
            assertEquals("/api/startup", request.path)
            assertNull(request.getHeader("Authorization"))
            assertNull(server.takeRequest(150, TimeUnit.MILLISECONDS))
        } finally { sound.stop(); server.shutdown() }
    }

    @Test fun configuredAudioUsesLocalVersionPathAndCachesVerifiedBytes() {
        val server = MockWebServer()
        val bytes = "ID3-test-launch-sound".toByteArray()
        val version = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        val context = RuntimeEnvironment.getApplication()
        val directory = File(context.cacheDir, "startup-sound").apply { deleteRecursively() }
        // The server-supplied URL must not be followed, even if it points elsewhere.
        server.enqueue(MockResponse().setBody("""{"configured":true,"version":"$version","audioUrl":"https://example.invalid/unsafe"}"""))
        server.enqueue(MockResponse().setBody(Buffer().write(bytes)))
        server.start()
        val sound = StartupSound(context, OkHttpClient())
        try {
            sound.start(server.url("/").toString().trimEnd('/')) { false }
            assertEquals("/api/startup", server.takeRequest(2, TimeUnit.SECONDS)!!.path)
            assertEquals("/api/startup/audio/$version", server.takeRequest(2, TimeUnit.SECONDS)!!.path)
            val target = File(directory, "$version.mp3")
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
            while (!target.isFile && System.nanoTime() < deadline) Thread.sleep(10)
            assertTrue(target.isFile)
            assertArrayEquals(bytes, target.readBytes())
        } finally { sound.stop(); server.shutdown(); directory.deleteRecursively() }
    }
}
