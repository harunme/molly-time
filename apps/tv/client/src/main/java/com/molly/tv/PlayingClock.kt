package com.molly.tv

/** Exact wall-clock playing segments; media position and playback speed never enter the clock. */
class PlayingClock(private val origin: Long) {
    data class Segment(val start: Long, val end: Long, val played: Long)
    private var last = origin
    private var playing = false
    fun sample(now: Long, isPlaying: Boolean): List<Segment> {
        val end = now.coerceAtLeast(last)
        val result = mutableListOf<Segment>()
        // Bounded intervals also cover a delayed heartbeat without exceeding API limits.
        var begin = last
        while (begin < end) {
            val edge = minOf(end, begin + 60000)
            result.add(Segment(begin - origin, edge - origin, if (playing) edge - begin else 0))
            begin = edge
        }
        last = end
        playing = isPlaying
        return result
    }
    fun offset(now: Long) = (now - origin).coerceAtLeast(0)
}
