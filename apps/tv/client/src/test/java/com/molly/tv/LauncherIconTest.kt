package com.molly.tv

import android.app.Application
import android.graphics.drawable.LayerDrawable
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [23], qualifiers = "mdpi")
class LauncherIconTest {
    @Test fun legacyIconPreservesItsAspectRatioInInstallerContainers() {
        val application = RuntimeEnvironment.getApplication()
        for ((width, height) in listOf(48 to 48, 96 to 48, 48 to 96, 96 to 64, 64 to 96)) {
            val icon = application.getDrawable(R.mipmap.ic_launcher) as LayerDrawable
            icon.setBounds(0, 0, width, height)
            val artwork = icon.getDrawable(0).bounds
            assertEquals("The icon artwork must remain square", artwork.width(), artwork.height())
            assertEquals(width / 2, artwork.centerX())
            assertEquals(height / 2, artwork.centerY())
            assertTrue(artwork.width() <= width && artwork.height() <= height)
        }
    }
}
