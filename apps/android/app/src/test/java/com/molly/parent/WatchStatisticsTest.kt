package com.molly.parent

import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.LocalDate

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class WatchStatisticsTest {
    @Test fun recentWeekUsesServerDateKeysIncludingCrossMonth() {
        val days = JSONArray()
        val start = LocalDate.parse("2026-10-29")
        (0..8).forEach { days.put(json("date" to start.plusDays(it.toLong()).toString(), "playedMs" to 60_000)) }
        val watch = WatchStatistics(json("days" to days, "timezone" to "Pacific/Honolulu"))
        assertEquals(LocalDate.parse("2026-10-31"), watch.recentWeekStart)
        assertEquals(420_000L, watch.recentWeekPlayedMs); assertEquals(540_000L, watch.totalPlayedMs)
        assertEquals(9, watch.activeDays)
    }
    @Test fun heatmapStartsMondayAndLeavesFutureDatesBlank() {
        val watch = WatchStatistics(json("days" to JSONArray().put(json("date" to "2024-02-29", "playedMs" to 900_000))))
        assertEquals(12, watch.recentWeeks.size)
        val last = watch.recentWeeks.last()
        assertEquals(LocalDate.parse("2024-02-29"), last[3]!!.date)
        assertNull(last[4]); assertNull(last[6])
        assertEquals(2, last[3]!!.level)
    }
    @Test fun invalidDatesAreRejectedAndDurationsMatchIOS() {
        val watch = WatchStatistics(json("days" to JSONArray().put(json("date" to "2023-02-29", "playedMs" to 1))))
        assertTrue(watch.days.isEmpty())
        assertEquals("0 分钟", WatchStatistics.duration(0)); assertEquals("1 秒", WatchStatistics.duration(1))
        assertEquals("1 分钟", WatchStatistics.duration(60_000)); assertEquals("1 小时 1 分钟", WatchStatistics.duration(3_660_000))
    }
}
