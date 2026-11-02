package com.molly.tv

import android.app.Activity
import android.app.Application
import android.os.Looper
import android.provider.Settings
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [28])
class StartupLogoViewTest {
    @Test fun disabledMotionShowsAStaticLogoInsteadOfCompletingImmediately() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().visible()
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
        val activity = Robolectric.buildActivity(Activity::class.java).setup().visible()
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
