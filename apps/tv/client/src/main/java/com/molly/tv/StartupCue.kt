package com.molly.tv

/** Main-thread gate: a late sound can never join an animation already in progress. */
internal class StartupCue(private val animate: () -> Unit) {
    var started = false
        private set
    fun ready(playSound: (() -> Unit)? = null): Boolean {
        if (started) return false
        started = true
        try { playSound?.invoke() } finally { animate() }
        return true
    }
    fun cancel() { started = true }
}
