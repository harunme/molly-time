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
import org.robolectric.shadows.ShadowSystemClock
import java.time.Duration
import java.util.UUID

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [28])
class WatchControlTest {
    private fun setup(): Pair<SessionStore, WatchControl> {
        val context = RuntimeEnvironment.getApplication()
        val session = SessionStore(context)
        session.save(JSONObject().put("accessToken", "a").put("refreshToken", "r").put("deviceId", UUID.randomUUID().toString()))
        return session to WatchControl(context, session, MollyTimeApi(session) { "test" })
    }
    private fun state(mode: String = "minutes", limit: Long = 60000, version: Int = 1): JSONObject = JSONObject()
        .put("enabled", true).put("supported", true).put("version", version).put("status", "allowed")
        .put("round", JSONObject().put("id", "round").put("mode", mode).put("amount", if (mode == "episodes") 2 else 1).put("limitMs", limit)
            .put("playedMs", 0).put("playlist", if (mode == "episodes") JSONArray(listOf("a", "b")) else JSONArray())
            .put("cursor", 0).put("ended", false))

    @Test fun pauseRefundsUnusedPrepaymentAndRestartNeverRestoresIt() {
        val (session, control) = setup()
        control.accept(state())
        assertTrue(control.tick(true))
        ShadowSystemClock.advanceBy(Duration.ofMillis(250))
        control.tick(false)
        assertEquals(250L, control.snapshot().getJSONObject("round").getLong("playedMs"))
        ShadowSystemClock.advanceBy(Duration.ofMinutes(1))
        assertEquals(250L, control.snapshot().getJSONObject("round").getLong("playedMs"))
        control.tick(true)
        val restored = WatchControl(RuntimeEnvironment.getApplication(), session, MollyTimeApi(session) { "test" })
        assertEquals(1250L, restored.snapshot().getJSONObject("round").getLong("playedMs"))
    }
    @Test fun delayedTickAndServerRefreshDoNotGiveTimeBack() {
        val (_, control) = setup()
        control.accept(state(limit = 2500))
        control.tick(true)
        ShadowSystemClock.advanceBy(Duration.ofMillis(1200))
        control.tick(true)
        assertEquals(1200L, control.snapshot().getJSONObject("round").getLong("playedMs"))
        control.accept(state(limit = 2500))
        ShadowSystemClock.advanceBy(Duration.ofMillis(1300))
        assertFalse(control.tick(true))
        assertEquals("resting", control.snapshot().getString("status"))
        control.accept(state(limit = 2500))
        assertFalse(control.tick(true))
    }
    @Test fun freeSelectionCountsCompletionsOnceAndSurvivesRestart() {
        val (session, control) = setup()
        control.accept(state("episodes"))
        control.requireEpisode("a", true)
        control.requireEpisode("other-folder-video", true)
        control.complete("a") // the video that was left must not consume a slot
        assertEquals(0, control.snapshot().getJSONObject("round").getInt("cursor"))
        control.complete("other-folder-video")
        control.complete("other-folder-video")
        assertEquals(1, control.snapshot().getJSONObject("round").getInt("cursor"))
        val restored = WatchControl(RuntimeEnvironment.getApplication(), session, MollyTimeApi(session) { "test" })
        restored.requireEpisode("a", true)
        restored.complete("a")
        assertFalse(restored.tick(true))
        assertTrue(runCatching { restored.requireEpisode("anything", true) }.isFailure)
        val addition = state("episodes", version = 2)
        addition.getJSONObject("round").put("amount", 3).put("cursor", 2)
        restored.accept(addition)
        restored.requireEpisode("any-video", true)
        assertTrue(restored.tick(true))
        restored.accept(state("episodes", version = 1))
        assertEquals(2, restored.snapshot().getJSONObject("round").getInt("cursor"))
    }
    @Test fun bindingChangeCannotReuseAnotherTelevisionsAllowance() {
        val (session, control) = setup()
        control.accept(state())
        session.save(JSONObject().put("accessToken", "b").put("refreshToken", "s").put("deviceId", UUID.randomUUID().toString()))
        assertTrue(runCatching { control.requireEpisode("a", true) }.isFailure)
    }
}
