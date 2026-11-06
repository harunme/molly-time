package com.molly.parent

import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.text.input.*
import kotlinx.coroutines.*
import org.json.JSONObject

internal fun invitationCode(value: String): String? =
    value
        .filterNot { it.isWhitespace() || it == '-' }
        .uppercase()
        .takeIf { it.length == 12 && it.all { c -> c in "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" } }

internal fun registrationEmail(value: String): String? {
    val normalized = value.trim().lowercase()
    val parts = normalized.split('@')
    if (normalized.length > 254 || parts.size != 2) return null
    val local = parts[0]
    val labels = parts[1].split('.')
    if (
        local.length !in 1..64 ||
            local.startsWith('.') ||
            local.endsWith('.') ||
            local.contains("..") ||
            !local.matches(Regex("^[a-z0-9.!#\\$%&'*+/=?^_`{|}~-]+$")) ||
            labels.size < 2 ||
            labels.any { !it.matches(Regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")) }
    )
        return null
    return normalized
}

@Composable
internal fun RegistrationScreen(model: ParentViewModel, back: () -> Unit) {
    val api = remember(model.server) { ParentApi(Endpoint(model.server)) }
    var code by rememberSaveable { mutableStateOf("") }
    var verified by rememberSaveable { mutableStateOf("") }
    var email by rememberSaveable { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var preview by
        rememberSaveable(
            stateSaver =
                Saver<JSONObject?, String>(save = { it?.toString() }, restore = { JSONObject(it) })
        ) {
            mutableStateOf<JSONObject?>(null)
        }
    var created by rememberSaveable { mutableStateOf(false) }
    var uncertain by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<String?>(null) }
    var existing by remember { mutableStateOf(false) }
    var confirmingSwitch by remember { mutableStateOf(false) }
    var switchApproved by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    fun act() {
        scope.launch {
            busy = true
            failure = null
            try {
                if (preview == null) {
                    val normalized = invitationCode(code) ?: return@launch
                    preview =
                        withContext(Dispatchers.IO) {
                            api.request(
                                "/api/manage/auth/invitation/preview",
                                "POST",
                                json("code" to normalized),
                            )
                        }
                    verified = normalized
                    preview!!
                        .optString("email")
                        .takeUnless { it.isBlank() || it == "null" }
                        ?.let { email = it }
                    uncertain = false
                    existing = false
                } else {
                    if (!created && !uncertain) {
                        try {
                            withContext(Dispatchers.IO) {
                                    api.request(
                                        "/api/manage/auth/invitation/activate",
                                        "POST",
                                        json(
                                            "code" to verified,
                                            "email" to registrationEmail(email),
                                            "password" to password,
                                            "familyName" to
                                                preview!!
                                                    .optString("familyName")
                                                    .takeUnless { it.isBlank() || it == "null" }
                                                    .orEmpty()
                                                    .ifEmpty { "我的资料库" },
                                        ),
                                    )
                                }
                                .also { email = it.getString("email") }
                            created = true
                        } catch (e: Exception) {
                            if (e is CancellationException) throw e
                            if (e is ApiFailure && e.status < 500) {
                                existing = e.status == 409
                                if (e.status == 404) {
                                    preview = null
                                    password = ""
                                }
                                failure = e.message
                            } else {
                                uncertain = true
                                failure = "暂时未收到注册结果，账号可能已创建。请先尝试登录，避免重复提交邀请码。"
                            }
                            return@launch
                        }
                    }
                    model.login(email, password)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = e.message
            } finally {
                busy = false
            }
        }
    }
    DetailFrame("使用邀请码", { if (!busy) back() }) {
        Text("用邀请码开启家庭好时光", style = MaterialTheme.typography.headlineMedium)
        if (preview == null) {
            FieldLabel("注册邀请码")
            MollyTextField(code, { code = it }, "十二位邀请码，例如 XXXX-XXXX-XXXX", enabled = !busy)
        } else {
            Hint(
                preview!!.optString("familyName").takeUnless { it.isBlank() || it == "null" }
                    ?: "我的资料库"
            )
            FieldLabel("邮箱")
            MollyTextField(
                email,
                { email = it },
                "name@example.com",
                enabled = !busy && preview!!.isNull("email") && !created && !uncertain,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
            )
            FieldLabel("登录密码")
            MollyTextField(
                password,
                { password = it },
                "至少八个字符",
                enabled = !busy,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
            )
            Hint("至少 8 个字符，最多 72 字节。注册后会自动登录。")
        }
        failure?.let { ErrorMessage(it) }
        PrimaryAction(
            when {
                busy -> "正在处理…"
                preview == null -> "继续"
                created -> "重试登录"
                uncertain -> "尝试登录"
                else -> "创建账号并登录"
            },
            enabled =
                !busy &&
                    !model.loginBusy &&
                    (if (preview == null) invitationCode(code) != null
                    else
                        registrationEmail(email) != null &&
                            passwordError(password, password) == null),
        ) {
            if (
                preview != null &&
                    model.session != null &&
                    model.hasPendingUpload &&
                    !switchApproved
            ) {
                confirmingSwitch = true
            } else act()
        }
        model.loginError?.let { ErrorMessage(if (created) "账号已创建，但登录未完成。$it" else it) }
        if (existing || created || uncertain) QuietAction("前往登录", !busy) { back() }
        if (preview != null && !created && !uncertain)
            QuietAction("更换邀请码", !busy) {
                preview = null
                verified = ""
                failure = null
                password = ""
            }
        if (uncertain)
            QuietAction("重新检查邀请码", !busy) {
                scope.launch {
                    busy = true
                    try {
                        preview =
                            withContext(Dispatchers.IO) {
                                api.request(
                                    "/api/manage/auth/invitation/preview",
                                    "POST",
                                    json("code" to verified),
                                )
                            }
                        uncertain = false
                    } catch (e: Exception) {
                        if (e is CancellationException) throw e
                        failure = e.message
                    } finally {
                        busy = false
                    }
                }
            }
    }
    if (confirmingSwitch)
        AlertDialog(
            onDismissRequest = { confirmingSwitch = false },
            title = { Text("创建并切换账号？") },
            text = { Text("新账号登录成功后，当前账号的上传会暂停，切回后可继续。已有资料库和电视绑定会保留。") },
            confirmButton = {
                QuietAction("继续") {
                    confirmingSwitch = false
                    switchApproved = true
                    act()
                }
            },
            dismissButton = { QuietAction("取消") { confirmingSwitch = false } },
        )
}
