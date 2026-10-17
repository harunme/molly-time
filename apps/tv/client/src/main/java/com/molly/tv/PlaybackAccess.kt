package com.molly.tv

import java.io.IOException

/** Catalog synchronization state never decides whether a playback request can run. */
internal object PlaybackAccess {
    fun <T> load(online: () -> T, offline: () -> T): T = try {
        online()
    } catch (networkFailure: IOException) {
        try {
            offline()
        } catch (offlineFailure: Exception) {
            // A missing or invalid local copy must not hide the request failure.
            networkFailure.addSuppressed(offlineFailure)
            throw networkFailure
        }
    }
}
