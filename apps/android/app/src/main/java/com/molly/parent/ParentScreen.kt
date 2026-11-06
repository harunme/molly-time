@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package com.molly.parent

import android.graphics.Bitmap
import android.text.format.Formatter
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.gestures.scrollBy
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.autofill.ContentType
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.zIndex
import kotlinx.coroutines.launch
import org.json.JSONObject

internal data class ParentSheet(
    val kind: String,
    val item: JSONObject? = null,
    val code: String = "",
)

private data class Confirmation(val title: String, val message: String, val action: () -> Unit)

@Composable
fun ParentScreen(model: ParentViewModel, updater: UpdateViewModel? = null) {
    var sheet by
        rememberSaveable(
            stateSaver =
                Saver<ParentSheet?, String>(
                    save = { value ->
                        value?.let {
                            json("kind" to it.kind, "item" to it.item, "code" to it.code).toString()
                        }
                    },
                    restore = { value ->
                        JSONObject(value).let {
                            ParentSheet(
                                it.getString("kind"),
                                it.optJSONObject("item"),
                                it.optString("code"),
                            )
                        }
                    },
                )
        ) {
            mutableStateOf<ParentSheet?>(null)
        }
    var confirmation by remember { mutableStateOf<Confirmation?>(null) }
    val context = LocalContext.current
    var pages by rememberSaveable { mutableStateOf(listOf<String>()) }
    val navigate: (String, JSONObject?) -> Unit = { kind, item ->
        val safeItem =
            if (kind == "addAccount" && item != null)
                json(
                    "key" to item.optString("key"),
                    "origin" to item.optString("origin"),
                    "session" to
                        json(
                            "user" to
                                item.optJSONObject("session")?.optJSONObject("user")?.let {
                                    json(
                                        "email" to it.optString("email"),
                                        "accountId" to it.optString("accountId"),
                                    )
                                }
                        ),
                )
            else item
        pages = pages + json("kind" to kind, "item" to safeItem).toString()
    }
    val pop: () -> Unit = { pages = pages.dropLast(1) }
    val accountIdentity =
        model.session
            ?.optJSONObject("user")
            ?.optString("id")
            ?.let { "${model.api?.endpoint?.origin}|$it" }
            .orEmpty()
    var navigationAccount by rememberSaveable { mutableStateOf(accountIdentity) }
    LaunchedEffect(accountIdentity) {
        if (navigationAccount != accountIdentity) {
            pages = emptyList()
            sheet = null
            navigationAccount = accountIdentity
        }
    }
    BackHandler(enabled = pages.isNotEmpty() && sheet == null, onBack = pop)
    val scan =
        rememberLauncherForActivityResult(com.journeyapps.barcodescanner.ScanContract()) { result ->
            sheet = ParentSheet("pair")
            if (
                result.originalIntent?.getBooleanExtra(
                    com.google.zxing.client.android.Intents.Scan.MISSING_CAMERA_PERMISSION,
                    false,
                ) == true
            )
                model.notice = "暂时无法使用相机，可以手动输入电视上的四位绑定码。"
            result.contents?.let {
                model.previewPairing(it) { code, name ->
                    sheet = ParentSheet("pairConfirm", json("name" to name), code)
                }
            }
        }
    LaunchedEffect(model.session, model.tab) { if (model.session != null) model.ensureTab() }
    BackHandler(
        enabled =
            model.session != null &&
                (model.tab != 0 || model.folder != null) &&
                sheet == null &&
                pages.isEmpty()
    ) {
        model.back()
    }
    LaunchedEffect(model.watchConflictRevision) {
        val current = sheet
        if (model.watchConflictRevision > 0 && current?.kind == "watch") {
            model.devices
                .firstOrNull { it.getString("deviceId") == current.item?.optString("deviceId") }
                ?.let { sheet = current.copy(item = it) }
        }
    }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Box(Modifier.fillMaxSize()) {
            val launching = model.restoring || !model.startup.finished
            Box(
                if (launching) Modifier.fillMaxSize().clearAndSetSemantics {}
                else Modifier.fillMaxSize()
            ) {
                when {
                    model.restoring -> Unit
                    pages.isNotEmpty() &&
                        (model.session != null ||
                            JSONObject(pages.last()).getString("kind") in
                                listOf("registration", "accounts", "addAccount", "connection")) -> {
                        val page = JSONObject(pages.last())
                        DetailHost(
                            model,
                            page.getString("kind"),
                            page.optJSONObject("item"),
                            pop,
                            navigate,
                        )
                    }
                    model.session == null ->
                        LoginScreen(
                            model,
                            onConnection = { sheet = ParentSheet("connection") },
                            onRegistration = { navigate("registration", null) },
                            onAccounts = { navigate("accounts", null) },
                        )
                    else -> {
                        val wide = false
                        Scaffold(
                            containerColor = MaterialTheme.colorScheme.background,
                            bottomBar = {
                                if (!wide && model.folder == null)
                                    MollyNavigation(model.tab, false) { model.tab = it }
                            },
                        ) { padding ->
                            Row(Modifier.fillMaxSize().padding(padding)) {
                                if (wide && model.folder == null)
                                    MollyNavigation(model.tab, true) { model.tab = it }
                                Box(
                                    Modifier.weight(1f).fillMaxHeight(),
                                    contentAlignment = Alignment.TopCenter,
                                ) {
                                    val body = Modifier.widthIn(max = 700.dp).fillMaxSize()
                                    when (model.tab) {
                                        0 ->
                                            LibraryScreen(
                                                model,
                                                body,
                                                onAdd = {
                                                    if (model.hasActiveUpload)
                                                        navigate("upload", null)
                                                    else sheet = ParentSheet("add")
                                                },
                                                onResource = { item ->
                                                    if (item.optString("type") != "Episode")
                                                        model.openFolder(item)
                                                    else navigate("video", item)
                                                },
                                                onMore = { sheet = ParentSheet("resource", it) },
                                                onUpload = { navigate("upload", null) },
                                                newFolder = { sheet = ParentSheet("newFolder") },
                                                connect = { sheet = ParentSheet("pair") },
                                            )
                                        1 ->
                                            DevicesScreen(
                                                model,
                                                body,
                                                { sheet = ParentSheet("report", code = it) },
                                                { sheet = ParentSheet("pair") },
                                                { sheet = ParentSheet("device", it) },
                                                { sheet = ParentSheet("watch", it) },
                                                { navigate(it, null) },
                                            ) { device, action ->
                                                model.watchCommand(device, action)
                                            }
                                        else ->
                                            AccountScreen(
                                                model,
                                                body,
                                                update =
                                                    updater?.let {
                                                        {
                                                            it.show(
                                                                model.api
                                                                    ?.endpoint
                                                                    ?.origin
                                                                    ?.toString() ?: model.server
                                                            )
                                                        }
                                                    },
                                            ) {
                                                navigate(it, null)
                                            }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            val dark = isSystemInDarkTheme()
            SideEffect {
                (context as? android.app.Activity)?.let { activity ->
                    androidx.core.view
                        .WindowInsetsControllerCompat(activity.window, activity.window.decorView)
                        .apply {
                            isAppearanceLightStatusBars = !launching && !dark
                            isAppearanceLightNavigationBars = !launching && !dark
                        }
                }
            }
            AnimatedVisibility(
                visible = launching,
                enter = androidx.compose.animation.EnterTransition.None,
                exit = fadeOut(tween(250)),
            ) {
                AndroidView(
                    factory = { context ->
                        StartupLogoView(context) {}
                            .apply {
                                isClickable = true
                                startMotion { model.startup.elapsedMs() }
                            }
                    },
                    modifier = Modifier.fillMaxSize(),
                )
            }
        }
    }
    updater?.let {
        UpdateUi(
            it,
            model.api?.endpoint?.origin?.toString() ?: model.server,
            !model.restoring &&
                model.startup.finished &&
                model.operation == null &&
                sheet == null &&
                pages.isEmpty(),
        )
    }
    sheet?.let { current ->
        ModalBottomSheet(
            onDismissRequest = { sheet = null },
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            containerColor = MaterialTheme.colorScheme.background,
        ) {
            Box(Modifier.fillMaxWidth().imePadding(), contentAlignment = Alignment.TopCenter) {
                Column(
                    Modifier.widthIn(max = 560.dp)
                        .fillMaxWidth()
                        .then(
                            if (current.kind == "report")
                                Modifier.height(
                                    (LocalConfiguration.current.screenHeightDp * .82f).dp
                                )
                            else Modifier
                        )
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 24.dp)
                        .padding(bottom = 32.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                ) {
                    when (current.kind) {
                        "connection" -> ConnectionSheet(model) { sheet = null }
                        "serverInfo" -> {
                            SheetHeading("连接设置", "当前连接的 MollyTime 服务")
                            SurfaceBlock {
                                SettingsRow(Icons.Outlined.Public, "服务地址", model.server)
                            }
                        }
                        "add" -> {
                            SheetHeading("添加内容", model.folder?.getString("name") ?: "添加到家庭片库")
                            SurfaceBlock {
                                SettingsRow(
                                    Icons.Outlined.VideoFile,
                                    "上传视频",
                                    action = {
                                        sheet = null
                                        navigate("upload", null)
                                    },
                                )
                                HorizontalDivider(
                                    Modifier.padding(horizontal = 20.dp),
                                    color = MaterialTheme.colorScheme.outlineVariant,
                                )
                                SettingsRow(
                                    Icons.Outlined.CreateNewFolder,
                                    "新建合集",
                                    "把同一系列的内容放在一起",
                                    action = { sheet = ParentSheet("newFolder") },
                                )
                                if (model.folder != null)
                                    SettingsRow(
                                        Icons.Outlined.FolderOpen,
                                        "整理这个合集",
                                        action = { sheet = ParentSheet("resource", model.folder) },
                                    )
                            }
                        }
                        "newFolder" ->
                            NameSheet("新建合集", "合集名称", "", model.operation != null) { name ->
                                model.mutate(
                                    "/api/manage/resources",
                                    body =
                                        json(
                                            "name" to name,
                                            "type" to "Series",
                                            "parentId" to model.folder?.getString("id"),
                                        ),
                                ) {
                                    sheet = null
                                }
                            }
                        "renameResource",
                        "renameDevice" -> {
                            val item = current.item!!
                            NameSheet(
                                if (current.kind == "renameResource") "内容名称" else "电视名称",
                                "名称",
                                item.getString("name"),
                                model.operation != null,
                            ) { name ->
                                val path =
                                    if (current.kind == "renameResource")
                                        "/api/manage/resources/${ParentApi.segment(item.getString("id"))}"
                                    else
                                        "/api/manage/devices/${ParentApi.segment(item.getString("deviceId"))}"
                                model.mutate(path, "PATCH", json("name" to name)) { sheet = null }
                            }
                        }
                        "resource" -> ResourceActions(model, current.item!!) { sheet = null }
                        "pair" ->
                            PairCodeSheet(
                                model.operation != null,
                                {
                                    sheet = null
                                    scan.launch(
                                        com.journeyapps.barcodescanner
                                            .ScanOptions()
                                            .setDesiredBarcodeFormats(
                                                com.journeyapps.barcodescanner.ScanOptions.QR_CODE
                                            )
                                            .setPrompt("扫描电视上的二维码")
                                            .setBeepEnabled(false)
                                            .setOrientationLocked(false)
                                    )
                                },
                            ) { value ->
                                model.previewPairing(value) { code, name ->
                                    sheet = ParentSheet("pairConfirm", json("name" to name), code)
                                }
                            }
                        "pairConfirm" -> {
                            IconBadge(Icons.Outlined.Tv, Modifier.size(64.dp))
                            SheetHeading("找到这台电视", "确认名称后连接到你的家庭。")
                            NameSheet(
                                "",
                                "电视名称",
                                current.item!!.getString("name"),
                                model.operation != null,
                                "确认连接",
                            ) { name ->
                                model.mutate(
                                    "/api/manage/pairing/confirm",
                                    body = json("code" to current.code, "name" to name),
                                ) {
                                    sheet = null
                                    model.loadDevices()
                                }
                            }
                        }
                        "report" ->
                            model.watch?.let {
                                WatchReportContent(WatchStatistics(it), current.code, model.api!!)
                            }
                        "watch" ->
                            WatchSheet(current.item!!, model.pinSet, model.operation != null) {
                                enabled,
                                mode,
                                amount,
                                pin ->
                                model.saveWatch(current.item, enabled, mode, amount, pin) {
                                    sheet = null
                                }
                            }
                        "device" -> {
                            val device = current.item!!
                            val id = ParentApi.segment(device.getString("deviceId"))
                            SheetHeading(device.getString("name"), "电视管理")
                            SurfaceBlock {
                                if (device.has("version"))
                                    SettingsRow(
                                        Icons.Outlined.HourglassEmpty,
                                        "每天的观看安排",
                                        action = { sheet = ParentSheet("watch", device) },
                                    )
                                SettingsRow(
                                    Icons.Outlined.Edit,
                                    "重命名",
                                    action = { sheet = ParentSheet("renameDevice", device) },
                                )
                                if (
                                    device.optBoolean("enabled") &&
                                        device.optString("status") == "allowed"
                                )
                                    SettingsRow(
                                        Icons.Outlined.NightsStay,
                                        "结束今日观看",
                                        action = {
                                            confirmation =
                                                Confirmation(
                                                    "结束今日观看？",
                                                    "今天的剩余额度将结束，明天恢复。需要时仍可手动加看。",
                                                ) {
                                                    model.watchCommand(device, "stop")
                                                    sheet = null
                                                }
                                        },
                                    )
                                SettingsRow(
                                    Icons.Outlined.LinkOff,
                                    "解绑电视",
                                    destructive = true,
                                    action = {
                                        confirmation =
                                            Confirmation("解绑电视？", "解绑后这台电视需要重新配对，才能访问家庭片库。") {
                                                model.mutate("/api/manage/devices/$id/revoke") {
                                                    sheet = null
                                                }
                                            }
                                    },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
    confirmation?.let { pending ->
        AlertDialog(
            onDismissRequest = { confirmation = null },
            title = { Text(pending.title) },
            text = { Text(pending.message) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmation = null
                        pending.action()
                    },
                    colors =
                        ButtonDefaults.textButtonColors(
                            contentColor = MaterialTheme.colorScheme.secondary
                        ),
                ) {
                    Text("确认")
                }
            },
            dismissButton = { QuietAction("取消") { confirmation = null } },
        )
    }
    model.notice?.let { message ->
        AlertDialog(
            onDismissRequest = { model.notice = null },
            title = { Text("操作提示") },
            text = { Text(message) },
            confirmButton = { QuietAction("知道了") { model.notice = null } },
        )
    }
    model.operation?.let { label ->
        AlertDialog(
            onDismissRequest = {},
            confirmButton = {},
            text = {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(20.dp),
                ) {
                    CircularProgressIndicator(
                        Modifier.size(24.dp),
                        color = MaterialTheme.colorScheme.secondary,
                        strokeWidth = 2.dp,
                    )
                    Text(label)
                }
            },
        )
    }
}

@Composable
internal fun LoginScreen(
    model: ParentViewModel,
    onConnection: () -> Unit,
    onRegistration: () -> Unit = {},
    onAccounts: () -> Unit = {},
    saved: JSONObject? = null,
) {
    var username by
        rememberSaveable(saved?.optString("key")) {
            mutableStateOf(
                saved
                    ?.optJSONObject("session")
                    ?.optJSONObject("user")
                    ?.let {
                        it.optString("email").takeUnless { v -> v.isBlank() || v == "null" }
                            ?: it.optString("accountId")
                    }
                    .orEmpty()
            )
        }
    LaunchedEffect(saved?.optString("key")) {
        saved?.optString("origin")?.let { model.server = it }
    }
    var switching by remember { mutableStateOf(false) }
    var password by remember { mutableStateOf("") }
    var showPassword by rememberSaveable { mutableStateOf(false) }
    val focus = LocalFocusManager.current
    val passwordFocus = remember { androidx.compose.ui.focus.FocusRequester() }
    val submit = {
        focus.clearFocus()
        if (model.session != null && model.hasPendingUpload) switching = true
        else model.login(username, password)
    }
    Box(
        Modifier.fillMaxSize().safeDrawingPadding().imePadding(),
        contentAlignment = Alignment.TopCenter,
    ) {
        Column(
            Modifier.widthIn(max = 480.dp)
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 28.dp)
                .padding(top = 36.dp, bottom = 24.dp)
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                BrandMark(Modifier.size(42.dp))
                Text(
                    "MollyTime",
                    fontSize = 27.sp,
                    fontWeight = FontWeight.Bold,
                    letterSpacing = (-0.8).sp,
                )
            }
            Spacer(Modifier.height(44.dp))
            Text("欢迎回来", style = MaterialTheme.typography.headlineLarge)
            Spacer(Modifier.height(8.dp))
            Hint("挑选喜欢的视频，带到电视上看。")
            Spacer(Modifier.height(36.dp))
            FieldLabel("邮箱或账号")
            MollyTextField(
                username,
                { username = it },
                "输入邮箱或账号",
                enabled = !model.loginBusy,
                keyboardOptions =
                    KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next),
                keyboardActions = KeyboardActions(onNext = { passwordFocus.requestFocus() }),
                modifier = Modifier.semantics { contentType = ContentType.Username },
            )
            Spacer(Modifier.height(22.dp))
            FieldLabel("密码")
            MollyTextField(
                password,
                { password = it },
                "输入密码",
                enabled = !model.loginBusy,
                modifier =
                    Modifier.focusRequester(passwordFocus).semantics {
                        contentType = ContentType.Password
                    },
                visualTransformation =
                    if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                keyboardOptions =
                    KeyboardOptions(
                        keyboardType = KeyboardType.Password,
                        imeAction = ImeAction.Done,
                    ),
                keyboardActions = KeyboardActions(onDone = { submit() }),
                trailingIcon = {
                    IconButton(onClick = { showPassword = !showPassword }) {
                        Icon(
                            if (showPassword) Icons.Outlined.VisibilityOff
                            else Icons.Outlined.Visibility,
                            if (showPassword) "隐藏密码" else "显示密码",
                        )
                    }
                },
            )
            model.loginError?.let {
                Spacer(Modifier.height(16.dp))
                ErrorMessage(it)
            }
            Spacer(Modifier.height(28.dp))
            PrimaryAction(
                if (model.loginBusy) "正在登录…" else "登录",
                if (model.loginBusy) null else Icons.AutoMirrored.Outlined.ArrowForward,
                enabled = !model.loginBusy,
                onClick = submit,
            )
            QuietAction("使用邀请码开通", enabled = !model.loginBusy, onClick = onRegistration)
            if (model.accounts.isNotEmpty())
                QuietAction("切换账号", enabled = !model.loginBusy, onClick = onAccounts)
            Spacer(Modifier.height(20.dp))
            TextButton(
                onClick = {
                    focus.clearFocus()
                    onConnection()
                },
                enabled = !model.loginBusy,
                modifier = Modifier.align(Alignment.CenterHorizontally),
                colors =
                    ButtonDefaults.textButtonColors(
                        contentColor = MaterialTheme.colorScheme.onSurfaceVariant
                    ),
            ) {
                Icon(Icons.Outlined.Public, null, Modifier.size(16.dp))
                Spacer(Modifier.width(6.dp))
                Text(
                    if (model.server.trimEnd('/') == "https://mollytime.app") "MollyTime 官方服务"
                    else "自定义服务",
                    style = MaterialTheme.typography.bodySmall,
                )
                Icon(Icons.Outlined.ChevronRight, null, Modifier.size(16.dp))
            }
        }
    }
    if (switching)
        AlertDialog(
            onDismissRequest = { switching = false },
            title = { Text("登录并切换账号？") },
            text = { Text("新账号登录成功后，当前账号的上传会暂停，切回后可继续。已有资料库和电视绑定会保留。") },
            confirmButton = {
                QuietAction("继续") {
                    switching = false
                    model.login(username, password)
                }
            },
            dismissButton = { QuietAction("取消") { switching = false } },
        )
}

@Composable
internal fun MollyNavigation(selected: Int, rail: Boolean, onSelect: (Int) -> Unit) {
    val titles = listOf("资料库", "电视", "我的")
    val icons = listOf(Icons.Outlined.VideoLibrary, Icons.Outlined.Tv, Icons.Outlined.PersonOutline)
    if (rail)
        NavigationRail(
            containerColor = MaterialTheme.colorScheme.background,
            modifier = Modifier.fillMaxHeight().padding(top = 20.dp),
        ) {
            Spacer(Modifier.height(32.dp))
            titles.forEachIndexed { index, title ->
                NavigationRailItem(
                    selected = selected == index,
                    onClick = { onSelect(index) },
                    icon = { Icon(icons[index], null) },
                    label = { Text(title) },
                    colors =
                        NavigationRailItemDefaults.colors(
                            indicatorColor = Jasmine,
                            selectedIconColor = Color(0xFF302C20),
                            selectedTextColor = MaterialTheme.colorScheme.onSurface,
                        ),
                )
            }
        }
    else
        NavigationBar(
            containerColor = MaterialTheme.colorScheme.background,
            tonalElevation = 0.dp,
        ) {
            titles.forEachIndexed { index, title ->
                NavigationBarItem(
                    selected = selected == index,
                    onClick = { onSelect(index) },
                    icon = { Icon(icons[index], null) },
                    label = { Text(title) },
                    colors =
                        NavigationBarItemDefaults.colors(
                            indicatorColor = Jasmine,
                            selectedIconColor = Color(0xFF302C20),
                            selectedTextColor = MaterialTheme.colorScheme.onSurface,
                            unselectedIconColor = MaterialTheme.colorScheme.onSurfaceVariant,
                            unselectedTextColor = MaterialTheme.colorScheme.onSurfaceVariant,
                        ),
                )
            }
        }
}

@Composable
internal fun LibraryScreen(
    model: ParentViewModel,
    modifier: Modifier,
    onAdd: () -> Unit,
    onResource: (JSONObject) -> Unit,
    onMore: (JSONObject) -> Unit,
    onUpload: () -> Unit,
    newFolder: () -> Unit = {},
    connect: () -> Unit = {},
) {
    var contextItem by remember { mutableStateOf<JSONObject?>(null) }
    val scope = rememberCoroutineScope()
    val grid = rememberLazyGridState()
    var preview by remember { mutableStateOf<List<String>>(emptyList()) }
    var dragged by remember { mutableStateOf<String?>(null) }
    var dragPoint by remember { mutableStateOf(Offset.Zero) }
    var savingOrder by remember { mutableStateOf(false) }
    fun move(source: Int, target: Int) {
        if (savingOrder || source == target) return
        scope.launch {
            savingOrder = true
            try {
                model.reorder(source, target)
            } finally {
                savingOrder = false
            }
        }
    }
    BackHandler(model.reordering) { if (!savingOrder) model.updateReordering(false) }
    DisposableEffect(model.folder?.optString("id")) { onDispose { model.updateReordering(false) } }
    val shown =
        if (preview.isEmpty()) model.resources
        else preview.mapNotNull { id -> model.resources.firstOrNull { it.optString("id") == id } }
    var pulling by remember { mutableStateOf(false) }
    LaunchedEffect(model.libraryBusy) { if (!model.libraryBusy) pulling = false }
    PullToRefreshBox(
        isRefreshing = pulling && model.libraryBusy,
        onRefresh = {
            if (!model.reordering) {
                pulling = true
                model.loadLibrary()
            }
        },
        modifier = modifier,
    ) {
        Column(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
            RootHeader(
                model.folder?.getString("name") ?: "资料库",
                "",
                back = if (model.folder != null) ({ model.back() }) else null,
            ) {
                if (model.reordering)
                    QuietAction("完成", enabled = !savingOrder) { model.updateReordering(false) }
                else if (model.canManage)
                    IconButton(onClick = onAdd) {
                        Icon(
                            if (model.folder == null) Icons.Outlined.Add
                            else Icons.Outlined.MoreHoriz,
                            if (model.folder == null) "添加内容" else "合集操作",
                        )
                    }
            }
            model.uploadMessage?.let {
                Surface(
                    onClick = onUpload,
                    color = MaterialTheme.colorScheme.surface,
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth().padding(bottom = 12.dp),
                ) {
                    Row(
                        Modifier.padding(16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        if (model.uploadRunning)
                            CircularProgressIndicator(
                                Modifier.size(20.dp),
                                color = MaterialTheme.colorScheme.secondary,
                                strokeWidth = 2.dp,
                            )
                        else
                            Icon(
                                if (model.uploadError) Icons.Outlined.ErrorOutline
                                else Icons.Outlined.CheckCircle,
                                null,
                                tint = MaterialTheme.colorScheme.secondary,
                            )
                        Text(
                            if (model.uploadRunning) "正在添加视频"
                            else if (model.uploadError) "上传未完成" else "查看上传结果",
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Icon(Icons.Outlined.ChevronRight, null, Modifier.size(18.dp))
                    }
                }
            }
            if (model.resources.isNotEmpty())
                Row(
                    Modifier.fillMaxWidth().padding(bottom = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        if (model.folder == null) "${model.total} 个合集" else "合集内容",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (model.folder != null) {
                        Spacer(Modifier.weight(1f))
                        Hint("${model.total} 项")
                    }
                }
            when {
                model.page == 0 && model.libraryBusy -> LibrarySkeleton(Modifier.weight(1f))
                model.resources.isEmpty() && model.libraryError != null ->
                    Column(
                        Modifier.weight(1f).fillMaxWidth(),
                        verticalArrangement = Arrangement.Center,
                    ) {
                        RetryMessage(model.libraryError!!) { model.loadLibrary() }
                    }
                model.resources.isEmpty() && model.libraryError == null ->
                    Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
                        EmptyContent(
                            Icons.Outlined.VideoLibrary,
                            if (model.folder == null) "从喜欢的内容开始" else "把喜欢的视频放进来",
                            if (model.canManage) "从相册或文件添加，随时在手机查看。\n选好适合孩子的内容，再交给电视。"
                            else "资料库准备好后，就能在这里一起看。",
                            if (model.canManage) "添加内容" else null,
                            onUpload,
                            Modifier,
                        )
                        if (model.canManage) {
                            QuietAction("先建一个合集", onClick = newFolder)
                            if (model.folder == null)
                                SettingsRow(
                                    Icons.Outlined.Tv,
                                    "想在大屏上看？",
                                    "连接电视，选好的内容一起看",
                                    action = connect,
                                )
                        }
                    }
                else ->
                    LazyVerticalGrid(
                        state = grid,
                        columns = GridCells.Fixed(2),
                        modifier = Modifier.weight(1f),
                        horizontalArrangement = Arrangement.spacedBy(20.dp),
                        verticalArrangement = Arrangement.spacedBy(20.dp),
                        contentPadding = PaddingValues(bottom = 24.dp),
                    ) {
                        items(shown, key = { it.getString("id") }) { item ->
                            val id = item.getString("id")
                            val dragModifier =
                                if (!model.reordering || savingOrder) Modifier
                                else
                                    Modifier.pointerInput(id) {
                                        detectDragGestures(
                                            onDragStart = { point ->
                                                grid.layoutInfo.visibleItemsInfo
                                                    .firstOrNull { it.key == id }
                                                    ?.let { cell ->
                                                        dragged = id
                                                        preview =
                                                            model.resources.map {
                                                                it.getString("id")
                                                            }
                                                        dragPoint =
                                                            Offset(
                                                                cell.offset.x.toFloat(),
                                                                cell.offset.y.toFloat(),
                                                            ) + point
                                                    }
                                            },
                                            onDragCancel = {
                                                dragged = null
                                                preview = emptyList()
                                            },
                                            onDragEnd = {
                                                val from =
                                                    model.resources.indexOfFirst {
                                                        it.getString("id") == id
                                                    }
                                                val to = preview.indexOf(id)
                                                if (from >= 0 && to >= 0) move(from, to)
                                                dragged = null
                                                preview = emptyList()
                                            },
                                        ) { change, amount ->
                                            change.consume()
                                            dragPoint += amount
                                            val target =
                                                grid.layoutInfo.visibleItemsInfo
                                                    .firstOrNull {
                                                        dragPoint.x >= it.offset.x &&
                                                            dragPoint.x <=
                                                                it.offset.x + it.size.width &&
                                                            dragPoint.y >= it.offset.y &&
                                                            dragPoint.y <=
                                                                it.offset.y + it.size.height
                                                    }
                                                    ?.key as? String
                                            if (target != null && target != id) {
                                                val next = preview.toMutableList()
                                                val from = next.indexOf(id)
                                                val to = next.indexOf(target)
                                                if (from >= 0 && to >= 0) {
                                                    next.removeAt(from)
                                                    next.add(to, id)
                                                    preview = next
                                                }
                                            }
                                            if (dragPoint.y < 60)
                                                scope.launch { grid.scrollBy(-24f) }
                                            else if (
                                                dragPoint.y > grid.layoutInfo.viewportEndOffset - 60
                                            )
                                                scope.launch { grid.scrollBy(24f) }
                                        }
                                    }
                            ResourceCard(
                                item,
                                model.api,
                                { if (!model.reordering) onResource(item) },
                                if (model.canManage && !model.reordering) ({ contextItem = item })
                                else null,
                                dragModifier
                                    .zIndex(if (dragged == id) 1f else 0f)
                                    .graphicsLayer { alpha = if (dragged == id) .5f else 1f }
                                    .semantics {
                                        if (model.canManage)
                                            customActions =
                                                if (model.reordering)
                                                    listOf(
                                                        CustomAccessibilityAction("上移") {
                                                            val at =
                                                                model.resources.indexOfFirst {
                                                                    it.getString("id") == id
                                                                }
                                                            if (at > 0) move(at, at - 1)
                                                            at > 0
                                                        },
                                                        CustomAccessibilityAction("下移") {
                                                            val at =
                                                                model.resources.indexOfFirst {
                                                                    it.getString("id") == id
                                                                }
                                                            if (at < model.resources.lastIndex)
                                                                move(at, at + 1)
                                                            at < model.resources.lastIndex
                                                        },
                                                    )
                                                else
                                                    listOf(
                                                        CustomAccessibilityAction("编辑排列") {
                                                            model.updateReordering(true)
                                                            true
                                                        },
                                                        CustomAccessibilityAction(
                                                            if (item.optString("type") == "Episode")
                                                                "视频设置"
                                                            else "合集设置"
                                                        ) {
                                                            onMore(item)
                                                            true
                                                        },
                                                    )
                                    },
                            )
                        }
                        if (model.libraryError != null)
                            item(span = { GridItemSpan(maxLineSpan) }) {
                                RetryMessage(model.libraryError!!) { model.loadLibrary() }
                            }
                        if (model.hasMore && model.libraryError == null && !model.reordering)
                            item(span = { GridItemSpan(maxLineSpan) }) {
                                LaunchedEffect(model.page) { model.loadLibrary(true) }
                                Box(
                                    Modifier.fillMaxWidth().height(48.dp),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    CircularProgressIndicator(
                                        Modifier.size(20.dp),
                                        color = MaterialTheme.colorScheme.onSurface,
                                        strokeWidth = 2.dp,
                                    )
                                }
                            }
                    }
            }
        }
    }
    contextItem?.let { item ->
        ModalBottomSheet(onDismissRequest = { contextItem = null }) {
            Column(
                Modifier.navigationBarsPadding().padding(24.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Text(item.getString("name"), style = MaterialTheme.typography.titleLarge)
                SettingsRow(
                    Icons.Outlined.OpenInNew,
                    if (item.optString("type") == "Episode") "打开视频" else "打开合集",
                    action = {
                        contextItem = null
                        onResource(item)
                    },
                )
                SettingsRow(
                    Icons.Outlined.Settings,
                    if (item.optString("type") == "Episode") "视频设置" else "合集设置",
                    action = {
                        contextItem = null
                        onMore(item)
                    },
                )
                if (model.resources.size > 1)
                    SettingsRow(
                        Icons.Outlined.DragIndicator,
                        "编辑排列",
                        action = {
                            contextItem = null
                            model.updateReordering(true)
                        },
                    )
            }
        }
    }
}

@Composable
internal fun ResourceCard(
    item: JSONObject,
    api: ParentApi?,
    open: () -> Unit,
    more: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .combinedClickable(onClick = open, onLongClick = more, onLongClickLabel = "内容操作")
    ) {
        ResourceCover(
            item,
            api,
            Modifier.fillMaxWidth().aspectRatio(16f / 9).clip(RoundedCornerShape(14.dp)),
            compact = true,
        )
        Column(
            Modifier.fillMaxWidth().padding(top = 8.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            Text(
                item.getString("name"),
                modifier = Modifier.fillMaxWidth(),
                style = MaterialTheme.typography.titleSmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
            if (item.optString("type") == "Episode") {
                val runtime = item.optLong("runtimeMs")
                val duration =
                    if (runtime <= 0) "时长待更新"
                    else
                        java.lang.String.format(
                            java.util.Locale.ROOT,
                            "%d:%02d",
                            runtime / 60_000,
                            runtime / 1_000 % 60,
                        )
                Text(
                    "$duration · ${visibilityLabel(item)}",
                    modifier = Modifier.fillMaxWidth(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                )
            }
        }
    }
}

@Composable
internal fun ResourceCover(
    item: JSONObject,
    api: ParentApi?,
    modifier: Modifier,
    compact: Boolean = false,
) {
    var bitmap by
        remember(api, item.optString("imageUrl")) {
            mutableStateOf<Bitmap?>(api?.artwork?.cached(item.optString("imageUrl")))
        }
    val url = item.optString("imageUrl")
    LaunchedEffect(api, url) { if (api != null && url.isNotBlank()) bitmap = api.artwork.load(url) }
    val colors = listOf(Color(0xFF3B6350), Color(0xFF38475C), Color(0xFF8A633B))
    val background = colors[(item.optString("id").hashCode() and Int.MAX_VALUE) % colors.size]
    Box(
        modifier.background(if (compact) MaterialTheme.colorScheme.surfaceVariant else background),
        contentAlignment = Alignment.Center,
    ) {
        if (bitmap != null)
            Image(
                bitmap!!.asImageBitmap(),
                null,
                Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop,
            )
        else if (compact)
            Icon(
                if (item.optString("type") == "Episode") Icons.Outlined.PlayArrow
                else Icons.Outlined.FolderOpen,
                null,
                Modifier.size(30.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        else BrandMark(Modifier.fillMaxHeight(.58f).aspectRatio(1f))
    }
}

@Composable
internal fun DevicesScreen(
    model: ParentViewModel,
    modifier: Modifier,
    report: (String) -> Unit,
    connect: () -> Unit,
    more: (JSONObject) -> Unit,
    settings: (JSONObject) -> Unit,
    navigate: (String) -> Unit,
    command: (JSONObject, String) -> Unit,
) {
    var pulling by remember { mutableStateOf(false) }
    LaunchedEffect(model.devicesBusy) { if (!model.devicesBusy) pulling = false }
    PullToRefreshBox(
        isRefreshing = pulling && model.devicesBusy,
        onRefresh = {
            pulling = true
            model.loadDevices()
            model.loadStatistics()
        },
        modifier = modifier,
    ) {
        LazyColumn(
            Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp),
        ) {
            item { RootHeader("电视", "") }
            if (model.devicesBusy && !model.devicesLoaded) item { DevicesSkeleton() }
            model.watch?.let { value ->
                val summary = WatchStatistics(value)
                if (summary.hasViewingHistory) item { WatchStatisticsCard(summary, report) }
                else if (model.devicesLoaded && model.devices.isNotEmpty())
                    item {
                        SurfaceBlock {
                            Column(
                                Modifier.padding(20.dp),
                                verticalArrangement = Arrangement.spacedBy(6.dp),
                            ) {
                                Text("等待第一段观看时光", style = MaterialTheme.typography.titleSmall)
                                Hint("电视开始播放后，观看时长和记录会出现在这里。")
                            }
                        }
                    }
            }
            model.statisticsError?.let {
                item { RetryMessage("观看记录未更新：$it") { model.loadStatistics() } }
            }
            model.devicesError?.let { item { RetryMessage(it) { model.loadDevices() } } }
            if (model.devicesLoaded && model.devices.isEmpty())
                item {
                    SurfaceBlock {
                        Column(
                            Modifier.padding(24.dp),
                            verticalArrangement = Arrangement.spacedBy(20.dp),
                        ) {
                            IconBadge(Icons.Outlined.Tv, Modifier.size(64.dp))
                            Text("一起在大屏幕上看", style = MaterialTheme.typography.headlineMedium)
                            Hint(
                                if (model.canManage) "连接电视后，可以安排每天的观看时间，\n也能用熟悉的声音提醒孩子休息。"
                                else "请家长连接电视，在大屏幕上看喜欢的内容。"
                            )
                            if (model.canManage) {
                                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                                ConnectionStep("1", "打开电视上的 MollyTime", "找到屏幕上的四位绑定码")
                                ConnectionStep("2", "在这里完成连接", "输入绑定码，确认电视名称")
                                PrimaryAction("连接电视", Icons.Outlined.Add, onClick = connect)
                            }
                        }
                    }
                }
            if (model.devices.isNotEmpty())
                item {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "我的电视",
                            Modifier.weight(1f),
                            style = MaterialTheme.typography.titleSmall,
                        )
                        Hint("${model.devices.size} 台")
                        if (model.canManage)
                            IconButton(onClick = connect) { Icon(Icons.Outlined.Add, "连接电视") }
                    }
                }
            items(model.devices.size, key = { model.devices[it].getString("deviceId") }) { index ->
                val device = model.devices[index]
                SurfaceBlock {
                    Column(
                        Modifier.padding(20.dp),
                        verticalArrangement = Arrangement.spacedBy(16.dp),
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(14.dp),
                        ) {
                            IconBadge(Icons.Outlined.Tv, Modifier.size(48.dp))
                            Column(Modifier.weight(1f)) {
                                Text(
                                    device.getString("name"),
                                    style = MaterialTheme.typography.titleMedium,
                                )
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    Box(
                                        Modifier.size(6.dp)
                                            .background(
                                                if (device.optBoolean("online"))
                                                    MaterialTheme.colorScheme.secondary
                                                else MaterialTheme.colorScheme.outline,
                                                CircleShape,
                                            )
                                    )
                                    Text(
                                        if (device.optBoolean("online")) "电视在线" else "电视离线",
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                            if (model.canManage)
                                IconButton(onClick = { more(device) }) {
                                    Icon(
                                        Icons.Outlined.MoreHoriz,
                                        "${device.getString("name")}的更多操作",
                                    )
                                }
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        val reminder = device.optJSONObject("reminder")
                        reminder?.optJSONObject("currentWatch")?.optString("name")?.let {
                            Text("正在看《$it》", style = MaterialTheme.typography.bodyMedium)
                        }
                        Text(watchLabel(device), style = MaterialTheme.typography.titleMedium)
                        if (device.optBoolean("enabled"))
                            Hint(
                                "每天 ${device.optInt("amount")} ${if (device.optString("mode") == "episodes") "集" else "分钟"}"
                            )
                        if (
                            device.has("acknowledged") &&
                                !device.isNull("acknowledged") &&
                                device.optInt("version") > device.optInt("acknowledged")
                        )
                            Hint("已安排，等待电视确认")
                        if (device.optBoolean("supported", true).not()) Hint("电视客户端升级后可使用观看安排")
                        if (model.canManage && device.has("version")) {
                            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                OutlinedButton(
                                    onClick = { settings(device) },
                                    Modifier.weight(1f).heightIn(min = 48.dp),
                                    colors =
                                        ButtonDefaults.outlinedButtonColors(
                                            contentColor = MaterialTheme.colorScheme.onSurface
                                        ),
                                ) {
                                    Text("观看安排")
                                }
                                if (device.optBoolean("enabled"))
                                    Button(
                                        onClick = { command(device, "add") },
                                        Modifier.weight(1f).heightIn(min = 48.dp),
                                        enabled = device.optBoolean("supported", true),
                                    ) {
                                        Text(
                                            if (device.optString("mode") == "episodes") "加看 1 集"
                                            else "加看 10 分钟"
                                        )
                                    }
                            }
                            if (
                                reminder?.optBoolean("online") == true &&
                                    !reminder.isNull("currentWatch")
                            ) {
                                val requested = !reminder.isNull("requestId")
                                QuietAction(
                                    if (requested) "已安排，这集看完休息" else "这集看完休息",
                                    enabled = !requested,
                                ) {
                                    model.mutate(
                                        "/api/manage/reminders/requests",
                                        body = json("deviceId" to device.getString("deviceId")),
                                    )
                                }
                            }
                        }
                    }
                }
            }
            if (model.canManage)
                item {
                    SurfaceBlock {
                        SettingsRow(
                            Icons.Outlined.NightsStay,
                            "提醒视频",
                            "用熟悉的声音，提醒孩子休息",
                            action = { navigate("reminder") },
                        )
                        SettingsRow(
                            Icons.Outlined.Lock,
                            "重设家长密码",
                            "所有电视共用的四位数字密码",
                            action = { navigate("pin") },
                        )
                    }
                }
        }
    }
}

@Composable
internal fun AccountScreen(
    model: ParentViewModel,
    modifier: Modifier,
    update: (() -> Unit)? = null,
    navigate: (String) -> Unit,
) {
    val user = model.session!!.getJSONObject("user")
    val name =
        user.optString("displayName").takeUnless { it.isEmpty() || it == "null" }
            ?: user.getString("name")
    val storage = model.settings?.optJSONObject("storage")
    val context = LocalContext.current
    fun bytes(key: String) = Formatter.formatFileSize(context, storage?.optLong(key) ?: 0)
    LazyColumn(
        modifier,
        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(24.dp),
    ) {
        item {
            Row(
                Modifier.fillMaxWidth().clickable { navigate("profile") }.padding(vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                Avatar(user.optString("avatarJPEGBase64"), Modifier.size(64.dp))
                Column(Modifier.weight(1f)) {
                    Text(name, style = MaterialTheme.typography.titleLarge)
                    Spacer(Modifier.height(5.dp))
                    Hint("把好时光，慢慢收藏。")
                }
                Icon(Icons.Outlined.ChevronRight, null)
            }
        }
        item {
            SurfaceBlock {
                Column(Modifier.padding(22.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(
                            "存储空间",
                            style = MaterialTheme.typography.titleMedium,
                            modifier = Modifier.weight(1f),
                        )
                    }
                    if (storage != null) {
                        Row(
                            verticalAlignment = Alignment.Bottom,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                bytes("usedBytes"),
                                style = MaterialTheme.typography.headlineMedium,
                            )
                            Text(
                                "已使用",
                                Modifier.padding(bottom = 3.dp),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        val limit = storage.optLong("limitBytes")
                        val used = storage.optLong("usedBytes")

                        if (limit > 0)
                            LinearProgressIndicator(
                                progress = {
                                    if (limit > 0)
                                        ((used.toDouble() + storage.optLong("reservedBytes")) /
                                                limit)
                                            .toFloat()
                                            .coerceIn(0f, 1f)
                                    else 0f
                                },
                                modifier = Modifier.fillMaxWidth().height(6.dp).clip(CircleShape),
                                color = MaterialTheme.colorScheme.secondary,
                                trackColor = MaterialTheme.colorScheme.surfaceVariant,
                            )
                        Row(
                            Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            if (storage.optLong("reservedBytes") > 0)
                                Text(
                                    "上传预留 ${bytes("reservedBytes")}",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            Text(
                                if (limit > 0) "额度 ${bytes("limitBytes")}" else "未设置容量上限",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    } else StorageSkeleton(model.storageBusy)
                }
            }
        }
        model.storageError?.let { item { RetryMessage(it) { model.loadStorage() } } }
        item {
            SurfaceBlock {
                SettingsRow(Icons.Outlined.DeleteOutline, "最近删除", action = { navigate("trash") })
                SettingsRow(Icons.Outlined.Subtitles, "播放偏好", action = { navigate("playback") })
                SettingsRow(Icons.Outlined.Info, "观看说明", action = { navigate("viewingInfo") })
                SettingsRow(Icons.Outlined.Description, "免责条款", action = { navigate("disclaimer") })
                if (update != null)
                    SettingsRow(
                        Icons.Outlined.SystemUpdate,
                        "版本更新",
                        BuildConfig.VERSION_NAME,
                        action = update,
                    )
            }
        }
    }
}

@Composable
internal fun ConnectionSheet(model: ParentViewModel, dismiss: () -> Unit) {
    var address by rememberSaveable { mutableStateOf(model.server) }
    var error by remember { mutableStateOf<String?>(null) }
    SheetHeading("连接设置", "默认连接 MollyTime 官方服务")
    FieldLabel("服务地址")
    MollyTextField(
        address,
        {
            address = it
            error = null
        },
        "https://mollytime.app",
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
        error = error != null,
    )
    error?.let { ErrorMessage(it) }
    Hint("如使用自己的服务，请输入完整的 HTTPS 地址。")
    PrimaryAction("保存连接设置") {
        runCatching { Endpoint(address).origin.toString() }
            .onSuccess {
                model.server = it
                dismiss()
            }
            .onFailure { error = "请输入完整的 HTTPS 服务地址" }
    }
}

@Composable
internal fun NameSheet(
    title: String,
    label: String,
    initial: String,
    busy: Boolean,
    actionLabel: String = "保存",
    save: (String) -> Unit,
) {
    var value by rememberSaveable(initial) { mutableStateOf(initial) }
    var attempted by remember { mutableStateOf(false) }
    if (title.isNotEmpty()) SheetHeading(title)
    FieldLabel(label)
    MollyTextField(
        value,
        { value = it },
        label,
        enabled = !busy,
        error = attempted && value.isBlank(),
    )
    if (attempted && value.isBlank()) ErrorMessage("请填写$label")
    PrimaryAction(actionLabel, enabled = !busy) {
        attempted = true
        if (value.isNotBlank()) save(value.trim())
    }
}

@Composable
internal fun PairCodeSheet(busy: Boolean, scan: () -> Unit = {}, lookup: (String) -> Unit) {
    var code by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf(false) }
    IconBadge(Icons.Outlined.Tv, Modifier.size(64.dp))
    SheetHeading("连接你的电视", "打开电视上的 MollyTime，输入屏幕上的四位绑定码。")
    FieldLabel("绑定码")
    MollyTextField(
        code,
        {
            code = it
            error = false
        },
        "输入四位绑定码或粘贴配对链接",
        enabled = !busy,
        error = error,
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
        keyboardActions =
            KeyboardActions(onDone = { if (code.isBlank()) error = true else lookup(code) }),
    )
    if (error) ErrorMessage("请输入电视上的绑定码")
    PrimaryAction("查找电视", enabled = !busy) { if (code.isBlank()) error = true else lookup(code) }
    QuietAction("扫描电视二维码", enabled = !busy, onClick = scan)
}

@Composable
internal fun WatchSheet(
    device: JSONObject,
    pinSet: Boolean,
    busy: Boolean,
    save: (Boolean, String, Int, String) -> Unit,
) {
    val version = device.optInt("version")
    var enabled by rememberSaveable(version) { mutableStateOf(device.optBoolean("enabled")) }
    var minutes by
        rememberSaveable(version) {
            mutableStateOf(
                if (device.optString("mode") == "minutes") device.optInt("amount", 20).toString()
                else "20"
            )
        }
    var episodes by
        rememberSaveable(version) {
            mutableStateOf(
                if (device.optString("mode") == "episodes") device.optInt("amount", 2).toString()
                else "2"
            )
        }
    var mode by rememberSaveable(version) { mutableStateOf(device.optString("mode", "minutes")) }
    var amount by
        rememberSaveable(version) { mutableStateOf(device.optInt("amount", 20).toString()) }
    var pin by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    SheetHeading("每天的观看安排", device.getString("name"))
    SurfaceBlock {
        Row(Modifier.padding(20.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("安排每天的观看额度", style = MaterialTheme.typography.titleSmall)
                Hint("在电视上按约定观看")
            }
            Switch(checked = enabled, onCheckedChange = { enabled = it }, enabled = !busy)
        }
    }
    if (enabled) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            listOf("minutes" to "按分钟", "episodes" to "按集数").forEachIndexed { index, (value, title)
                ->
                SegmentedButton(
                    selected = mode == value,
                    onClick = {
                        if (mode != value) {
                            if (mode == "episodes") episodes = amount else minutes = amount
                            mode = value
                            amount = if (value == "episodes") episodes else minutes
                        }
                    },
                    shape = SegmentedButtonDefaults.itemShape(index, 2),
                    enabled = !busy,
                    colors =
                        SegmentedButtonDefaults.colors(
                            activeContainerColor = Jasmine,
                            activeContentColor = Color(0xFF302C20),
                        ),
                ) {
                    Text(title)
                }
            }
        }
        val unit = if (mode == "episodes") "集" else "分钟"
        FieldLabel("每天可看")
        val presets =
            if (mode == "episodes") listOf(1, 2, 3, 4, 5, 6) else listOf(10, 15, 20, 30, 45, 60)
        presets.chunked(3).forEach { row ->
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                row.forEach { count ->
                    FilterChip(
                        selected = amount == count.toString(),
                        onClick = { amount = count.toString() },
                        label = { Text("$count $unit") },
                        modifier = Modifier.weight(1f),
                        enabled = !busy,
                        colors =
                            FilterChipDefaults.filterChipColors(
                                selectedContainerColor = Jasmine,
                                selectedLabelColor = Color(0xFF302C20),
                            ),
                    )
                }
            }
        }
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            MollyTextField(
                amount,
                { amount = it },
                "数量（$unit）",
                modifier = Modifier.weight(1f),
                enabled = !busy,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
            )
            val current = amount.toIntOrNull()
            val step = if (mode == "episodes") 1 else 5
            val limit = if (mode == "episodes") 99 else 600
            IconButton(
                onClick = { amount = ((current ?: 1) - step).coerceAtLeast(1).toString() },
                enabled = !busy && current != null && current in 1..limit,
            ) {
                Icon(Icons.Outlined.Remove, "减少 $step $unit")
            }
            IconButton(
                onClick = { amount = ((current ?: 1) + step).coerceAtMost(limit).toString() },
                enabled = !busy && current != null && current in 1..limit,
            ) {
                Icon(Icons.Outlined.Add, "增加 $step $unit")
            }
        }
        if (!pinSet) {
            FieldLabel("首次设置家长密码")
            MollyTextField(
                pin,
                { pin = it },
                "四位数字，不要告诉孩子",
                enabled = !busy,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                visualTransformation = PasswordVisualTransformation(),
            )
        }
    }
    error?.let { ErrorMessage(it) }
    Hint("首次开启后今天即可观看；后续额度调整从明天起生效。每日北京时间 0 点恢复额度。")
    PrimaryAction("保存安排", enabled = !busy) {
        val count = amount.takeIf { it.matches(Regex("[0-9]+")) }?.toIntOrNull()
        val limit = if (mode == "episodes") 99 else 600
        if (enabled && (count == null || count !in 1..limit)) error = "请输入 1～$limit 的整数"
        else if (enabled && !pinSet && !pin.matches(Regex("[0-9]{4}"))) error = "请输入四位数字家长密码"
        else {
            error = null
            save(
                enabled,
                mode,
                count?.takeIf { it in 1..limit } ?: device.optInt("amount", 20).coerceIn(1, limit),
                pin,
            )
        }
    }
}

@Composable
internal fun BrandMark(modifier: Modifier) {
    Image(painterResource(R.drawable.app_mark), null, modifier)
}

@Composable
internal fun RootHeader(
    title: String,
    subtitle: String,
    back: (() -> Unit)? = null,
    actions: @Composable RowScope.() -> Unit = {},
) {
    Row(
        Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 20.dp).heightIn(min = 44.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (back != null)
            IconButton(onClick = back) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "返回上一级") }
        Column(Modifier.weight(1f)) {
            Text(
                title,
                style = MaterialTheme.typography.headlineLarge,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle.isNotEmpty())
                Text(
                    subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
        }
        actions()
    }
}

@Composable
internal fun IconBadge(icon: ImageVector, modifier: Modifier = Modifier) {
    Surface(
        modifier,
        color = MaterialTheme.colorScheme.surfaceVariant,
        shape = RoundedCornerShape(18.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, null, Modifier.size(26.dp), tint = MaterialTheme.colorScheme.secondary)
        }
    }
}

@Composable
internal fun SheetHeading(title: String, subtitle: String = "") {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleLarge)
        if (subtitle.isNotEmpty()) Hint(subtitle)
    }
}

@Composable
internal fun SurfaceBlock(content: @Composable ColumnScope.() -> Unit) {
    Surface(
        color = MaterialTheme.colorScheme.surface,
        shape = MaterialTheme.shapes.large,
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(content = content)
    }
}

@Composable
internal fun SettingsRow(
    icon: ImageVector,
    title: String,
    detail: String? = null,
    destructive: Boolean = false,
    action: (() -> Unit)? = null,
) {
    val color =
        if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
    Row(
        Modifier.fillMaxWidth()
            .then(if (action != null) Modifier.clickable(onClick = action) else Modifier)
            .padding(horizontal = 20.dp, vertical = 16.dp)
            .heightIn(min = 32.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(
            icon,
            null,
            Modifier.size(22.dp),
            tint = if (destructive) color else MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = color)
            if (!detail.isNullOrEmpty())
                Text(
                    detail,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
        }
        if (action != null)
            Icon(
                Icons.Outlined.ChevronRight,
                null,
                Modifier.size(18.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
    }
}

@Composable
internal fun PrimaryAction(
    title: String,
    icon: ImageVector? = null,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().heightIn(min = 54.dp),
        shape = RoundedCornerShape(28.dp),
        contentPadding = PaddingValues(horizontal = 24.dp, vertical = 14.dp),
    ) {
        Text(title)
        if (icon != null) {
            Spacer(Modifier.width(10.dp))
            Icon(icon, null, Modifier.size(20.dp))
        }
    }
}

@Composable
internal fun QuietAction(title: String, enabled: Boolean = true, onClick: () -> Unit) {
    TextButton(
        onClick = onClick,
        enabled = enabled,
        colors =
            ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
        modifier = Modifier.heightIn(min = 48.dp),
    ) {
        Text(title)
    }
}

@Composable
internal fun Hint(value: String) {
    Text(
        value,
        style = MaterialTheme.typography.bodyMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
internal fun FieldLabel(value: String) {
    Text(
        value,
        style = MaterialTheme.typography.titleSmall,
        modifier = Modifier.padding(bottom = 8.dp),
    )
}

@Composable
internal fun MollyTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    error: Boolean = false,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    keyboardOptions: KeyboardOptions = KeyboardOptions.Default,
    keyboardActions: KeyboardActions = KeyboardActions.Default,
    trailingIcon: @Composable (() -> Unit)? = null,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        modifier =
            modifier.fillMaxWidth().heightIn(min = 56.dp).semantics {
                contentDescription = placeholder
            },
        placeholder = { Text(placeholder, style = MaterialTheme.typography.bodyLarge) },
        singleLine = true,
        enabled = enabled,
        isError = error,
        visualTransformation = visualTransformation,
        keyboardOptions = keyboardOptions,
        keyboardActions = keyboardActions,
        trailingIcon = trailingIcon,
        shape = RoundedCornerShape(18.dp),
        colors =
            OutlinedTextFieldDefaults.colors(
                focusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
                unfocusedContainerColor = MaterialTheme.colorScheme.surfaceVariant,
                focusedBorderColor = MaterialTheme.colorScheme.secondary,
                unfocusedBorderColor = Color.Transparent,
                cursorColor = MaterialTheme.colorScheme.secondary,
            ),
        textStyle = MaterialTheme.typography.bodyLarge,
    )
}

@Composable
internal fun ErrorMessage(value: String) {
    Text(
        value,
        color = MaterialTheme.colorScheme.error,
        style = MaterialTheme.typography.bodyMedium,
        modifier =
            Modifier.semantics {
                liveRegion = LiveRegionMode.Polite
                error(value)
            },
    )
}

@Composable
internal fun RetryMessage(value: String, retry: () -> Unit) {
    Column {
        ErrorMessage(value)
        QuietAction("重新加载", onClick = retry)
    }
}

@Composable
internal fun LoadingContent(label: String, modifier: Modifier) {
    Column(
        modifier,
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        CircularProgressIndicator(
            Modifier.size(24.dp),
            color = MaterialTheme.colorScheme.secondary,
            strokeWidth = 2.dp,
        )
        Spacer(Modifier.height(16.dp))
        Hint(label)
    }
}

@Composable
internal fun EmptyContent(
    icon: ImageVector,
    title: String,
    detail: String,
    action: String?,
    onClick: () -> Unit,
    modifier: Modifier,
) {
    Column(
        modifier.fillMaxWidth().padding(vertical = 40.dp).widthIn(max = 440.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        IconBadge(icon, Modifier.size(72.dp))
        Text(title, style = MaterialTheme.typography.titleLarge)
        Text(
            detail,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        if (action != null)
            Button(
                onClick = onClick,
                modifier = Modifier.heightIn(min = 52.dp),
                contentPadding = PaddingValues(horizontal = 28.dp),
            ) {
                Icon(Icons.Outlined.Add, null, Modifier.size(20.dp))
                Spacer(Modifier.width(8.dp))
                Text(action)
            }
    }
}

@Composable
internal fun ConnectionStep(number: String, title: String, detail: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(14.dp), verticalAlignment = Alignment.Top) {
        Surface(
            Modifier.size(28.dp),
            shape = CircleShape,
            color = MaterialTheme.colorScheme.surfaceVariant,
        ) {
            Box(contentAlignment = Alignment.Center) {
                Text(number, style = MaterialTheme.typography.labelMedium)
            }
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            Hint(detail)
        }
    }
}

internal fun visibilityLabel(item: JSONObject) =
    when {
        !item.optBoolean("ready") -> "处理中"
        item.optString("status") != "published" -> "仅家长可看"
        !item.isNull("hiddenByFolder") -> "所在合集未开放"
        else -> "孩子可看"
    }

private fun watchLabel(device: JSONObject): String {
    if (!device.optBoolean("enabled")) return "未限制观看"
    val round = device.optJSONObject("round")
    if (device.optString("status") == "allowed" && round != null) {
        if (round.optString("mode") == "minutes")
            return "今天还能看 ${(round.optLong("remainingMs") + 59999) / 60000} 分钟"
        val count = round.optInt("remainingEpisodes")
        return if (!round.isNull("episodeId")) (if (count > 0) "这一集之后，还能看 $count 集" else "这是今天最后一集")
        else "今天还能看 $count 集"
    }
    return if (device.optString("status").isNotEmpty() && device.optString("status") != "null")
        "今日观看已结束"
    else "已设置每天的观看安排"
}
