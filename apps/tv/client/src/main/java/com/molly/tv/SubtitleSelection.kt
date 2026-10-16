package com.molly.tv

import androidx.media3.common.C
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.TrackSelectionParameters
import androidx.media3.common.util.UnstableApi

@UnstableApi
internal object SubtitleSelection {
    fun parameters(
        current: TrackSelectionParameters,
        selectedId: String?,
        trackOverride: TrackSelectionOverride?,
    ): TrackSelectionParameters {
        // Track discovery is asynchronous. A missing track is not an instruction
        // to turn subtitles off; keep the selection until a later tracks event.
        if (selectedId != "off" && trackOverride == null) return current
        val builder = current.buildUpon().clearOverridesOfType(C.TRACK_TYPE_TEXT)
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, selectedId == "off")
        if (selectedId != "off" && trackOverride != null) builder.setOverrideForType(trackOverride)
        return builder.build()
    }

    fun menuIndex(selectedId: String?, availableIds: List<String>): Int =
        if (selectedId == "off") 0
        else availableIds.indexOf(selectedId).let { if (it < 0) -1 else it + 1 }
}
