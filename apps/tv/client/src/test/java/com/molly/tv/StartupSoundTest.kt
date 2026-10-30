package com.molly.tv

import android.app.Application
import android.os.Looper
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowMediaPlayer
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [28])
class StartupSoundTest {
    private val context get() = RuntimeEnvironment.getApplication()
    @Test fun unconfiguredPackageStartsSilentAnimationWithoutWaiting() {
        var animations = 0
        val sound = StartupSound(context) { false }
        try {
            sound.start(onReady = { animations++ }) { true }
            assertTrue(sound.finished); assertEquals(1, animations)
        } finally { sound.stop() }
    }
    @Test fun bundledAudioWaitsForSlowDecoderAndPlaysToCompletion() {
        val players = mutableListOf<ShadowMediaPlayer>()
        ShadowMediaPlayer.setMediaInfoProvider { ShadowMediaPlayer.MediaInfo(5000, 1000) }
        ShadowMediaPlayer.setCreateListener { _, player -> players.add(player) }
        var animations = 0
        var completions = 0
        val sound = StartupSound(context) { audio -> audio.setDataSource("bundled.mp3"); true }
        try {
            sound.start(onReady = { animations++ }, onFinished = { completions++ }) { true }
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(600))
            assertEquals(0, animations)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(400))
            assertEquals(1, animations); assertTrue(players.single().isReallyPlaying)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(2800))
            assertFalse(sound.finished); assertTrue(players.single().isReallyPlaying)
            shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(2200))
            assertTrue(sound.finished); assertEquals(1, completions); assertEquals(1, animations)
        } finally { sound.stop(); ShadowMediaPlayer.setCreateListener(null) }
    }
    @Test fun transientLocalPreparationFailureRetriesBeforeStartingLogo() {
        ShadowMediaPlayer.setMediaInfoProvider { ShadowMediaPlayer.MediaInfo(1000, 0) }
        var attempts = 0
        var animations = 0
        val sound = StartupSound(context) { audio ->
            attempts++
            if (attempts == 1) throw java.io.IOException("temporary decoder failure")
            audio.setDataSource("bundled.mp3"); true
        }
        try {
            sound.start(onReady = { animations++ }) { true }
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(2, attempts); assertEquals(1, animations); assertFalse(sound.finished)
        } finally { sound.stop() }
    }
    @Test fun leavingAppDuringPreparationCancelsSoundAndCallbacks() {
        ShadowMediaPlayer.setMediaInfoProvider { ShadowMediaPlayer.MediaInfo(5000, 1000) }
        var animations = 0
        val sound = StartupSound(context) { audio -> audio.setDataSource("bundled.mp3"); true }
        sound.start(onReady = { animations++ }) { true }
        sound.stop()
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(10))
        assertEquals(0, animations)
    }
}
