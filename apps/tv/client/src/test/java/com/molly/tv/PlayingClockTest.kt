package com.molly.tv

import org.junit.Assert.assertEquals
import org.junit.Test

class PlayingClockTest {
    @Test fun pauseBufferAndSeekDoNotAccumulatePlayingTime() {
        val clock = PlayingClock(1000)
        assertEquals(0L, clock.sample(3000, true).sumOf { it.played })
        assertEquals(10000L, clock.sample(13000, false).sumOf { it.played })
        assertEquals(0L, clock.sample(28000, true).sumOf { it.played })
        assertEquals(5000L, clock.sample(33000, true).sumOf { it.played })
    }
    @Test fun delayedHeartbeatSplitsIntoBoundedContiguousIntervals() {
        val clock = PlayingClock(500)
        clock.sample(500, true)
        val intervals = clock.sample(150500, false)
        assertEquals(listOf(60000L, 60000L, 30000L), intervals.map { it.played })
        assertEquals(150000L, intervals.last().end)
        assertEquals(intervals[0].end, intervals[1].start)
    }
}
