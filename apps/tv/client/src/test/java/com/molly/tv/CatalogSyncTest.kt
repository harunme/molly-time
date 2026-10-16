package com.molly.tv

import android.app.Application
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.Dispatcher
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.concurrent.CopyOnWriteArrayList

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [28])
class CatalogSyncTest {
    @Test fun backgroundCompletesPagesWithoutScrollAndUnchangedVersionsOnlyCheckState() = exerciseSync(false)
    @Test fun missingBrowsingSnapshotResyncsEvenWhenPlaybackVersionIsCurrent() = exerciseSync(true)
    private fun exerciseSync(missingChildren: Boolean) {
        val context = RuntimeEnvironment.getApplication()
        val requests = CopyOnWriteArrayList<String>()
        val server = MockWebServer()
        var time = System.currentTimeMillis()
        val grant = GrantFixture().state("sync-tv")
        server.dispatcher = object : Dispatcher() {
          override fun dispatch(request: RecordedRequest): MockResponse {
            val path = request.requestUrl!!.encodedPath; requests.add(request.path!!)
            val body = when (path) {
                "/api/tv/sync-state" -> JSONObject(grant.toString()).put("scope", "f:sync-tv").put("catalogVersion", "c1").put("homeVersion", "h1").put("playbackVersion", "p1").put("policyVersion", "policy1")
                "/api/tv/catalog/manifest" -> JSONObject().put("version", "c1").put("homeVersion", "h1").put("folders", JSONArray().put(JSONObject().put("id", "series").put("version", "s1")))
                "/api/tv/catalog/home" -> JSONObject().put("rows", JSONArray().put(JSONObject().put("id", "library").put("title", "Library").put("total", 1).put("hasMore", false).put("items", JSONArray().put(JSONObject().put("id", "series").put("name", "Series")))))
                "/api/tv/playback-state" -> JSONObject().put("version", "p1").put("progress", JSONArray()).put("recent", JSONObject().put("rows", JSONArray()))
                else -> {
                    val page = if (request.requestUrl!!.queryParameter("page") == "1") 1 else 2
                    JSONObject().put("total", 49).put("hasMore", page == 1).put("episodes", JSONArray().apply {
                        for (i in (if (page == 1) 0 else 48) until (if (page == 1) 48 else 49)) put(JSONObject().put("id", "e-$i").put("name", "Episode $i").put("type", "episode"))
                    }).also { it.put("items", it.getJSONArray("episodes")).put("itemTotal", 49).put("itemsHasMore", page == 1) }
                }
            }.toString()
            return MockResponse().setBody(body)
          }
        }
        server.start()
        val session = SessionStore(context)
        session.clear(); session.connect(server.url("/").toString())
        session.save(JSONObject().put("accessToken", "a").put("refreshToken", "r").put("deviceId", "sync-tv"))
        val api = MollyTimeApi(session) { "Test" }
        val sync = CatalogSync(context, session, api, CoverStore(context, session, api), { _, _ -> }, { time })
        try {
            if (missingChildren) {
                val store = sync.store()
                val episodes = JSONArray().apply { for (i in 0 until 49) put(JSONObject().put("id", "e-$i").put("name", "Episode $i")) }
                store.accept("folder:series", "s1", 1, episodes, false, JSONObject().put("total", 49))
                assertFalse(store.needs("folder:series", "s1"))
                assertTrue(store.needsFolder("series", "s1"))
                assertEquals(1, store.nextFolderPage("series", "s1"))
                assertNull(store.readPlaylist("series", 1, 24))
            }
            repeat(6) { sync.tick(); time += 1000 }
            assertEquals(49, sync.store().rows("folder:series", 0, 100)!!.length())
            assertEquals(49, sync.store().readPlaylist("series", 1, 100)!!.getJSONArray("items").length())
            assertFalse(sync.store().needsFolder("series", "s1"))
            assertTrue(sync.status().getBoolean("catalogComplete"))
            assertEquals(2, requests.count { it.startsWith("/api/tv/catalog/folders/") })
            val count = requests.size
            time += 60001
            sync.tick()
            assertEquals(listOf("/api/tv/sync-state"), requests.drop(count))
            sync.pause()
            val pausedCount = requests.size; time += 60001; sync.tick()
            assertEquals(pausedCount, requests.size)
            // A queued foreground resume can wake a later scheduled check without scrolling.
            sync.resume()
        } finally { sync.close(); server.shutdown(); session.clear() }
    }
}
