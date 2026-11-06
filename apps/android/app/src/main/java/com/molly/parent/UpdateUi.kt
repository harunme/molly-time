package com.molly.parent

import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner

@Composable
internal fun UpdateUi(updater: UpdateViewModel, source: String, ready: Boolean) {
    val lifecycle by LocalLifecycleOwner.current.lifecycle.currentStateFlow.collectAsState()
    val activity = LocalActivity.current
    LaunchedEffect(source, ready, lifecycle) {
        if (ready && lifecycle.isAtLeast(Lifecycle.State.RESUMED)) updater.check(source)
    }
    if (!updater.visible || !ready || !lifecycle.isAtLeast(Lifecycle.State.RESUMED)) return
    AlertDialog(
        onDismissRequest = { if (updater.stage != "installing") updater.dismiss() },
        title = { Text(updater.release?.let { "更新到 ${it.versionName}" } ?: "版本更新") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text("当前版本 ${BuildConfig.VERSION_NAME}")
                updater.release?.notes?.takeIf { it.isNotBlank() }?.let { Text(it) }
                Text(updater.message)
                if (updater.stage == "downloading") {
                    LinearProgressIndicator(
                        progress = {
                            updater.received.toFloat() /
                                (updater.release?.size ?: 1).coerceAtLeast(1)
                        },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Text(
                        "${updater.received/1024/1024} / ${(updater.release?.size?:0)/1024/1024} MiB"
                    )
                }
            }
        },
        confirmButton = {
            when {
                updater.stage in listOf("ready", "awaiting") && updater.release != null ->
                    QuietAction("安装更新") { activity?.let { updater.install(it) } }
                updater.stage == "error" -> QuietAction("重新检查") { updater.check(source, true) }
                updater.release != null && !updater.busy ->
                    QuietAction("下载更新") { updater.download() }
                !updater.busy -> QuietAction("知道了") { updater.dismiss() }
            }
        },
        dismissButton = {
            if (updater.stage != "installing")
                QuietAction(if (updater.stage == "downloading") "取消下载" else "稍后") {
                    updater.dismiss()
                }
        },
    )
}
