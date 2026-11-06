@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.molly.parent

import android.app.Application
import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import androidx.media3.common.*
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.AspectRatioFrameLayout
import androidx.media3.ui.PlayerView
import kotlinx.coroutines.*
import org.json.JSONObject

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class PhonePlaybackModel(application: Application) : AndroidViewModel(application) {
    private val app = application as ParentApplication
    private val owner = app.api
    val player =
        ExoPlayer.Builder(app)
            .setAudioAttributes(AudioAttributes.DEFAULT, true)
            .setLoadControl(
                DefaultLoadControl.Builder()
                    .setBufferDurationsMs(10_000, 10_000, 1000, 2000)
                    .build()
            )
            .build()
    var loading by mutableStateOf(true)
        private set

    var failure by mutableStateOf<String?>(null)
        private set

    var tracks by mutableStateOf<List<JSONObject>>(emptyList())
        private set

    var selected by mutableStateOf<Int?>(null)
        private set

    var position by mutableLongStateOf(0L)
        private set

    var duration by mutableLongStateOf(0L)
        private set

    var playing by mutableStateOf(false)
        private set

    var waiting by mutableStateOf(false)
        private set

    var speed by mutableFloatStateOf(1f)
        private set

    var title by mutableStateOf("")
        private set

    var invalidAccount by mutableStateOf(false)
        private set

    private var hasPlayback = false
    var fills by mutableStateOf(false)
    private var cacheDisabled = false
    private var selectionInitialized = false
    private var initialPlayback = true
    private var id = ""
    private var path: String? = null
    private var progressKey = ""
    private var task: Job? = null
    val validAccount
        get() = owner != null && app.api === owner

    init {
        player.addListener(
            object : Player.Listener {
                override fun onTracksChanged(tracks: Tracks) {
                    applySubtitles()
                }

                override fun onPlayerError(error: PlaybackException) {
                    if (
                        !cacheDisabled &&
                            generateSequence<Throwable>(error) { it.cause }
                                .any { it is RangeUnsupportedException }
                    ) {
                        cacheDisabled = true
                        load()
                        return
                    }
                    loading = false
                    waiting = false
                    failure = "视频暂时无法播放。可能是链接已过期、网络中断或格式不受支持，请重新加载。"
                }

                override fun onPlaybackStateChanged(state: Int) {
                    loading = state == Player.STATE_BUFFERING
                    waiting = loading
                    duration = player.duration.takeIf { it > 0 } ?: 0
                    if (state == Player.STATE_ENDED) {
                        playing = false
                        save()
                    }
                }

                override fun onPlayWhenReadyChanged(ready: Boolean, reason: Int) {
                    playing = ready && player.playbackState != Player.STATE_ENDED
                }
            }
        )
        viewModelScope.launch {
            var ticks = 0
            while (isActive) {
                if (!validAccount) {
                    invalidAccount = true
                    player.pause()
                }
                position = player.currentPosition.coerceAtLeast(0)
                duration = player.duration.takeIf { it > 0 } ?: 0
                if (++ticks % 20 == 0) save()
                delay(250)
            }
        }
    }

    fun prepare(episode: String, label: String, playbackPath: String?) {
        if (id == episode && path == playbackPath) return
        hasPlayback = false
        id = episode
        path = playbackPath
        title = label
        progressKey = if (path == null) digest("${app.accountKey}|$id".toByteArray()) else ""
        load()
    }

    fun load() {
        val api = owner ?: return
        task?.cancel()
        loading = true
        failure = null
        val shouldPlay = initialPlayback || player.playWhenReady
        val resume =
            player.currentPosition.takeIf { it > 0 }
                ?: if (progressKey.isEmpty()) 0
                else app.getSharedPreferences("parent-progress", 0).getLong(progressKey, 0)
        task =
            viewModelScope.launch {
                try {
                    val info =
                        withContext(Dispatchers.IO) {
                            api.request(path ?: "/api/episodes/${ParentApi.segment(id)}/playback")
                        }
                    if (!validAccount) return@launch
                    tracks = info.optJSONArray("subtitles")?.objects().orEmpty()
                    if (!selectionInitialized) {
                        selected =
                            tracks.firstOrNull { it.optBoolean("isDefault") }?.optInt("index")
                        selectionInitialized = true
                    }
                    val configurations =
                        tracks.map { sub ->
                            MediaItem.SubtitleConfiguration.Builder(
                                    android.net.Uri.parse(
                                        api.endpoint.resolve(sub.getString("url")).toString()
                                    )
                                )
                                .setId(sub.getInt("index").toString())
                                .setMimeType(MimeTypes.TEXT_VTT)
                                .setLabel(sub.getString("label"))
                                .setSelectionFlags(
                                    if (sub.optInt("index") == selected) C.SELECTION_FLAG_DEFAULT
                                    else 0
                                )
                                .build()
                        }
                    val upstream =
                        DefaultDataSource.Factory(app, OkHttpDataSource.Factory(api.mediaClient))
                    val key = if (cacheDisabled) null else MediaDiskCache.key(app.accountKey, info)
                    val source =
                        if (key != null) MediaDiskCache.factory(api, info, key, upstream)
                        else upstream
                    player.setMediaSource(
                        DefaultMediaSourceFactory(source)
                            .createMediaSource(
                                MediaItem.Builder()
                                    .setUri(api.endpoint.resolve(info.getString("url")).toString())
                                    .setSubtitleConfigurations(configurations)
                                    .build()
                            )
                    )
                    player.seekTo(resume)
                    hasPlayback = true
                    player.setPlaybackSpeed(speed)
                    applySubtitles()
                    player.prepare()
                    player.playWhenReady = shouldPlay
                    initialPlayback = false
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    failure = e.message ?: "无法加载视频"
                    loading = false
                }
            }
    }

    fun selectSubtitle(index: Int?) {
        selected = index
        applySubtitles()
    }

    private fun applySubtitles() {
        val builder =
            player.trackSelectionParameters
                .buildUpon()
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, selected == null)
        builder.clearOverridesOfType(C.TRACK_TYPE_TEXT)
        // Native tracks retain their subtitle configuration id; override only the selected track.
        player.currentTracks.groups
            .filter { it.type == C.TRACK_TYPE_TEXT }
            .firstOrNull { group ->
                (0 until group.length).any { group.getTrackFormat(it).id == selected?.toString() }
            }
            ?.let { group ->
                val index =
                    (0 until group.length).first {
                        group.getTrackFormat(it).id == selected?.toString()
                    }
                builder.setOverrideForType(
                    TrackSelectionOverride(group.mediaTrackGroup, listOf(index))
                )
            }
        player.trackSelectionParameters = builder.build()
    }

    fun changeSpeed(value: Float) {
        speed = value
        player.setPlaybackSpeed(value)
    }

    fun seek(value: Long) {
        player.seekTo(value.coerceIn(0, duration.coerceAtLeast(0)))
        position = value
    }

    fun toggle() {
        if (player.playWhenReady) pause()
        else {
            if (duration > 0 && position >= duration - 200) player.seekTo(0)
            player.playWhenReady = true
        }
    }

    fun pause() {
        player.pause()
        save()
    }

    fun continuePlaying() {
        failure = null
        player.playWhenReady = true
    }

    private fun save() {
        if (progressKey.isEmpty() || !hasPlayback) return
        val value = player.currentPosition.coerceAtLeast(0)
        val length = player.duration
        app.getSharedPreferences("parent-progress", 0)
            .edit()
            .putLong(progressKey, if (length > 0 && length - value < 5000) 0 else value)
            .apply()
    }

    override fun onCleared() {
        save()
        task?.cancel()
        player.release()
        super.onCleared()
    }
}

@androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
class PlayerActivity : ComponentActivity() {
    private val model: PhonePlaybackModel by viewModels()

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        enableEdgeToEdge()
        androidx.core.view.WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(androidx.core.view.WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior =
                androidx.core.view.WindowInsetsControllerCompat
                    .BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        if ((application as ParentApplication).api == null) {
            finish()
            return
        }
        model.prepare(
            intent.getStringExtra("id") ?: "",
            intent.getStringExtra("name") ?: "",
            intent.getStringExtra("path"),
        )
        setContent { MollyTheme { PhonePlayer(model) { finish() } } }
    }

    override fun onStart() {
        super.onStart()
        if (!model.validAccount) finish()
    }

    override fun onStop() {
        if (!isChangingConfigurations) model.pause()
        super.onStop()
    }

    @Composable
    private fun PhonePlayer(m: PhonePlaybackModel, close: () -> Unit) {
        LaunchedEffect(m.invalidAccount) { if (m.invalidAccount) close() }
        var controls by remember { mutableStateOf(true) }
        var options by remember { mutableStateOf("") }
        var interaction by remember { mutableIntStateOf(0) }
        var scrubbing by remember { mutableStateOf(false) }
        var scrub by remember { mutableFloatStateOf(0f) }
        var resume by remember { mutableStateOf(false) }
        val spokenFeedback =
            (getSystemService(android.content.Context.ACCESSIBILITY_SERVICE)
                    as android.view.accessibility.AccessibilityManager)
                .isTouchExplorationEnabled
        LaunchedEffect(controls, m.playing, interaction, options, scrubbing) {
            if (controls && m.playing && options.isEmpty() && !scrubbing && !spokenFeedback) {
                delay(4000)
                controls = false
            }
        }
        DisposableEffect(m.playing, m.waiting) {
            if (m.playing || m.waiting)
                window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            onDispose { window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
        }
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            AndroidView(
                factory = {
                    PlayerView(it).apply {
                        useController = false
                        player = m.player
                    }
                },
                update = {
                    it.player = m.player
                    it.resizeMode =
                        if (m.fills) AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                        else AspectRatioFrameLayout.RESIZE_MODE_FIT
                },
                modifier = Modifier.fillMaxSize(),
            )
            Box(
                Modifier.fillMaxSize().clickable {
                    controls = !controls
                    interaction++
                }
            )
            if (controls)
                Column(
                    Modifier.fillMaxSize()
                        .safeDrawingPadding()
                        .background(Color.Black.copy(alpha = .25f))
                        .padding(16.dp),
                    verticalArrangement = Arrangement.SpaceBetween,
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconButton(onClick = close) {
                            Icon(Icons.Outlined.Close, "关闭播放器", tint = Color.White)
                        }
                        Text(m.title, Modifier.weight(1f), color = Color.White, maxLines = 1)
                        IconButton(
                            onClick = {
                                m.fills = !m.fills
                                interaction++
                            }
                        ) {
                            Icon(
                                if (m.fills) Icons.Outlined.FullscreenExit
                                else Icons.Outlined.Fullscreen,
                                if (m.fills) "适应屏幕" else "填满屏幕",
                                tint = Color.White,
                            )
                        }
                    }
                    if (!m.loading && m.failure == null)
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement =
                                Arrangement.spacedBy(24.dp, Alignment.CenterHorizontally),
                        ) {
                            IconButton(
                                onClick = {
                                    m.seek((m.position - 10000).coerceAtLeast(0))
                                    interaction++
                                }
                            ) {
                                Icon(Icons.Outlined.Replay10, "后退 10 秒", tint = Color.White)
                            }
                            IconButton(
                                onClick = {
                                    m.toggle()
                                    interaction++
                                },
                                modifier = Modifier.size(64.dp),
                            ) {
                                Icon(
                                    if (m.playing) Icons.Outlined.Pause
                                    else Icons.Outlined.PlayArrow,
                                    if (m.playing) "暂停" else "播放",
                                    tint = Color.White,
                                    modifier = Modifier.size(40.dp),
                                )
                            }
                            IconButton(
                                onClick = {
                                    m.seek((m.position + 10000).coerceAtMost(m.duration))
                                    interaction++
                                }
                            ) {
                                Icon(Icons.Outlined.Forward10, "前进 10 秒", tint = Color.White)
                            }
                        }
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                time(if (scrubbing) scrub.toLong() else m.position),
                                modifier = Modifier.widthIn(min = 48.dp),
                                maxLines = 1,
                                softWrap = false,
                                color = Color.White,
                                style = MaterialTheme.typography.bodySmall,
                            )
                            Slider(
                                value =
                                    if (scrubbing) scrub
                                    else
                                        m.position
                                            .toFloat()
                                            .coerceIn(0f, m.duration.coerceAtLeast(1).toFloat()),
                                onValueChange = {
                                    if (!scrubbing) {
                                        scrubbing = true
                                        resume = m.playing
                                        m.pause()
                                    }
                                    scrub = it
                                },
                                onValueChangeFinished = {
                                    m.seek(scrub.toLong())
                                    scrubbing = false
                                    if (resume) m.continuePlaying()
                                    interaction++
                                },
                                valueRange = 0f..m.duration.coerceAtLeast(1).toFloat(),
                                modifier =
                                    Modifier.weight(1f).semantics {
                                        contentDescription = "播放进度"
                                        stateDescription =
                                            "${time(m.position)}，总时长 ${time(m.duration)}"
                                    },
                                thumb = {
                                    Box(Modifier.size(12.dp).background(Color.White, CircleShape))
                                },
                                track = { state ->
                                    SliderDefaults.Track(
                                        state,
                                        modifier = Modifier.height(4.dp),
                                        thumbTrackGapSize = 0.dp,
                                        drawStopIndicator = null,
                                        colors =
                                            SliderDefaults.colors(
                                                activeTrackColor = Color.White,
                                                inactiveTrackColor = Color.White.copy(alpha = .3f),
                                            ),
                                    )
                                },
                                enabled = m.duration > 0,
                            )
                            Text(
                                time(m.duration),
                                modifier = Modifier.widthIn(min = 48.dp),
                                maxLines = 1,
                                softWrap = false,
                                color = Color.White,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        Row {
                            TextButton(onClick = { options = "speed" }) {
                                Text("${m.speed}×", color = Color.White)
                            }
                            TextButton(onClick = { options = "subtitles" }) {
                                Text("字幕", color = Color.White)
                            }
                        }
                    }
                }
            if (m.loading)
                CircularProgressIndicator(Modifier.align(Alignment.Center), color = Color.White)
            m.failure?.let {
                AlertDialog(
                    onDismissRequest = {},
                    title = { Text("播放未完成") },
                    text = { Text(it) },
                    confirmButton = { TextButton(onClick = { m.load() }) { Text("重新加载") } },
                    dismissButton = {
                        TextButton(onClick = { m.continuePlaying() }) { Text("继续观看") }
                    },
                )
            }
            if (options.isNotEmpty())
                ModalBottomSheet(onDismissRequest = { options = "" }) {
                    SheetContent {
                        Text(
                            if (options == "speed") "播放速度" else "字幕",
                            style = MaterialTheme.typography.titleLarge,
                        )
                        if (options == "speed")
                            listOf(.75f, 1f, 1.25f, 1.5f, 2f).forEach { value ->
                                TextButton(
                                    onClick = {
                                        m.changeSpeed(value)
                                        options = ""
                                        interaction++
                                    }
                                ) {
                                    Text("$value×")
                                }
                            }
                        else {
                            TextButton(
                                onClick = {
                                    m.selectSubtitle(null)
                                    options = ""
                                }
                            ) {
                                Text("关闭字幕")
                            }
                            m.tracks.forEach { sub ->
                                TextButton(
                                    onClick = {
                                        m.selectSubtitle(sub.getInt("index"))
                                        options = ""
                                    }
                                ) {
                                    Text(sub.getString("label"))
                                }
                            }
                        }
                    }
                }
        }
    }

    private fun time(ms: Long): String {
        val seconds = ms.coerceAtLeast(0) / 1000
        return if (seconds >= 3600)
            "${seconds/3600}:${(seconds/60%60).toString().padStart(2,'0')}:${(seconds%60).toString().padStart(2,'0')}"
        else "${seconds/60}:${(seconds%60).toString().padStart(2,'0')}"
    }
}
