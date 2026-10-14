package com.molly.tv

import android.app.Application
import android.os.Looper
import androidx.media3.common.Player
import androidx.media3.common.MediaItem
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Proxy
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [28])
class ThreadedPlayerTest {
    private fun until(condition: () -> Boolean) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (!condition() && System.nanoTime() < deadline) {
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(10)
        }
        assertTrue("Timed out waiting for player lifecycle", condition())
    }

    @Test fun closeDuringInitializationDoesNotPublishAPlayerOrLeakTheThread() {
        val context = RuntimeEnvironment.getApplication()
        val owner = ThreadedPlayer(context)
        val initializing = CountDownLatch(1)
        val allowInitialization = CountDownLatch(1)
        val workerLooper = AtomicReference<Looper>()
        val connected = AtomicReference<Player>()
        val failure = AtomicReference<Throwable>()
        owner.connect({ looper ->
            workerLooper.set(looper)
            initializing.countDown()
            check(allowInitialization.await(10, TimeUnit.SECONDS))
            ExoPlayer.Builder(context).setLooper(looper).build()
        }, { connected.set(it) }, { failure.set(it) })
        try {
            assertTrue(initializing.await(10, TimeUnit.SECONDS))
            owner.release()
            owner.release()
        } finally { allowInitialization.countDown() }
        until { !workerLooper.get().thread.isAlive }
        assertNull(connected.get())
        assertNull(failure.get())
    }

    @Test fun aBlockedEngineReleaseDoesNotBlockTheMainThread() {
        val context = RuntimeEnvironment.getApplication()
        val owner = ThreadedPlayer(context)
        val workerLooper = AtomicReference<Looper>()
        val connected = AtomicReference<Player>()
        val failure = AtomicReference<Throwable>()
        val releaseStarted = CountDownLatch(1)
        val allowRelease = CountDownLatch(1)
        val releases = AtomicInteger()
        val releaseLooper = AtomicReference<Looper>()
        owner.connect({ looper ->
            workerLooper.set(looper)
            val engine = ExoPlayer.Builder(context).setLooper(looper).build()
            Proxy.newProxyInstance(ExoPlayer::class.java.classLoader, arrayOf(ExoPlayer::class.java)) { _, method, args ->
                if (method.name == "release") {
                    releases.incrementAndGet()
                    releaseLooper.set(Looper.myLooper())
                    releaseStarted.countDown()
                    check(allowRelease.await(10, TimeUnit.SECONDS))
                }
                try { method.invoke(engine, *(args ?: emptyArray())) }
                catch (error: InvocationTargetException) { throw error.targetException }
            } as ExoPlayer
        }, { connected.set(it) }, { failure.set(it) })
        try {
            until { connected.get() != null || failure.get() != null }
            assertNull(failure.get())
            assertSame(Looper.getMainLooper(), connected.get().applicationLooper)
            assertNotSame(Looper.getMainLooper(), workerLooper.get())
            owner.release()
            owner.release()
            assertTrue(releaseStarted.await(10, TimeUnit.SECONDS))
            assertSame(workerLooper.get(), releaseLooper.get())
            // The engine remains deliberately blocked while the UI loop runs.
            var frameRan = false
            android.os.Handler(Looper.getMainLooper()).post { frameRan = true }
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(frameRan)
        } finally { allowRelease.countDown(); owner.release() }
        until { !workerLooper.get().thread.isAlive }
        assertEquals(1, releases.get())
    }

    @Test fun controllerPreservesMediaConfigurationAndPlaybackPreferences() {
        val context = RuntimeEnvironment.getApplication()
        val owner = ThreadedPlayer(context)
        val workerLooper = AtomicReference<Looper>()
        val engine = AtomicReference<ExoPlayer>()
        val controller = AtomicReference<Player>()
        val failure = AtomicReference<Throwable>()
        val configured = AtomicReference<Boolean>(false)
        owner.connect({ looper ->
            workerLooper.set(looper)
            ExoPlayer.Builder(context).setLooper(looper).build().also { engine.set(it) }
        }, { controller.set(it) }, { failure.set(it) })
        try {
            until { controller.get() != null || failure.get() != null }
            assertNull(failure.get())
            val ui = controller.get()
            val subtitle = MediaItem.SubtitleConfiguration.Builder(android.net.Uri.parse("https://media.test/sub.vtt"))
                .setMimeType("text/vtt").setLanguage("zh").build()
            ui.setMediaItem(MediaItem.Builder().setMediaId("episode-1").setUri("https://media.test/video.mp4")
                .setMimeType("video/mp4").setCustomCacheKey("media-1:version-1")
                .setSubtitleConfigurations(listOf(subtitle)).build(), 15000)
            ui.setPlaybackSpeed(1.5f)
            ui.trackSelectionParameters = ui.trackSelectionParameters.buildUpon().setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true).build()
            until {
                android.os.Handler(workerLooper.get()).post {
                    val player = engine.get()
                    val item = player.currentMediaItem
                    configured.set(item?.mediaId == "episode-1" &&
                        item.localConfiguration?.customCacheKey == "media-1:version-1" &&
                        item.localConfiguration?.subtitleConfigurations?.firstOrNull()?.language == "zh" &&
                        player.currentPosition == 15000L && player.playbackParameters.speed == 1.5f &&
                        player.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT))
                }
                configured.get()
            }
        } finally { owner.release() }
        until { !workerLooper.get().thread.isAlive }
    }
}
