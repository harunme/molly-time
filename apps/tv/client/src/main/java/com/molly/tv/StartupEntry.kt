package com.molly.tv

import android.content.Intent

/** A launcher entry is different from returning from one of our own screens. */
internal class StartupEntry {
    private var requested = false

    fun newIntent(intent: Intent) {
        if (intent.action == Intent.ACTION_MAIN &&
            (intent.hasCategory(Intent.CATEGORY_LAUNCHER) || intent.hasCategory(Intent.CATEGORY_LEANBACK_LAUNCHER))) {
            requested = true
        }
    }

    fun userLeave(playing: Boolean, installing: Boolean) {
        // Launching playback or the system installer can also trigger this hint.
        if (!playing && !installing) requested = true
    }

    fun takeRequest(): Boolean = requested.also { requested = false }
}
