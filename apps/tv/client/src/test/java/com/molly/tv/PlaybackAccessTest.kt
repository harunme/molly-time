package com.molly.tv

import android.app.Application
import androidx.media3.common.util.UnstableApi
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.CancellationException
import java.util.UUID
import java.util.concurrent.TimeUnit

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [28])
class PlaybackAccessTest {
    @Test fun interruptedSourceResponseRetriesWithoutCreatingAnotherPlaybackSession() = withPlayback { server, api, _, _ ->
        server.enqueue(MockResponse().setBody("""{"sessionId":"existing-session"}"""))
        val payload = JSONObject().put("mediaId", "video").put("padding", "x".repeat(2048)).toString()
        server.enqueue(MockResponse().setBody(payload).setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
        server.enqueue(MockResponse().setBody(payload))
        val session = api.json("POST", "/api/playback/sessions", JSONObject().put("episodeId", "episode"))
        val path = "/api/episodes/episode/playback?sessionId=${session.getString("sessionId")}"
        val result = PlaybackAccess.read { api.json("GET", path) }
        assertEquals("video", result.getString("mediaId"))
        assertEquals("POST", server.takeRequest(1, TimeUnit.SECONDS)!!.method)
        repeat(2) {
            val read = server.takeRequest(1, TimeUnit.SECONDS)!!
            assertEquals("GET", read.method)
            assertEquals(path, read.path)
        }
        assertEquals(3, server.requestCount)
    }

    @Test fun repeatedReadTimeoutsAreBoundedAndKeepTheirOriginalCause() {
        var reads = 0
        val timeout = SocketTimeoutException("timeout")
        assertSame(timeout, assertThrows(SocketTimeoutException::class.java) {
            PlaybackAccess.read { reads++; throw timeout }
        })
        assertEquals(2, reads)
        assertEquals("连接超时，请检查网络后重试", PlaybackAccess.message(timeout, "加载失败"))
    }

    @Test fun leavingPlaybackPreventsAReadRetry() {
        var active = true
        var reads = 0
        assertThrows(CancellationException::class.java) {
            PlaybackAccess.read(active = { active }) {
                reads++
                active = false
                throw SocketTimeoutException()
            }
        }
        assertEquals(1, reads)
    }

    @Test fun permissionFailuresAndInvalidResponsesAreNotRetried() {
        var requests = 0
        assertThrows(ApiFailure::class.java) {
            PlaybackAccess.read { requests++; throw ApiFailure(403) }
        }
        assertEquals(1, requests)
        assertThrows(org.json.JSONException::class.java) {
            PlaybackAccess.read { requests++; throw org.json.JSONException("bad response") }
        }
        assertEquals(2, requests)
    }

    private fun withPlayback(block: (MockWebServer, MollyTimeApi, MediaStore, CatalogSync) -> Unit) {
        val context = RuntimeEnvironment.getApplication()
        val server = MockWebServer().apply { start() }
        val session = SessionStore(context)
        session.clear()
        session.connect(server.url("/").toString())
        session.save(JSONObject().put("accessToken", "a").put("refreshToken", "r").put("deviceId", UUID.randomUUID().toString()))
        val api = MollyTimeApi(session) { "Test" }
        val media = MediaStore(context, session, api)
        val catalog = CatalogSync(context, session, api, CoverStore(context, session, api), { _, _ -> })
        try { block(server, api, media, catalog) }
        finally { catalog.close(); media.close(); session.clear(); server.shutdown() }
    }

    @Test fun uncachedVideoUsesNetworkEvenWhenCatalogReportsOffline() = withPlayback { server, api, media, catalog ->
        assertFalse(catalog.status().getBoolean("online"))
        assertNull(catalog.store().savedPlayback("new-video"))
        server.enqueue(MockResponse().setBody("""{"id":"new-video","sources":[]}"""))
        val detail = PlaybackAccess.load(
            online = { api.json("GET", "/api/episodes/new-video") },
            offline = { media.offline("new-video", catalog.store()) },
        )
        assertEquals("new-video", detail.getString("id"))
        assertEquals("/api/episodes/new-video", server.takeRequest(1, TimeUnit.SECONDS)!!.path)
    }

    @Test fun transportFailureCanUseAnAvailableOfflineCopy() {
        var onlineAttempted = false
        val result = PlaybackAccess.load(
            online = { onlineAttempted = true; throw IOException("connection refused") },
            offline = { assertTrue(onlineAttempted); "verified offline playback" },
        )
        assertEquals("verified offline playback", result)
    }

    @Test fun missingOfflineCopyDoesNotReplaceOriginalNetworkFailure() = withPlayback { _, _, media, catalog ->
        val original = IOException("connection timed out")
        val error = assertThrows(IOException::class.java) {
            PlaybackAccess.load(
                online = { throw original },
                offline = { media.offline("new-video", catalog.store()) },
            )
        }
        assertSame(original, error)
        assertEquals("connection timed out", error.message)
        assertTrue(error.suppressed.single().message!!.contains("尚未完整保存"))
    }

    @Test fun authorizationAndServerFailuresDoNotSwitchToOfflinePlayback() = withPlayback { server, api, _, _ ->
        for (status in listOf(403, 404, 500)) {
            server.enqueue(MockResponse().setResponseCode(status))
            val error = assertThrows(ApiFailure::class.java) {
                PlaybackAccess.load(
                    online = { api.json("GET", "/api/episodes/new-video") },
                    offline = { fail("HTTP errors must not bypass the server through an offline copy"); JSONObject() },
                )
            }
            assertEquals(status, error.status)
        }
    }

    @Test fun invalidOnlineResponseDoesNotSwitchToOfflinePlayback() = withPlayback { server, api, _, _ ->
        server.enqueue(MockResponse().setBody("invalid json"))
        assertThrows(org.json.JSONException::class.java) {
            PlaybackAccess.load(
                online = { api.json("GET", "/api/episodes/new-video") },
                offline = { fail("Response parsing errors must be reported"); JSONObject() },
            )
        }
    }
}
