package com.molly.tv

import android.app.Application
import android.content.ComponentName
import android.content.Intent
import android.content.pm.ActivityInfo
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [28])
class StartupEntryTest {
    @Test fun coldLaunchDoesNotRequestASecondAnimationOnResume() {
        assertFalse(StartupEntry().takeRequest())
    }

    @Test fun launcherEntriesReplayOnceEvenWhenHomeAlsoDeliveredALeaveHint() {
        for (category in listOf(Intent.CATEGORY_LAUNCHER, Intent.CATEGORY_LEANBACK_LAUNCHER)) {
            val entry = StartupEntry()
            entry.userLeave(playing = false, installing = false)
            entry.newIntent(Intent(Intent.ACTION_MAIN).addCategory(category))
            assertTrue(entry.takeRequest())
            assertFalse(entry.takeRequest())
        }
    }

    @Test fun returningToTheBackgroundTaskWithoutANewIntentReplaysOnce() {
        val entry = StartupEntry()
        entry.userLeave(playing = false, installing = false)
        assertTrue(entry.takeRequest())
        assertFalse(entry.takeRequest())
    }

    @Test fun playbackAndInstallerReturnsNeverReplayTheStartupAnimation() {
        val entry = StartupEntry()
        entry.userLeave(playing = true, installing = false)
        assertFalse(entry.takeRequest())
        entry.userLeave(playing = false, installing = true)
        entry.newIntent(Intent(ClientUpdateInstaller.INSTALL_RESULT))
        assertFalse(entry.takeRequest())
        entry.newIntent(Intent(Intent.ACTION_VIEW))
        assertFalse(entry.takeRequest())
    }

    @Test fun explicitLauncherEntryIsHonoredEvenIfPlaybackWasInTheBackground() {
        val entry = StartupEntry()
        entry.userLeave(playing = true, installing = false)
        entry.newIntent(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER))
        assertTrue(entry.takeRequest())
    }

    @Test fun launcherAlwaysRoutesThroughTheExistingShellInsteadOfAStaleChildActivity() {
        val context = RuntimeEnvironment.getApplication()
        val info = context.packageManager.getActivityInfo(ComponentName(context, ShellActivity::class.java), 0)
        assertEquals(ActivityInfo.LAUNCH_SINGLE_TASK, info.launchMode)
    }
}
