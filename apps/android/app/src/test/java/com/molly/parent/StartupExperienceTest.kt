package com.molly.parent

import android.provider.Settings
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import android.os.Looper
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class StartupExperienceTest {
    @Test fun reducedMotionKeepsStaticLaunchForSixHundredMilliseconds() {
        val app = ApplicationProvider.getApplicationContext<ParentApplication>()
        Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        // No MediaPlayer data source is registered in Robolectric: the intentional error path
        // verifies that failed audio still completes the same minimum launch gate as iOS.
        val startup = StartupExperience(app); startup.start()
        assertFalse(startup.finished)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(599)); assertFalse(startup.finished)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(1)); assertTrue(startup.finished)
    }
    @Test fun backgroundFinishesLaunchAndReturningDoesNotReplay() {
        val app = ApplicationProvider.getApplicationContext<ParentApplication>()
        val startup = StartupExperience(app); startup.start(); val start = startup.startedAt
        startup.stop(); assertTrue(startup.finished)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
        startup.start(); assertEquals(start, startup.startedAt); assertTrue(startup.finished)
    }
}
