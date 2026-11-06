package com.molly.parent

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay

/** Same 180ms grace, slow opacity cycle and stable content geometry as iOS QuietLoading. */
@Composable
private fun QuietPlaceholder(
    label: String,
    modifier: Modifier = Modifier,
    animating: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    val context = LocalContext.current
    val reduced =
        android.provider.Settings.Global.getFloat(
            context.contentResolver,
            android.provider.Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        ) == 0f
    var visible by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) {
        delay(180)
        visible = true
    }
    val entrance by
        animateFloatAsState(
            if (visible) 1f else 0f,
            tween(if (reduced) 0 else 200),
            label = "placeholder-entrance",
        )
    val transition = rememberInfiniteTransition(label = "quiet-loading")
    val opacity by
        transition.animateFloat(
            .72f,
            1f,
            infiniteRepeatable(tween(1400, easing = FastOutSlowInEasing), RepeatMode.Reverse),
            label = "placeholder-opacity",
        )
    Column(
        modifier
            .alpha(entrance * (if (reduced || !animating) 1f else opacity))
            .clearAndSetSemantics { contentDescription = label },
        content = content,
    )
}

@Composable
private fun LoadingShape(modifier: Modifier) {
    Spacer(
        modifier
            .clip(RoundedCornerShape(10.dp))
            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = .055f))
    )
}

@Composable
fun LibrarySkeleton(modifier: Modifier = Modifier) {
    QuietPlaceholder("正在载入资料库", modifier.fillMaxWidth()) {
        LoadingShape(Modifier.width(72.dp).height(14.dp))
        Spacer(Modifier.height(16.dp))
        LazyVerticalGrid(
            columns = GridCells.Fixed(2),
            horizontalArrangement = Arrangement.spacedBy(20.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            items(6) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    LoadingShape(Modifier.fillMaxWidth().aspectRatio(16f / 9))
                    LoadingShape(Modifier.width(64.dp).height(12.dp))
                }
            }
        }
    }
}

@Composable
fun DevicesSkeleton() {
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surface) {
        QuietPlaceholder("正在载入电视与观看记录", Modifier.fillMaxWidth().padding(24.dp)) {
            LoadingShape(Modifier.width(100.dp).height(16.dp))
            Spacer(Modifier.height(24.dp))
            LoadingShape(Modifier.width(88.dp).height(36.dp))
            Spacer(Modifier.height(24.dp))
            LoadingShape(Modifier.fillMaxWidth().height(72.dp))
            Spacer(Modifier.height(24.dp))
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            Spacer(Modifier.height(24.dp))
            LoadingShape(Modifier.width(160.dp).height(48.dp))
        }
    }
}

@Composable
fun StorageSkeleton(loading: Boolean = true) {
    QuietPlaceholder(
        if (loading) "正在载入存储空间" else "存储空间暂未获取",
        Modifier.fillMaxWidth(),
        animating = loading,
    ) {
        LoadingShape(Modifier.width(138.dp).height(36.dp))
        Spacer(Modifier.height(8.dp))
        LoadingShape(Modifier.width(186.dp).height(16.dp))
    }
}

@Composable
fun PlaybackSkeleton() {
    SurfaceBlock {
        QuietPlaceholder("正在载入播放偏好", Modifier.fillMaxWidth()) {
            repeat(4) {
                Row(Modifier.fillMaxWidth().height(64.dp).padding(horizontal = 20.dp),
                    verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    LoadingShape(Modifier.width(80.dp).height(18.dp))
                    Spacer(Modifier.weight(1f))
                    LoadingShape(Modifier.size(24.dp))
                }
            }
        }
    }
}

@Composable
fun TrashSkeleton() {
    SurfaceBlock {
        QuietPlaceholder("正在载入最近删除", Modifier.fillMaxWidth().padding(20.dp)) {
            LoadingShape(Modifier.width(140.dp).height(20.dp))
            Spacer(Modifier.height(16.dp))
            LoadingShape(Modifier.width(220.dp).height(14.dp))
            Spacer(Modifier.height(16.dp))
            LoadingShape(Modifier.width(80.dp).height(32.dp))
        }
    }
}
