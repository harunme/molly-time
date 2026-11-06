@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.molly.parent

import android.util.Base64
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.*
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.*
import org.json.JSONObject

@Composable
internal fun DetailFrame(
    title: String,
    back: () -> Unit,
    actions: @Composable RowScope.() -> Unit = {},
    busy: Boolean = false,
    refreshing: Boolean = false,
    onRefresh: (() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    BackHandler(busy) {}
    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        topBar = {
            TopAppBar(
                title = { Text(title, style = MaterialTheme.typography.titleMedium) },
                navigationIcon = {
                    IconButton(onClick = { if (!busy) back() }) {
                        Icon(Icons.AutoMirrored.Outlined.ArrowBack, "返回")
                    }
                },
                actions = actions,
                colors =
                    TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.background
                    ),
            )
        },
    ) { padding ->
        val body: @Composable () -> Unit = {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopCenter) {
                Column(
                    Modifier.widthIn(max = 600.dp)
                        .fillMaxWidth()
                        .verticalScroll(rememberScrollState())
                        .imePadding()
                        .padding(24.dp),
                    verticalArrangement = Arrangement.spacedBy(24.dp),
                    content = content,
                )
            }
        }
        if (onRefresh != null)
            PullToRefreshBox(refreshing, onRefresh, Modifier.fillMaxSize().padding(padding)) {
                body()
            }
        else Box(Modifier.fillMaxSize().padding(padding)) { body() }
    }
}

@Composable
internal fun DetailHost(
    model: ParentViewModel,
    kind: String,
    item: JSONObject?,
    back: () -> Unit,
    navigate: (String, JSONObject?) -> Unit,
) {
    when (kind) {
        "profile" -> ProfileScreen(model, back, navigate)
        "accounts" -> AccountsScreen(model, back, navigate)
        "addAccount" ->
            DetailFrame("添加账号", back) {
                LoginScreen(
                    model,
                    { navigate("connection", null) },
                    { navigate("registration", null) },
                    { navigate("accounts", null) },
                    item,
                )
            }
        "registration" -> RegistrationScreen(model, back)
        "password" -> PasswordScreen(model, back)
        "pin" -> PINScreen(model, back)
        "playback" -> PlaybackPreferencesScreen(model, back)
        "reminder" -> ReminderScreen(model, back)
        "upload" ->
            DetailFrame("添加内容", back) {
                UploadPanel(
                    model,
                    model.uploads,
                    model.folder,
                    viewVideo = { navigate("video", it) },
                )
            }
        "trash" -> TrashScreen(model, back)
        "video" -> VideoDetailsScreen(model, item!!, back)
        "actions" ->
            DetailFrame(item!!.getString("name"), back) { ResourceActions(model, item, back) }
        "viewingInfo" ->
            DetailFrame("观看说明", back) {
                SurfaceBlock {
                    Column(
                        Modifier.padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(24.dp),
                    ) {
                        Text("手机上，放心挑选", style = MaterialTheme.typography.titleMedium)
                        Hint("家长在手机上播放，不占孩子的观看额度。观看进度也会单独保存。")
                        HorizontalDivider()
                        Text("电视上，按约定观看", style = MaterialTheme.typography.titleMedium)
                        Hint("孩子的观看时间和集数，在「电视」里的「调整观看安排」设置。允许孩子观看的视频，才会显示在电视上。")
                    }
                }
            }
        "disclaimer" ->
            DetailFrame("免责条款", back) {
                Hint("使用 MollyTime 前，请了解以下说明。")
                SurfaceBlock {
                    Column(
                        Modifier.padding(24.dp),
                        verticalArrangement = Arrangement.spacedBy(24.dp),
                    ) {
                        listOf(
                                "内容与版权" to
                                    "请仅上传、存储和使用你依法有权使用的视频、图片、字幕等内容，并遵守授权范围。仅供自己或家庭观看，不代表自动获得相关权利；请勿未经授权传播他人作品。",
                                "家长的选择与陪伴" to
                                    "请由家长判断内容是否适合孩子，并合理安排观看时间。观看额度、休息提醒等功能用于辅助管理，不能替代家长的陪伴和监护。",
                                "播放与存储" to
                                    "网络、设备、视频格式及存储服务的状态可能影响上传和播放，服务无法保证始终不中断或完全无误。请为重要内容保留独立备份。",
                                "责任范围" to
                                    "用户与服务提供方应依据适用法律及各自过错承担相应责任。本说明不免除或限制法律规定不得免除或限制的责任，也不影响用户依法享有的权利。",
                            )
                            .forEachIndexed { i, (title, text) ->
                                if (i > 0) HorizontalDivider()
                                Text(title, style = MaterialTheme.typography.titleMedium)
                                Hint(text)
                            }
                    }
                }
            }
        "connection" -> DetailFrame("连接设置", back) { ConnectionSheet(model, back) }
    }
}

@Composable
internal fun Avatar(data: String?, modifier: Modifier) {
    val bitmap =
        remember(data) {
            runCatching {
                    if (data.isNullOrBlank() || data == "null") null
                    else
                        Base64.decode(data, Base64.DEFAULT).let {
                            android.graphics.BitmapFactory.decodeByteArray(it, 0, it.size)
                        }
                }
                .getOrNull()
        }
    Box(
        modifier
            .clip(RoundedCornerShape(18.dp))
            .background(androidx.compose.ui.graphics.Color(0xFF211F1B)),
        contentAlignment = Alignment.Center,
    ) {
        if (bitmap != null)
            Image(
                bitmap.asImageBitmap(),
                null,
                Modifier.fillMaxSize(),
                contentScale = androidx.compose.ui.layout.ContentScale.Crop,
            )
        else BrandMark(Modifier.fillMaxSize().padding(10.dp))
    }
}

@Composable
private fun ProfileScreen(
    model: ParentViewModel,
    back: () -> Unit,
    navigate: (String, JSONObject?) -> Unit,
) {
    val user = model.session!!.getJSONObject("user")
    val originalName =
        user.optString("displayName").takeUnless { it.isBlank() || it == "null" }
            ?: user.getString("name")
    var name by rememberSaveable { mutableStateOf(originalName) }
    var avatar by rememberSaveable {
        mutableStateOf(
            user.optString("avatarJPEGBase64").takeUnless { it.isBlank() || it == "null" }
        )
    }
    var busy by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    var logout by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val photo =
        rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
            if (uri != null)
                scope.launch {
                    busy = true
                    try {
                        avatar =
                            withContext(Dispatchers.IO) {
                                Base64.encodeToString(
                                    MediaPreparation.jpeg(context, uri, 256, 80, true),
                                    Base64.NO_WRAP,
                                )
                            }
                    } catch (e: Exception) {
                        if (e is CancellationException) throw e
                        failure = e.message
                    } finally {
                        busy = false
                    }
                }
        }
    val valid = name.trim().isNotEmpty() && name.trim().codePointCount(0, name.trim().length) <= 64
    DetailFrame(
        "个人信息",
        { if (!busy) back() },
        busy = busy,
        actions = {
            TextButton(
                enabled =
                    !busy &&
                        valid &&
                        (name.trim() != originalName ||
                            avatar !=
                                user.optString("avatarJPEGBase64").takeUnless {
                                    it.isBlank() || it == "null"
                                }),
                onClick = {
                    scope.launch {
                        busy = true
                        try {
                            model.updateProfile(name.trim(), avatar)
                            back()
                        } catch (e: Exception) {
                            if (e is CancellationException) throw e
                            failure =
                                if (e is ApiFailure && e.status == 404) "当前服务尚未支持个人资料编辑，请更新服务端后再保存。"
                                else e.message
                        } finally {
                            busy = false
                        }
                    }
                },
            ) {
                Text(
                    "保存",
                    color =
                        if (
                            busy ||
                                !valid ||
                                (name.trim() == originalName &&
                                    avatar ==
                                        user.optString("avatarJPEGBase64").takeUnless {
                                            it.isBlank() || it == "null"
                                        })
                        )
                            MaterialTheme.colorScheme.onSurface.copy(alpha = .38f)
                        else MaterialTheme.colorScheme.onSurface,
                )
            }
        },
    ) {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Box(Modifier.clickable(enabled = !busy) { photo.launch("image/*") }) {
                Avatar(avatar, Modifier.size(64.dp))
                Icon(
                    Icons.Outlined.PhotoCamera,
                    "更换头像",
                    Modifier.align(Alignment.BottomEnd)
                        .size(24.dp)
                        .background(Jasmine, RoundedCornerShape(12.dp))
                        .padding(4.dp),
                )
            }
            Column(Modifier.weight(1f)) {
                FieldLabel("名称")
                MollyTextField(name, { name = it }, "你希望显示的名字", enabled = !busy)
            }
        }
        if (avatar != null) QuietAction("恢复默认头像", !busy) { avatar = null }
        failure?.let { ErrorMessage(it) }
        SurfaceBlock {
            SettingsRow(
                Icons.Outlined.AccountCircle,
                "账号 ID",
                user.optString("accountId"),
                action = { clipboard.setText(AnnotatedString(user.optString("accountId"))) },
            )
            SettingsRow(Icons.Outlined.Lock, "修改登录密码", action = { navigate("password", null) })
            SettingsRow(Icons.Outlined.SwapHoriz, "切换账号", action = { navigate("accounts", null) })
        }
        QuietAction(if (busy) "正在处理…" else "退出登录", !busy) { logout = true }
    }
    if (logout)
        AlertDialog(
            onDismissRequest = { logout = false },
            title = { Text("退出登录？") },
            text = { Text("已上传的视频和电视绑定会保留，可随时重新登录。") },
            confirmButton = {
                QuietAction("退出登录") {
                    logout = false
                    model.logout()
                }
            },
            dismissButton = { QuietAction("取消") { logout = false } },
        )
}

@Composable
private fun AccountsScreen(
    model: ParentViewModel,
    back: () -> Unit,
    navigate: (String, JSONObject?) -> Unit,
) {
    var forgetting by remember { mutableStateOf<JSONObject?>(null) }
    var pending by remember { mutableStateOf<JSONObject?>(null) }
    DetailFrame("切换账号", back) {
        model.accounts.forEach { record ->
            val user = record.getJSONObject("session").getJSONObject("user")
            val active =
                record.getString("origin") == model.api?.endpoint?.origin.toString() &&
                    user.getString("id") == model.session?.optJSONObject("user")?.optString("id")
            SurfaceBlock {
                SettingsRow(
                    Icons.Outlined.AccountCircle,
                    user.optString("displayName").takeUnless { it.isBlank() || it == "null" }
                        ?: user.getString("name"),
                    "${user.optString("accountId")} · ${if(active)"当前使用" else if(record.optBoolean("needsLogin"))"需重新登录"else record.getJSONObject("session").getJSONObject("family").getString("name")}",
                    action =
                        if (active) null
                        else
                            ({
                                if (model.hasPendingUpload) pending = record
                                else
                                    model.switchAccount(record, back) { navigate("addAccount", it) }
                            }),
                )
                if (!active) QuietAction("移除此账号") { forgetting = record }
            }
        }
        PrimaryAction("添加账号", Icons.Outlined.Add) { navigate("addAccount", null) }
    }
    forgetting?.let { record ->
        AlertDialog(
            onDismissRequest = { forgetting = null },
            title = { Text("移除此账号？") },
            text = { Text("只移除本机保存的登录信息，不删除账号或家庭内容。") },
            confirmButton = {
                QuietAction("移除") {
                    model.forgetAccount(record)
                    forgetting = null
                }
            },
            dismissButton = { QuietAction("取消") { forgetting = null } },
        )
    }
    pending?.let { record ->
        AlertDialog(
            onDismissRequest = { pending = null },
            title = { Text("切换账号？") },
            text = { Text("未完成的上传会暂停，切回后可继续。已上传的视频和电视绑定会保留。") },
            confirmButton = {
                QuietAction("切换") {
                    pending = null
                    model.switchAccount(record, back) { navigate("addAccount", it) }
                }
            },
            dismissButton = { QuietAction("取消") { pending = null } },
        )
    }
}

internal fun passwordError(value: String, confirmation: String): String? =
    when {
        value.codePointCount(0, value.length) < 8 -> "新密码至少需要 8 个字符。"
        value.toByteArray().size > 72 -> "新密码过长，请控制在 72 字节以内。"
        value != confirmation -> "两次输入的新密码不一致。"
        else -> null
    }

@Composable
private fun PasswordScreen(model: ParentViewModel, back: () -> Unit) {
    var current by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    DetailFrame("修改登录密码", back, busy = busy) {
        Hint("这是登录账号使用的密码，与电视上的四位家长密码不同。")
        listOf("当前密码" to current, "新密码" to password, "再次输入新密码" to confirm).forEachIndexed {
            i,
            (label, value) ->
            FieldLabel(label)
            MollyTextField(
                value,
                {
                    when (i) {
                        0 -> current = it
                        1 -> password = it
                        else -> confirm = it
                    }
                },
                label,
                enabled = !busy,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            )
        }
        Hint("至少 8 个字符，最多 72 字节。支持粘贴或使用密码管理器。")
        error?.let { ErrorMessage(it) }
        PrimaryAction(
            if (busy) "正在保存…" else "保存新密码",
            enabled = !busy && current.isNotEmpty() && passwordError(password, confirm) == null,
        ) {
            scope.launch {
                busy = true
                try {
                    withContext(Dispatchers.IO) {
                        model.api!!.request(
                            "/api/manage/password",
                            "POST",
                            json("currentPassword" to current, "newPassword" to password),
                        )
                    }
                    current = ""
                    password = ""
                    confirm = ""
                    saved = true
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    error = e.message
                } finally {
                    busy = false
                }
            }
        }
    }
    if (saved)
        AlertDialog(
            onDismissRequest = {},
            title = { Text("登录密码已修改") },
            confirmButton = { QuietAction("完成", onClick = back) },
        )
}

@Composable
private fun PINScreen(model: ParentViewModel, back: () -> Unit) {
    var pin by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    DetailFrame("重设家长密码", back, busy = busy) {
        Hint("所有电视共用的四位数字密码，请不要告诉孩子。")
        FieldLabel("新家长密码")
        MollyTextField(
            pin,
            { pin = it.filter { c -> c in '0'..'9' }.take(4) },
            "四位数字",
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
        )
        FieldLabel("再次输入")
        MollyTextField(
            confirm,
            { confirm = it.filter { c -> c in '0'..'9' }.take(4) },
            "再次输入四位数字",
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
        )
        error?.let { ErrorMessage(it) }
        PrimaryAction(
            if (busy) "正在保存…" else "保存家长密码",
            enabled = !busy && model.canManage && pin.matches(Regex("[0-9]{4}")) && pin == confirm,
        ) {
            scope.launch {
                busy = true
                try {
                    withContext(Dispatchers.IO) {
                        model.api!!.request(
                            "/api/manage/watch-control/pin",
                            "PUT",
                            json("pin" to pin),
                        )
                    }
                    back()
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    error = e.message
                } finally {
                    busy = false
                }
            }
        }
    }
}

@Composable
private fun PlaybackPreferencesScreen(model: ParentViewModel, back: () -> Unit) {
    var selected by remember { mutableStateOf<String?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var revision by remember { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    val api = model.api!!
    LaunchedEffect(api, revision) {
        try {
            selected =
                withContext(Dispatchers.IO) {
                    api.request("/api/manage/settings").getString("defaultSubtitle")
                }
            failure = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            failure = e.message
        }
    }
    DetailFrame("播放偏好", back, busy = busy) {
        Text("默认字幕", style = MaterialTheme.typography.titleLarge)
        Hint("选一种习惯的字幕，手机和电视一起记住。")
        if (selected == null && failure == null) StorageSkeleton()
        if (selected != null)
            SurfaceBlock {
                listOf("zh" to "中文", "en" to "英文", "zh-en" to "中英文", "off" to "关闭字幕").forEach {
                    (key, label) ->
                    Row(
                        Modifier.fillMaxWidth()
                            .clickable(enabled = !busy && model.canManage) { selected = key }
                            .padding(20.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(label, Modifier.weight(1f))
                        RadioButton(selected == key, onClick = null)
                    }
                }
            }
        Hint("下次播放生效。没有匹配的字幕时不显示；中英文需要视频提供双语字幕。")
        failure?.let { RetryMessage(it) { revision++ } }
        if (model.canManage)
            PrimaryAction("保存偏好", enabled = !busy && selected != null) {
                scope.launch {
                    busy = true
                    try {
                        withContext(Dispatchers.IO) {
                            api.request(
                                "/api/manage/settings",
                                "PUT",
                                json("defaultSubtitle" to selected),
                            )
                        }
                        back()
                    } catch (e: Exception) {
                        if (e is CancellationException) throw e
                        failure = e.message
                    } finally {
                        busy = false
                    }
                }
            }
    }
}
