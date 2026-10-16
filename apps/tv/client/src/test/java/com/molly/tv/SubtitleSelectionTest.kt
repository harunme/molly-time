package com.molly.tv

import android.app.Application
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.TrackGroup
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.TrackSelectionParameters
import androidx.media3.common.util.UnstableApi
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [28])
class SubtitleSelectionTest {
    private fun defaults() = TrackSelectionParameters.Builder(RuntimeEnvironment.getApplication()).build()
    private fun subtitle(id: String) = TrackSelectionOverride(TrackGroup(id,
        Format.Builder().setId(id).setSampleMimeType(MimeTypes.TEXT_VTT).setLanguage("zh").build()), 0)

    @Test fun preferredTrackCanArriveAfterAnEmptyTracksEvent() {
        val initial = defaults()
        val pending = SubtitleSelection.parameters(initial, "subtitle-0", null)
        assertSame(initial, pending)
        assertFalse(pending.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT))
        val track = subtitle("subtitle-0")
        val ready = SubtitleSelection.parameters(pending, "subtitle-0", track)
        assertEquals(track, ready.overrides[track.mediaTrackGroup])
        assertFalse(ready.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT))
        // Refreshes and temporary unsupported/missing tracks must not erase a choice.
        assertSame(ready, SubtitleSelection.parameters(ready, "subtitle-0", null))
        assertEquals(ready, SubtitleSelection.parameters(ready, "subtitle-0", track))
    }

    @Test fun explicitOffClearsSubtitleOverrideAndRemainsOffWhileTracksChange() {
        val track = subtitle("subtitle-0")
        val audio = TrackSelectionOverride(TrackGroup("audio",
            Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).build()), 0)
        val initial = defaults().buildUpon().setOverrideForType(track).setOverrideForType(audio).build()
        val off = SubtitleSelection.parameters(initial, "off", track)
        assertTrue(off.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT))
        assertFalse(off.overrides.containsKey(track.mediaTrackGroup))
        assertEquals(audio, off.overrides[audio.mediaTrackGroup])
        assertEquals(off, SubtitleSelection.parameters(off, "off", null))
        val enabled = SubtitleSelection.parameters(off, "subtitle-0", track)
        assertFalse(enabled.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT))
        assertEquals(track, enabled.overrides[track.mediaTrackGroup])
    }

    @Test fun manualTrackChangeReplacesTheOldOverride() {
        val first = subtitle("subtitle-0")
        val second = subtitle("subtitle-1")
        val initial = SubtitleSelection.parameters(defaults(), "subtitle-0", first)
        val changed = SubtitleSelection.parameters(initial, "subtitle-1", second)
        assertFalse(changed.overrides.containsKey(first.mediaTrackGroup))
        assertEquals(second, changed.overrides[second.mediaTrackGroup])
    }

    @Test fun aPendingOrMissingTrackIsNeverDisplayedAsOff() {
        assertEquals(-1, SubtitleSelection.menuIndex("subtitle-0", emptyList()))
        assertEquals(-1, SubtitleSelection.menuIndex("subtitle-0", listOf("subtitle-1")))
        assertEquals(-1, SubtitleSelection.menuIndex(null, listOf("subtitle-0")))
        assertEquals(0, SubtitleSelection.menuIndex("off", emptyList()))
        assertEquals(2, SubtitleSelection.menuIndex("subtitle-1", listOf("subtitle-0", "subtitle-1")))
    }
}
