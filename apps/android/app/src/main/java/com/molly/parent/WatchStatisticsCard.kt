package com.molly.parent

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.BlurredEdgeTreatment
import androidx.compose.ui.draw.blur
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

@Composable
fun WatchStatisticsCard(watch: WatchStatistics, open: (String) -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surface, shape = MaterialTheme.shapes.extraLarge) {
        Column(
            Modifier.fillMaxWidth().padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(24.dp)) {
                listOf("today" to "今日观看", "recentWeek" to "近一周观看").forEach { (period, label) ->
                    Column(
                        Modifier.weight(1f).clickable { open(period) }.padding(vertical = 8.dp),
                        verticalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Text(
                            "$label ›",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            WatchStatistics.duration(
                                if (period == "today") watch.todayPlayedMs
                                else watch.recentWeekPlayedMs
                            ),
                            style = MaterialTheme.typography.titleMedium,
                        )
                    }
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text("最近 12 周", style = MaterialTheme.typography.bodySmall)
                Text("今天", style = MaterialTheme.typography.bodySmall)
            }
            val today =
                runCatching { LocalDate.now(ZoneId.of(watch.timezone)) }
                    .getOrDefault(LocalDate.now())
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    listOf("一", "", "三", "", "五", "", "日").forEach {
                        Text(
                            it,
                            fontSize = 10.sp,
                            modifier = Modifier.height(16.dp).width(12.dp),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                watch.recentWeeks.forEach { week ->
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        week.forEach { day ->
                            Box(
                                Modifier.height(16.dp).fillMaxWidth().semantics {
                                    day?.let {
                                        contentDescription =
                                            "${it.date}，${WatchStatistics.duration(it.playedMs)}"
                                    }
                                },
                                contentAlignment = Alignment.Center,
                            ) {
                                if (day?.date == today) TodayGlow()
                                Box(
                                    Modifier.size(13.dp)
                                        .background(
                                            if (day == null) Color.Transparent
                                            else if (day.level == 0)
                                                MaterialTheme.colorScheme.onSurface.copy(
                                                    alpha = .07f
                                                )
                                            else
                                                Jasmine.copy(
                                                    alpha =
                                                        listOf(0f, .35f, .55f, .8f, 1f)[day.level]
                                                ),
                                            CircleShape,
                                        )
                                )
                            }
                        }
                    }
                }
            }
            Row(
                horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("少", style = MaterialTheme.typography.bodySmall)
                (0..4).forEach { level ->
                    Box(
                        Modifier.size(6.dp)
                            .background(
                                if (level == 0)
                                    MaterialTheme.colorScheme.onSurface.copy(alpha = .07f)
                                else Jasmine.copy(alpha = listOf(0f, .35f, .55f, .8f, 1f)[level]),
                                CircleShape,
                            )
                    )
                }
                Text("多", style = MaterialTheme.typography.bodySmall)
            }
            Text(
                "近一年观看 ${watch.activeDays} 天 · 共 ${WatchStatistics.duration(watch.totalPlayedMs)}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
fun WatchReportContent(watch: WatchStatistics, period: String, api: ParentApi) {
    var report by remember { mutableStateOf<JSONObject?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var revision by remember { mutableIntStateOf(0) }
    var sessionPage by remember { mutableIntStateOf(1) }
    var contentPage by remember { mutableIntStateOf(1) }
    val end = watch.lastDate
    val start = if (period == "today") end else watch.recentWeekStart
    LaunchedEffect(api, start, end, revision, sessionPage, contentPage) {
        if (start == null || end == null) {
            failure = "暂时无法确定统计日期"
            return@LaunchedEffect
        }
        try {
            report =
                withContext(Dispatchers.IO) {
                    api.request(
                        "/api/manage/reports/watch-time?start=$start&end=$end&sessionPage=$sessionPage&contentPage=$contentPage&pageSize=10"
                    )
                }
            failure = null
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            failure = e.message
        }
    }
    Text(if (period == "today") "今日观看" else "近一周观看", style = MaterialTheme.typography.titleLarge)
    Text("$start — $end", style = MaterialTheme.typography.bodyMedium)
    if (report == null && failure == null) StorageSkeleton()
    failure?.let {
        Text(it, color = MaterialTheme.colorScheme.error)
        TextButton(
            onClick = { revision++ },
            colors =
                ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
        ) {
            Text("重新加载")
        }
    }
    report?.let { value ->
        Text(
            WatchStatistics.duration(value.optLong("totalPlayedMs")),
            style = MaterialTheme.typography.headlineMedium,
        )
        Text("观看 ${value.optInt("episodeCount")} 集", style = MaterialTheme.typography.bodyMedium)
        if (value.optLong("totalPlayedMs") == 0L)
            Text("这段时间还没有观看记录，好时光留给下一次。", style = MaterialTheme.typography.bodyMedium)
        val chartRows =
            value.optJSONArray(if (period == "today") "hours" else "days")?.objects().orEmpty()
        val peak = chartRows.maxOfOrNull { it.optLong("playedMs") }?.coerceAtLeast(1) ?: 1
        Hint(if (period == "today") "今天的观看时段" else "近 7 天的观看时光")
        Row(
            Modifier.fillMaxWidth().height(112.dp),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.SpaceAround,
        ) {
            chartRows.forEach { row ->
                val ms = row.optLong("playedMs")
                Box(
                    Modifier.width(8.dp)
                        .height(if (ms > 0) (108f * ms / peak).coerceAtLeast(5f).dp else 3.dp)
                        .background(
                            if (ms > 0) Jasmine else MaterialTheme.colorScheme.surfaceVariant,
                            androidx.compose.foundation.shape.RoundedCornerShape(4.dp),
                        )
                        .semantics {
                            contentDescription =
                                "${if(period=="today")"${row.optInt("hour")} 点"else row.optString("date")}，${WatchStatistics.duration(ms)}"
                        }
                )
            }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            if (period == "today")
                listOf("0 点", "6 点", "12 点", "18 点", "23 点").forEach {
                    Text(it, style = MaterialTheme.typography.bodySmall)
                }
            else
                chartRows.forEach {
                    Text(
                        it.optString("date").takeLast(5).replace('-', '/'),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
        }
        value
            .optJSONArray("devices")
            ?.objects()
            ?.takeIf { it.isNotEmpty() }
            ?.let { devices ->
                SurfaceBlock {
                    Column(
                        Modifier.padding(20.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        Text("在哪台电视看", style = MaterialTheme.typography.titleMedium)
                        devices.forEach { device ->
                            val ms =
                                value
                                    .optJSONArray("days")
                                    ?.objects()
                                    .orEmpty()
                                    .flatMap { it.optJSONArray("devices")?.objects().orEmpty() }
                                    .filter { it.opt("deviceId") == device.opt("id") }
                                    .sumOf { it.optLong("playedMs") }
                            Row {
                                Text(device.getString("name"), Modifier.weight(1f))
                                Text(WatchStatistics.duration(ms))
                            }
                        }
                    }
                }
            }
        var sessionsOpen by remember { mutableStateOf(false) }
        var contentsOpen by remember { mutableStateOf(false) }
        SurfaceBlock {
            ReportDisclosure("播放明细", value.optInt("sessionTotal"), sessionsOpen) {
                sessionsOpen = !sessionsOpen
            }
            if (sessionsOpen)
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    val sessions = value.optJSONArray("sessions")?.objects().orEmpty()
                    if (sessions.isEmpty()) Hint("还没有播放明细")
                    sessions.forEach { row ->
                        Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            Row {
                                Text(
                                    row.getString("name"),
                                    Modifier.weight(1f),
                                    style = MaterialTheme.typography.titleSmall,
                                )
                                Text(
                                    WatchStatistics.duration(row.optLong("playedMs")),
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                            Hint(
                                "${row.optString("deviceName")} · ${reportTime(row.optString("startedAt"),value.optString("timezone"))}"
                            )
                            Hint(if (row.optBoolean("ended")) "已结束" else "播放中或未正常结束")
                        }
                    }
                    ReportPages(
                        sessionPage,
                        value.optInt("sessionTotal"),
                        value.optInt("pageSize", 10),
                    ) {
                        sessionPage = it
                    }
                }
            HorizontalDivider(Modifier.padding(horizontal = 20.dp))
            ReportDisclosure("内容分布", value.optInt("contentTotal"), contentsOpen) {
                contentsOpen = !contentsOpen
            }
            if (contentsOpen)
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    val contents = value.optJSONArray("contents")?.objects().orEmpty()
                    if (contents.isEmpty()) Hint("还没有内容记录")
                    contents.forEach { row ->
                        Row {
                            Text(row.getString("name"), Modifier.weight(1f))
                            Text(
                                WatchStatistics.duration(row.optLong("playedMs")),
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        LinearProgressIndicator(
                            progress = {
                                (row.optLong("playedMs").toDouble() /
                                        value.optLong("totalPlayedMs").coerceAtLeast(1))
                                    .toFloat()
                                    .coerceIn(0f, 1f)
                            },
                            modifier = Modifier.fillMaxWidth(),
                            color = MaterialTheme.colorScheme.secondary,
                        )
                    }
                    ReportPages(
                        contentPage,
                        value.optInt("contentTotal"),
                        value.optInt("pageSize", 10),
                    ) {
                        contentPage = it
                    }
                }
        }
        if (!value.isNull("lastSync"))
            Hint("最后同步 ${reportTime(value.getString("lastSync"),value.optString("timezone"))}")
        Hint("仅统计电视观看 · ${value.optString("timezone")}")
    }
}

@Composable
private fun ReportPages(page: Int, total: Int, size: Int, select: (Int) -> Unit) {
    if (total <= size || size <= 0) return
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        TextButton(
            onClick = { select(page - 1) },
            enabled = page > 1,
            colors =
                ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
        ) {
            Text("上一页")
        }
        Text("$page / ${(total + size - 1) / size}", style = MaterialTheme.typography.bodySmall)
        TextButton(
            onClick = { select(page + 1) },
            enabled = page * size < total,
            colors =
                ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
        ) {
            Text("下一页")
        }
    }
}

@Composable
private fun ReportDisclosure(title: String, total: Int, expanded: Boolean, toggle: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = toggle).padding(20.dp).semantics {
            stateDescription = if (expanded) "已展开" else "已折叠"
        },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            "${if(expanded)"⌄"else"›"}  $title",
            Modifier.weight(1f),
            style = MaterialTheme.typography.titleMedium,
        )
        Text("$total", style = MaterialTheme.typography.bodySmall)
    }
}

internal fun reportTime(input: String, timezone: String): String =
    runCatching {
            java.time.Instant.parse(input)
                .atZone(ZoneId.of(timezone))
                .format(
                    java.time.format.DateTimeFormatter.ofPattern(
                        "MM/dd HH:mm",
                        java.util.Locale.CHINA,
                    )
                )
        }
        .getOrDefault("—")

@Composable
private fun TodayGlow() {
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    val state by lifecycle.currentStateFlow.collectAsState()
    val animated =
        android.animation.ValueAnimator.areAnimatorsEnabled() &&
            state.isAtLeast(Lifecycle.State.STARTED)
    val opacity: Float
    if (animated) {
        val transition = rememberInfiniteTransition(label = "today-glow")
        val pulse by
            transition.animateFloat(
                .3f,
                .8f,
                infiniteRepeatable(tween(1600, easing = FastOutSlowInEasing), RepeatMode.Reverse),
                label = "today-pulse",
            )
        opacity = pulse
    } else opacity = .45f
    Box(
        Modifier.size(20.dp)
            .graphicsLayer {
                alpha = opacity
                scaleX = if (animated) .85f + (opacity - .3f) * .8f else 1f
                scaleY = scaleX
            }
            .blur(5.dp, edgeTreatment = BlurredEdgeTreatment.Unbounded)
            .background(Jasmine, CircleShape)
    )
}
