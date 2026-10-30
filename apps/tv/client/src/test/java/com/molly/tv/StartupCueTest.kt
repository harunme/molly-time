package com.molly.tv

import org.junit.Assert.*
import org.junit.Test

class StartupCueTest {
    @Test fun preparedSoundAndLogoStartTogetherOnce() {
        val events = mutableListOf<String>()
        val cue = StartupCue { events.add("logo") }
        assertTrue(cue.ready { events.add("sound") })
        assertFalse(cue.ready()) // Deadline after readiness cannot restart the logo.
        assertEquals(listOf("sound", "logo"), events)
    }
    @Test fun deadlineStartsSilentLogoAndRejectsLateSound() {
        val events = mutableListOf<String>()
        val cue = StartupCue { events.add("logo") }
        assertTrue(cue.ready())
        assertFalse(cue.ready { events.add("late sound") })
        assertEquals(listOf("logo"), events)
    }
    @Test fun cancellationPreventsSoundAndAnimationFromStarting() {
        val events = mutableListOf<String>()
        val cue = StartupCue { events.add("logo") }
        cue.cancel()
        assertFalse(cue.ready { events.add("sound") })
        assertTrue(events.isEmpty())
    }
}
