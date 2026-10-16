package com.molly.tv

import android.app.Application
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [28])
class CatalogStoreTest {
    private fun CatalogStore.withCatalog(block: (CatalogStore) -> Unit) { try { block(this) } finally { close() } }
    private fun store() = CatalogStore(RuntimeEnvironment.getApplication(), "https://media.test|${UUID.randomUUID()}")
    private fun rows(vararg ids: String) = JSONArray(ids.map { JSONObject().put("id", it).put("name", it) })
    private fun CatalogStore.folder(id: String, version: String, page: Int, values: JSONArray, more: Boolean, details: JSONObject) {
        acceptFolder(id, version, page, JSONObject(details.toString()).put("episodes", values).put("items", values)
            .put("itemTotal", details.getInt("total")).put("hasMore", more))
    }
    @Test fun browsingAndPlaybackSwitchVersionsTogether() = store().withCatalog { s ->
        fun batch(episodes: JSONArray, children: JSONArray, total: Int, childTotal: Int, more: Boolean) =
            JSONObject().put("episodes", episodes).put("items", children).put("total", total)
                .put("itemTotal", childTotal).put("hasMore", more)
        s.acceptFolder("root", "old", 1, batch(rows("old-video"), rows("old-folder"), 1, 1, false))
        val children = JSONArray().put(JSONObject().put("id", "nested").put("name", "Songs").put("type", "folder"))
            .put(JSONObject().put("id", "b").put("name", "Video B").put("type", "episode"))
        s.acceptFolder("root", "new", 1, batch(rows("a", "b"), children, 3, 2, true))
        assertEquals("old-folder", s.readPlaylist("root", 1, 24)!!.getJSONArray("items").getJSONObject(0).getString("id"))
        s.acceptFolder("root", "new", 2, batch(rows("c"), JSONArray(), 3, 2, false))
        s.recordPosition("b", 5000, false)
        val result = s.readPlaylist("root", 1, 24)!!
        assertEquals(3, result.getJSONArray("episodes").length())
        assertEquals(2, result.getJSONArray("items").length())
        assertEquals("nested", result.getJSONArray("items").getJSONObject(0).getString("id"))
        assertEquals(5000, result.getJSONArray("items").getJSONObject(1).getInt("positionMs"))
        assertFalse(result.getBoolean("itemsHasMore"))
        assertEquals("c", s.nextEpisode("b"))
        val page = s.readPlaylist("root", 2, 1)!!
        assertEquals("b", page.getJSONArray("items").getJSONObject(0).getString("id"))
    }
    @Test fun invalidBrowsingBatchRollsBackPlaybackBatch() = store().withCatalog { s ->
        val old = JSONObject().put("episodes", rows("old")).put("items", rows("old-folder"))
            .put("total", 1).put("itemTotal", 1).put("hasMore", false)
        s.acceptFolder("root", "old", 1, old)
        val invalid = JSONObject().put("episodes", rows("new")).put("items", JSONArray())
            .put("total", 1).put("itemTotal", 1).put("hasMore", false)
        assertThrows(IllegalStateException::class.java) { s.acceptFolder("root", "new", 1, invalid) }
        assertEquals("old", s.readPlaylist("root", 1, 24)!!.getJSONArray("episodes").getJSONObject(0).getString("id"))
        assertEquals("old-folder", s.readPlaylist("root", 1, 24)!!.getJSONArray("items").getJSONObject(0).getString("id"))
    }
    @Test fun incompletePagesStayPendingAndResumeAfterRestart() {
        val original = store(); val owner = original.owner
        original.folder("a", "v1", 1, rows("a", "b"), true, JSONObject().put("total", 3))
        assertNull(original.readPlaylist("a", 2, 2))
        original.close()
        store().close() // A separate binding has its own database.
        CatalogStore(RuntimeEnvironment.getApplication(), owner).withCatalog { s ->
            assertEquals(2, s.nextPage("folder:a", "v1"))
            assertEquals(2, s.readPlaylist("a", 1, 2)!!.getJSONArray("episodes").length())
            s.folder("a", "v1", 2, rows("c"), false, JSONObject().put("total", 3))
            assertEquals("c", s.readPlaylist("a", 2, 2)!!.getJSONArray("episodes").getJSONObject(0).getString("id"))
        }
    }
    @Test fun lastCompleteFolderSurvivesInterruptedReplacement() = store().withCatalog { s ->
        s.folder("a", "old", 1, rows("a", "b"), false, JSONObject().put("total", 2))
        s.folder("a", "new", 1, rows("c"), true, JSONObject().put("total", 3))
        assertEquals(2, s.readPlaylist("a", 1, 24)!!.getInt("total"))
        assertEquals("a", s.rows("folder:a", 0, 1)!!.getJSONObject(0).getString("id"))
        s.folder("a", "new", 2, rows("d", "e"), false, JSONObject().put("total", 3))
        assertEquals("c", s.rows("folder:a", 0, 1)!!.getJSONObject(0).getString("id"))
    }
    @Test fun mismatchedFolderCheckpointsRestartTogether() = store().withCatalog { s ->
        s.accept("folder:a", "v1", 1, rows("a", "b"), false, JSONObject().put("total", 2))
        s.accept("children:a", "v1", 1, rows("a"), true, JSONObject().put("total", 2))
        assertEquals(s.nextPage("folder:a", "v1"), s.nextPage("children:a", "v1"))
        assertTrue(s.needsFolder("a", "v1"))
        assertEquals(1, s.nextFolderPage("a", "v1"))
    }
    @Test fun homeSwitchesAtomicallyAndRejectsMixedRows() = store().withCatalog { s ->
        fun definition(version: String) = JSONObject().put("version", version).put("rows", JSONArray().put(JSONObject().put("id", "library").put("total", 1))).toString()
        s.accept("home:library", "old", 1, rows("a"), false, JSONObject().put("total", 1))
        s.publishHome(definition("old"), "old")
        s.accept("home:library", "new", 1, rows("b"), false, JSONObject().put("total", 1))
        assertEquals("a", s.readHome(1, 24, null)!!.getJSONArray("rows").getJSONObject(0).getJSONArray("items").getJSONObject(0).getString("id"))
        s.publishHome(definition("new"), "new")
        assertEquals("b", s.readHome(1, 24, null)!!.getJSONArray("rows").getJSONObject(0).getJSONArray("items").getJSONObject(0).getString("id"))
    }
    @Test fun failedFinalPageDoesNotAdvanceCheckpoint() = store().withCatalog { s ->
        s.folder("a", "v1", 1, rows("a"), true, JSONObject().put("total", 3))
        assertThrows(IllegalStateException::class.java) { s.folder("a", "v1", 2, rows("b"), false, JSONObject().put("total", 3)) }
        assertEquals(2, s.nextPage("folder:a", "v1"))
        assertEquals(1, s.rows("folder:a", 0, 24)!!.length())
    }
    @Test fun progressProjectionDoesNotErasePendingOfflineObservations() = store().withCatalog { s ->
        s.recordPosition("a", 5000, false)
        s.session("s1", JSONObject().put("id", "s1").put("episodeId", "a"))
        s.enqueue("s1", JSONObject().put("seq", 0))
        val remote = JSONObject().put("version", "p1").put("progress", JSONArray().put(JSONObject().put("episodeId", "a").put("positionMs", 1000)))
        s.acceptProgress(remote)
        assertEquals(5000L, s.overlay(JSONObject().put("id", "a")).getLong("positionMs"))
        s.acknowledge(JSONArray().put(JSONObject().put("id", "s1").put("seq", 0)))
        s.acceptProgress(remote)
        assertEquals(1000L, s.overlay(JSONObject().put("id", "a")).getLong("positionMs"))
    }
    @Test fun olderServerProjectionCannotReplaceUnacknowledgedOnlinePosition() = store().withCatalog { s ->
        s.recordPosition("a", 5000, false, "online", 4, 1000)
        fun remote(session: String, seq: Int, started: Long) = JSONObject().put("version", "p$seq").put("progress", JSONArray().put(JSONObject().put("episodeId", "a").put("positionMs", 1000).put("sessionId", session).put("seq", seq).put("startedAt", started)))
        s.acceptProgress(remote("online", 3, 1000))
        assertEquals(5000L, s.overlay(JSONObject().put("id", "a")).getLong("positionMs"))
        s.acceptProgress(remote("online", 4, 1000))
        assertEquals(1000L, s.overlay(JSONObject().put("id", "a")).getLong("positionMs"))
        s.recordPosition("a", 9000, false, "online", 5, 1000)
        s.acceptProgress(remote("newer", 0, 2000))
        assertEquals(1000L, s.overlay(JSONObject().put("id", "a")).getLong("positionMs"))
    }
    @Test fun eventsAtGrantExpiryAreClippedAndAcknowledgedSessionsAreCleaned() = store().withCatalog { s ->
        s.session("s", JSONObject().put("id", "s").put("episodeId", "a").put("startedAt", 1000).put("expiresAt", 2000))
        s.enqueue("s", JSONObject().put("seq", 0).put("startMs", 0).put("endMs", 2000).put("playedMs", 2000))
        val event = s.pendingEvents().getJSONObject(0).getJSONArray("events").getJSONObject(0)
        assertEquals(1000L, event.getLong("endMs")); assertEquals(1000L, event.getLong("playedMs")); assertTrue(event.getBoolean("stopped"))
        s.enqueue("s", JSONObject().put("seq", 1).put("startMs", 2000).put("endMs", 3000).put("playedMs", 1000))
        assertEquals(1, s.pendingEvents().getJSONObject(0).getJSONArray("events").length())
        s.acknowledge(JSONArray().put(JSONObject().put("id", "s").put("seq", 0)))
        assertEquals(0, s.pendingEvents().length())
    }
}
