package com.molly.tv

import android.app.Activity
import android.app.Application
import android.media.MediaPlayer
import android.os.Looper
import android.provider.Settings
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowChoreographer
import org.robolectric.shadows.ShadowMediaPlayer
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [28])
class StartupLogoViewTest {
    private fun visibleActivity(): org.robolectric.android.controller.ActivityController<Activity> {
        // Attach the test window before taking manual control of vsync.
        ShadowChoreographer.setPaused(false)
        val activity = Robolectric.buildActivity(Activity::class.java).setup().visible()
        ShadowChoreographer.setPaused(true)
        ShadowChoreographer.setFrameDelay(Duration.ofMillis(16))
        return activity
    }
    private fun displayedTime(view: StartupLogoView): Float =
        StartupLogoView::class.java.getDeclaredField("time").apply { isAccessible = true }.getFloat(view)

    @Test fun playerAndViewStayTogetherWhenMediaPlaybackStalls() {
        val activity = visibleActivity()
        Settings.Global.putFloat(activity.get().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        ShadowMediaPlayer.setMediaInfoProvider { ShadowMediaPlayer.MediaInfo(1800, 250) }
        lateinit var player: MediaPlayer
        val sound = StartupSound(activity.get()) { audio ->
            player = audio
            audio.setDataSource("bundled.mp3")
            true
        }
        var completions = 0
        val view = StartupLogoView(activity.get()) { completions++ }
        try {
            activity.get().setContentView(view)
            sound.start(onReady = { view.startMotion(sound::playbackPositionMs) }) { true }
            // Deliver decoder readiness before advancing the playback clock.
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(250))
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(250))
            assertTrue("test logo must be attached", view.isAttachedToWindow)
            assertEquals(250L, sound.playbackPositionMs())
            assertEquals(.25f, displayedTime(view), .032f)
            // Hold the media clock without pausing the view's frame callbacks.
            player.pause()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(700))
            assertEquals(.25f, displayedTime(view), .001f)
            player.start()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(640))
            assertEquals(.89f, displayedTime(view), .032f)
            assertEquals(0, completions)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1000))
            assertTrue(sound.finished)
            assertEquals(1.8f, displayedTime(view), .001f)
            assertEquals(1, completions)
        } finally { sound.stop(); view.stop(); activity.pause().stop().destroy() }
    }

    @Test fun audioClockHoldsDuringOutputDelayAndDrivesEachWaveBeat() {
        val activity = visibleActivity()
        Settings.Global.putFloat(activity.get().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        var position = 0L
        var completions = 0
        val view = StartupLogoView(activity.get()) { completions++ }
        try {
            activity.get().setContentView(view)
            view.startMotion { position }
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(400))
            assertEquals(0f, displayedTime(view), .001f)
            for (beat in listOf(890L, 990L, 1100L, 1220L, 1460L)) {
                position = beat
                shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(32))
                assertEquals(beat / 1000f, displayedTime(view), .001f)
            }
            // A stale sample must not make the logo spring backwards.
            position = 1200
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(32))
            assertEquals(1.46f, displayedTime(view), .001f)
            assertEquals(0, completions)
            position = 1800
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(32))
            assertEquals(1, completions)
            view.startMotion()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
            assertEquals(1, completions)
        } finally { view.stop(); activity.pause().stop().destroy() }
    }

    @Test fun lateAttachmentJoinsCurrentAudioPositionInsteadOfRestarting() {
        val activity = visibleActivity()
        Settings.Global.putFloat(activity.get().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        var position = 0L
        val view = StartupLogoView(activity.get()) {}
        try {
            view.startMotion { position }
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(500))
            position = 1100
            activity.get().setContentView(view)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(32))
            assertEquals(1.1f, displayedTime(view), .001f)
        } finally { view.stop(); activity.pause().stop().destroy() }
    }

    @Test fun soundFailureContinuesFromLastPoseAndPauseExcludesBackgroundTime() {
        val activity = visibleActivity()
        Settings.Global.putFloat(activity.get().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        var position: Long? = 930
        var completions = 0
        val view = StartupLogoView(activity.get()) { completions++ }
        try {
            activity.get().setContentView(view)
            view.startMotion { position }
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(32))
            assertEquals(.93f, displayedTime(view), .001f)
            position = null
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(320))
            assertEquals(1.25f, displayedTime(view), .02f)
            view.pause()
            val pausedTime = displayedTime(view)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
            assertEquals(pausedTime, displayedTime(view), .001f)
            assertEquals(0, completions)
            view.resume()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(32))
            assertEquals(pausedTime + .032f, displayedTime(view), .02f)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
            assertEquals(1, completions)
        } finally { view.stop(); activity.pause().stop().destroy() }
    }

    @Test fun systemAnimationSpeedDoesNotChangeAudioTimeline() {
        val activity = visibleActivity()
        try {
            for (scale in listOf(.5f, 2f)) {
                Settings.Global.putFloat(activity.get().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, scale)
                val view = StartupLogoView(activity.get()) {}
                activity.get().setContentView(view)
                view.startMotion { 890L }
                shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(400))
                assertEquals(.89f, displayedTime(view), .001f)
                view.stop()
            }
        } finally {
            Settings.Global.putFloat(activity.get().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
            activity.pause().stop().destroy()
        }
    }

    @Test fun entranceCompletesOnceAndDoesNotReplayWhileLoading() {
        val activity = visibleActivity()
        Settings.Global.putFloat(activity.get().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        var completions = 0
        val view = StartupLogoView(activity.get()) { completions++ }
        try {
            activity.get().setContentView(view)
            view.startMotion()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
            assertEquals(1, completions)
            view.startMotion()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(3))
            assertEquals(1, completions)
        } finally { view.stop(); activity.pause().stop().destroy() }
    }

    @Test fun stoppingAnEntranceDoesNotReportSuccessfulCompletion() {
        val activity = visibleActivity()
        Settings.Global.putFloat(activity.get().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        // Advance animation frames only when this test advances the main looper.
        ShadowChoreographer.setPaused(true)
        ShadowChoreographer.setFrameDelay(Duration.ofMillis(16))
        var completions = 0
        val view = StartupLogoView(activity.get()) { completions++ }
        try {
            activity.get().setContentView(view)
            view.startMotion()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(400))
            view.stop()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
            assertEquals(0, completions)
        } finally { view.stop(); activity.pause().stop().destroy() }
    }

    @Test fun disabledMotionShowsAStaticLogoInsteadOfCompletingImmediately() {
        val activity = visibleActivity()
        Settings.Global.putFloat(activity.get().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        var completions = 0
        val view = StartupLogoView(activity.get()) { completions++ }
        try {
            activity.get().setContentView(view)
            assertTrue(view.isAttachedToWindow)
            view.startMotion()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(599))
            assertEquals(0, completions)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1))
            assertEquals(1, completions)
            view.startMotion()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
            assertEquals(1, completions)
        } finally { view.stop(); activity.pause().stop().destroy() }
    }

    @Test fun pausingOrReplacingALogoCancelsItsPendingCompletion() {
        val activity = visibleActivity()
        Settings.Global.putFloat(activity.get().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        var oldCompletions = 0
        var newCompletions = 0
        val old = StartupLogoView(activity.get()) { oldCompletions++ }
        val next = StartupLogoView(activity.get()) { newCompletions++ }
        try {
            activity.get().setContentView(old)
            old.startMotion(); old.pause()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
            assertEquals(0, oldCompletions)
            activity.get().setContentView(next)
            next.startMotion()
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(600))
            assertEquals(0, oldCompletions)
            assertEquals(1, newCompletions)
        } finally { old.stop(); next.stop(); activity.pause().stop().destroy() }
    }
}
