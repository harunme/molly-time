@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.molly.parent

import android.Manifest
import android.content.Intent
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.*
import org.json.JSONObject

@Composable
internal fun UploadPanel(
    model: ParentViewModel,
    controller: UploadController,
    folder: JSONObject?,
    reminderKind: String? = null,
    viewVideo: (JSONObject) -> Unit = {},
) {
    val draft by controller.state.collectAsState()
    val other by
        (if (reminderKind == null) model.reminderUploads else model.uploads).state.collectAsState()
    val busy = draft?.optBoolean("busy") == true
    val completed = draft?.optBoolean("completed") == true
    val selected = draft?.has("file") == true
    val locked = busy || draft?.optJSONObject("resource") != null
    var selectingFolder by remember { mutableStateOf(false) }
    var cancelling by remember { mutableStateOf(false) }
    var localError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val photo =
        rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
            if (uri != null) controller.prepare(uri, true, folder, reminderKind)
        }
    val file =
        rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
            if (uri != null) controller.prepare(uri, false, folder, reminderKind)
        }
    val permission =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
            controller.begin()
        }
    if (!selected && !busy || completed && reminderKind != null)
        SurfaceBlock {
            SettingsRow(
                Icons.Outlined.PhotoLibrary,
                "从相册选择",
                "选择手机中的视频",
                action =
                    if (!busy && model.canManage && other?.optBoolean("busy") != true)
                        ({
                            photo.launch(
                                PickVisualMediaRequest(
                                    ActivityResultContracts.PickVisualMedia.VideoOnly
                                )
                            )
                        })
                    else null,
            )
            HorizontalDivider(Modifier.padding(horizontal = 20.dp))
            SettingsRow(
                Icons.Outlined.FolderOpen,
                "从文件选择",
                "支持 MP4 视频",
                action =
                    if (!busy && model.canManage && other?.optBoolean("busy") != true)
                        ({ file.launch(arrayOf("video/mp4")) })
                    else null,
            )
        }
    if (selected)
        SurfaceBlock {
            Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                if (reminderKind == null) {
                    FieldLabel("视频名称")
                    MollyTextField(
                        draft!!.optString("name"),
                        { controller.configure(name = it) },
                        "给视频起个名字",
                        enabled = !locked,
                    )
                    if (!locked) QuietAction("重新选择") { controller.clear() }
                    HorizontalDivider()
                    SettingsRow(
                        Icons.Outlined.FolderOpen,
                        "放入合集",
                        draft!!.optJSONObject("folder")?.optString("name")
                            ?: folder?.optString("name")
                            ?: "手机添加",
                        action = if (!locked) ({ selectingFolder = true }) else null,
                    )
                } else Text(draft!!.optString("name"), style = MaterialTheme.typography.titleSmall)
                if (!completed && reminderKind == null) {
                    Row {
                        Text(
                            "上传后允许孩子观看",
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.titleSmall,
                        )
                        Switch(
                            draft!!.optBoolean("allowChildren"),
                            { controller.configure(allow = it) },
                            enabled = !locked,
                        )
                    }
                    Hint(
                        if (draft!!.optBoolean("allowChildren")) "处理完成后开放给孩子；所在合集也需允许孩子观看。"
                        else "先仅供家长预览，之后可在视频详情中开放。"
                    )
                }
                Text(draft!!.optString("phase"), style = MaterialTheme.typography.bodyMedium)
                if (draft!!.has("upload"))
                    LinearProgressIndicator(
                        progress = {
                            draft!!.optDouble("progress", 0.0).toFloat().coerceIn(0f, 1f)
                        },
                        modifier = Modifier.fillMaxWidth(),
                        color = MaterialTheme.colorScheme.secondary,
                    )
            }
        }
    if (busy && !selected) Hint("正在准备视频，请稍候…")
    draft?.optString("error")?.takeIf { it.isNotBlank() && it != "null" }?.let { ErrorMessage(it) }
    localError?.let { ErrorMessage(it) }
    when {
        completed -> {
            if (draft!!.optBoolean("allowChildren") && !draft!!.optBoolean("published"))
                PrimaryAction("重试开放给孩子", enabled = !busy) {
                    scope.launch { controller.checkCompletion() }
                }
            if (reminderKind == null) {
                draft!!.optJSONObject("resource")?.let { item ->
                    PrimaryAction("查看视频") { viewVideo(item) }
                }
                QuietAction("再添加一个") { controller.clear() }
            } else Text("休息提醒视频已就绪")
        }
        busy -> if (selected) PrimaryAction("暂停上传") { controller.pause() }
        draft?.optJSONObject("upload")?.optString("status") == "failed" -> {
            PrimaryAction("重试处理") { controller.retryProcessing() }
            QuietAction("取消这次上传") { cancelling = true }
        }
        controller.pending ->
            PrimaryAction("检查处理进度") { scope.launch { controller.checkCompletion() } }
        selected -> {
            PrimaryAction(
                if (draft!!.has("upload")) "继续上传"
                else if (reminderKind == null) "开始上传" else "上传提醒视频",
                enabled =
                    model.canManage &&
                        other?.optBoolean("busy") != true &&
                        draft!!.optString("name").isNotBlank(),
            ) {
                if (Build.VERSION.SDK_INT >= 33)
                    permission.launch(Manifest.permission.POST_NOTIFICATIONS)
                else controller.begin()
            }
            if (draft!!.has("upload")) QuietAction("取消这次上传") { cancelling = true }
        }
    }
    if (other?.optBoolean("busy") == true)
        Hint(if (reminderKind == null) "休息提醒视频正在上传，请完成后再向资料库添加内容。" else "资料库视频正在上传，完成后可上传提醒视频。")
    if (!completed && reminderKind == null) Hint("上传开始后可以锁屏或使用其他 App，进度会自动更新。")
    if (selectingFolder)
        FolderPicker(model.api!!, emptySet(), false, { selectingFolder = false }) { choice ->
            if (choice != null) controller.configure(folder = choice)
            selectingFolder = false
        }
    if (cancelling)
        AlertDialog(
            onDismissRequest = { cancelling = false },
            title = { Text("取消这次上传？") },
            text = { Text("已创建的待完善视频仍会保留在资料库。") },
            confirmButton = {
                QuietAction("取消上传") {
                    cancelling = false
                    scope.launch {
                        try {
                            controller.cancel()
                        } catch (e: CancellationException) {
                            throw e
                        } catch (e: Exception) {
                            localError = e.message
                        }
                    }
                }
            },
            dismissButton = { QuietAction("继续保留") { cancelling = false } },
        )
}

@Composable
internal fun ReminderScreen(model: ParentViewModel, back: () -> Unit) {
    val controller = model.reminderUploads
    val draft by controller.state.collectAsState()
    var kind by rememberSaveable {
        mutableStateOf(
            draft?.optString("reminderKind")?.takeIf { it in listOf("warning", "farewell") }
                ?: "farewell"
        )
    }
    var settings by remember { mutableStateOf<JSONObject?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var revision by remember { mutableIntStateOf(0) }
    val api = model.api!!
    val context = LocalContext.current
    LaunchedEffect(api, revision, draft?.optBoolean("completed")) {
        try {
            settings = withContext(Dispatchers.IO) { api.request("/api/manage/reminders") }
            failure = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failure = e.message
        }
    }
    DetailFrame("提醒视频", back) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            listOf("warning" to "最后一集", "farewell" to "该休息了").forEachIndexed { index, (value, label)
                ->
                SegmentedButton(
                    kind == value,
                    onClick = {
                        if (draft?.optBoolean("completed") == true) controller.clear()
                        kind = value
                    },
                    shape = SegmentedButtonDefaults.itemShape(index, 2),
                    enabled =
                        draft?.optBoolean("busy") != true &&
                            (draft == null || draft?.optBoolean("completed") == true),
                ) {
                    Text(label)
                }
            }
        }
        Text("好好说一声，该休息啦。", style = MaterialTheme.typography.headlineMedium)
        Hint(if (kind == "warning") "告诉孩子这是最后一集，让休息有个温柔的预告。" else "观看结束时播放，让孩子安心放下遥控器。")
        val clip = settings?.optJSONObject(kind)
        if (settings == null && failure == null) StorageSkeleton()
        clip?.let {
            Text(
                if (it.optString("source") == "builtin") "正在使用默认提醒"
                else if (it.optBoolean("ready")) "正在使用你的提醒视频" else "还没有休息提醒视频",
                style = MaterialTheme.typography.titleSmall,
            )
            if (it.optBoolean("ready"))
                PrimaryAction("播放当前提醒", Icons.Outlined.PlayArrow) {
                    context.startActivity(
                        Intent(context, PlayerActivity::class.java)
                            .putExtra("id", "rest-reminder")
                            .putExtra("path", "/api/reminders/$kind/playback")
                            .putExtra("name", "休息提醒")
                    )
                }
        }
        key(kind) { UploadPanel(model, controller, null, kind) }
        failure?.let { RetryMessage(it) { revision++ } }
        Hint("默认提醒已准备好，可以直接使用「这集看完休息」。也可以录制自己的视频替换，所有电视共用，提醒不计入观看时长。")
    }
}
