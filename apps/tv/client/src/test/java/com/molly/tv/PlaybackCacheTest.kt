package com.molly.tv

import android.app.Application
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [28])
class PlaybackCacheTest {
    @Test fun playbackReusesSpansAcrossSignedUrlsAndRestartsButNotDifferentFiles() {
        val context = RuntimeEnvironment.getApplication()
        val server = MockWebServer()
        server.start()
        val session = SessionStore(context)
        session.clear()
        session.connect(server.url("/").toString().trimEnd('/'))
        session.save(JSONObject().put("deviceId", UUID.randomUUID().toString())
            .put("accessToken", "a").put("refreshToken", "r"))
        var media = MediaStore(context, session, MollyTimeApi(session) { "Test" })
        fun read(id: String, signature: String, position: Long, length: Long): String {
            val info = JSONObject().put("mediaId", id).put("version", "v1")
                .put("url", server.url("/video?signature=$signature").toString())
            val source = media.factory().createDataSource()
            try {
                source.open(DataSpec.Builder().setUri(media.uri(info)).setKey(media.key(info))
                    .setPosition(position).setLength(length).build())
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(32)
                while (true) {
                    val count = source.read(buffer, 0, buffer.size)
                    if (count < 0) break
                    output.write(buffer, 0, count)
                }
                return output.toString("UTF-8")
            } finally { source.close() }
        }
        try {
            server.enqueue(MockResponse().setBody("0123456789"))
            assertEquals("01234", read("first", "initial", 0, 5))
            assertEquals(1, server.requestCount)
            // Replaying the watched segment uses local bytes with a fresh signed URL.
            assertEquals("01234", read("first", "renewed", 0, 5))
            assertEquals(1, server.requestCount)
            server.enqueue(MockResponse().setBody("0123456789"))
            assertEquals("56789", read("first", "renewed", 5, 5))
            assertEquals(2, server.requestCount)
            media.close()
            media = MediaStore(context, session, MollyTimeApi(session) { "Test" })
            assertEquals("0123456789", read("first", "after-restart", 0, 10))
            assertEquals(2, server.requestCount)
            server.enqueue(MockResponse().setBody("abcdefghij"))
            assertEquals("abcdefghij", read("new-file", "different-file", 0, 10))
            assertEquals(3, server.requestCount)
            session.clear()
            media.synchronizeOwner()
            session.save(JSONObject().put("deviceId", UUID.randomUUID().toString())
                .put("accessToken", "a").put("refreshToken", "r"))
            server.enqueue(MockResponse().setBody("0123456789"))
            assertEquals("0123456789", read("first", "new-owner", 0, 10))
            assertEquals(4, server.requestCount)
        } finally { media.close(); session.clear(); server.shutdown() }
    }
}
