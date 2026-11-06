package com.molly.parent

import org.json.JSONObject
import java.time.LocalDate
import kotlin.math.roundToLong

/** Date-only keys are already in the family's timezone, exactly as MollyCore WatchStatistics. */
class WatchStatistics(value: JSONObject) {
    data class Day(val date: LocalDate, val playedMs: Long) {
        val level get() = when { playedMs <= 0 -> 0; playedMs < 900_000 -> 1; playedMs < 1_800_000 -> 2; playedMs < 3_600_000 -> 3; else -> 4 }
    }
    val timezone = value.optString("timezone", "Asia/Shanghai")
    val todayPlayedMs = value.optLong("todayPlayedMs")
    val days = value.optJSONArray("days")?.objects().orEmpty().mapNotNull { row -> runCatching { Day(LocalDate.parse(row.getString("date")), row.getLong("playedMs").coerceAtLeast(0)) }.getOrNull() }.sortedBy { it.date }
    val lastDate get() = days.lastOrNull()?.date
    val recentWeekStart get() = lastDate?.minusDays(6)
    val recentWeekPlayedMs get() = recentWeekStart?.let { start -> days.filter { !it.date.isBefore(start) }.sumOf { it.playedMs } } ?: 0L
    val totalPlayedMs get() = days.sumOf { it.playedMs }
    val activeDays get() = days.count { it.playedMs > 0 }
    val hasViewingHistory get() = todayPlayedMs > 0 || valueWeekPlayedMs > 0 || activeDays > 0
    private val valueWeekPlayedMs = value.optLong("weekPlayedMs")
    val recentWeeks: List<List<Day?>> get() {
        val last = lastDate ?: return emptyList()
        val start = last.minusDays((last.dayOfWeek.value - 1).toLong()).minusDays(77)
        val lookup = days.associateBy { it.date }
        return (0..11).map { week -> (0..6).map { day -> lookup[start.plusDays((week * 7 + day).toLong())] } }
    }
    companion object {
        fun duration(ms: Long): String {
            if (ms <= 0) return "0 分钟"
            if (ms < 60_000) return "${(ms / 1000.0).roundToLong().coerceAtLeast(1)} 秒"
            val minutes = ms / 60_000
            return if (minutes < 60) "$minutes 分钟" else if (minutes % 60 == 0L) "${minutes / 60} 小时" else "${minutes / 60} 小时 ${minutes % 60} 分钟"
        }
    }
}
