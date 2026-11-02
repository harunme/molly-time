package com.molly.tv

import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.CancellationException
import java.util.concurrent.TimeoutException
import javax.net.ssl.SSLException

/** Catalog synchronization state never decides whether a playback request can run. */
internal object PlaybackAccess {
    /** Only retry reads. Never replay session creation or other commands after an uncertain response. */
    fun <T> read(active: () -> Boolean = { true }, operation: () -> T): T {
        for (attempt in 0..1) {
            if (!active() || Thread.currentThread().isInterrupted) throw CancellationException()
            try {
                val result = operation()
                if (!active()) throw CancellationException()
                return result
            } catch (failure: IOException) {
                if (attempt == 1 || failure is SSLException || Thread.currentThread().isInterrupted) throw failure
                if (!active()) throw CancellationException()
            }
        }
        error("unreachable")
    }

    fun isTimeout(error: Throwable): Boolean = generateSequence(error) { it.cause }.take(6)
        .any { it is InterruptedIOException || it is TimeoutException }

    fun message(error: Throwable, fallback: String): String = when {
        isTimeout(error) -> "连接超时，请检查网络后重试"
        error is IOException -> "网络连接中断，请重试"
        error is ApiFailure || error is IllegalStateException || error is IllegalArgumentException -> error.message ?: fallback
        else -> fallback
    }

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
