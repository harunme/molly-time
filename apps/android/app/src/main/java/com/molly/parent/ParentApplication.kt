package com.molly.parent

import android.app.Application
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/** No password storage. Cookie encrypted by a non-exportable Android Keystore key. */
class SessionVault(context: Context) {
    private val prefs = context.getSharedPreferences("parent-session", Context.MODE_PRIVATE)

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        return (store.getKey("molly-parent-v1", null) as? SecretKey)
            ?: KeyGenerator.getInstance("AES", "AndroidKeyStore")
                .apply {
                    init(
                        KeyGenParameterSpec.Builder(
                                "molly-parent-v1",
                                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                            )
                            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                            .build()
                    )
                }
                .generateKey()
    }

    private fun decode(): JSONObject? =
        runCatching {
                val bytes =
                    Base64.decode(prefs.getString("session", null) ?: return null, Base64.NO_WRAP)
                val cipher =
                    Cipher.getInstance("AES/GCM/NoPadding").apply {
                        init(
                            Cipher.DECRYPT_MODE,
                            key(),
                            GCMParameterSpec(128, bytes.copyOfRange(0, 12)),
                        )
                    }
                JSONObject(
                    cipher.doFinal(bytes.copyOfRange(12, bytes.size)).toString(Charsets.UTF_8)
                )
            }
            .getOrNull()

    private fun write(value: JSONObject) {
        val cipher =
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        check(
            prefs
                .edit()
                .putString(
                    "session",
                    Base64.encodeToString(
                        cipher.iv + cipher.doFinal(value.toString().toByteArray()),
                        Base64.NO_WRAP,
                    ),
                )
                .commit()
        ) {
            "无法保存登录状态"
        }
    }

    @Synchronized
    fun records(): List<JSONObject> = decode()?.optJSONArray("accounts")?.objects().orEmpty()

    @Synchronized
    fun read(): JSONObject? {
        val value = decode() ?: return null
        if (value.has("origin"))
            return value // Migrate the installed single-account vault on next successful restore.
        return value.optJSONArray("accounts")?.objects()?.firstOrNull {
            it.optString("key") == value.optString("active")
        }
    }

    @Synchronized
    fun save(origin: String, cookie: String) {
        val value = decode() ?: JSONObject()
        if (!value.has("accounts")) {
            write(json("origin" to origin, "cookie" to cookie))
            return
        }
        val active = value.optString("active")
        value
            .getJSONArray("accounts")
            .objects()
            .firstOrNull { it.optString("key") == active && it.optString("origin") == origin }
            ?.put("cookie", cookie)
        write(value)
    }

    @Synchronized
    fun remember(origin: String, cookie: String, session: JSONObject): String {
        val identity =
            digest("$origin|${session.getJSONObject("user").getString("id")}".toByteArray())
        val records = records().filter { it.optString("key") != identity }.toMutableList()
        records.add(
            json("key" to identity, "origin" to origin, "cookie" to cookie, "session" to session)
        )
        write(json("active" to identity, "accounts" to org.json.JSONArray(records)))
        return identity
    }

    @Synchronized
    fun forget(identity: String) {
        val value = decode() ?: return
        write(
            json(
                "active" to value.optString("active").takeUnless { it == identity }.orEmpty(),
                "accounts" to
                    org.json.JSONArray(records().filter { it.optString("key") != identity }),
            )
        )
    }

    @Synchronized
    fun needsLogin(identity: String) {
        val value = decode() ?: return
        value
            .optJSONArray("accounts")
            ?.objects()
            ?.firstOrNull { it.optString("key") == identity }
            ?.put("needsLogin", true)
        write(value)
    }

    @Synchronized
    fun expireActive() {
        val value = decode() ?: return
        if (!value.has("accounts")) {
            prefs.edit().clear().commit()
            return
        }
        value
            .getJSONArray("accounts")
            .objects()
            .firstOrNull { it.optString("key") == value.optString("active") }
            ?.apply {
                put("cookie", "")
                put("needsLogin", true)
            }
        value.put("active", "")
        write(value)
    }

    @Synchronized
    fun clear() {
        val active = read()?.optString("key")
        if (!active.isNullOrBlank()) forget(active) else prefs.edit().clear().commit()
    }
}

class ParentApplication : Application() {
    lateinit var vault: SessionVault
    var api: ParentApi? = null
        private set

    var session: JSONObject? = null
        private set

    val canManage
        get() = session?.getJSONObject("user")?.optString("role") in listOf("admin", "superadmin")

    val accountKey
        get() = "${api?.endpoint?.origin}|${session?.getJSONObject("user")?.optString("id")}"

    val updates by lazy { ClientUpdates(this) }
    val uploads by lazy { UploadController(this) }
    val reminderUploads by lazy { UploadController(this, "reminder") }

    override fun onCreate() {
        super.onCreate()
        vault = SessionVault(this)
        beforeAccountChange = {
            uploads.pause()
            reminderUploads.pause()
        }
    }

    fun candidate(origin: String, cookie: String = ""): ParentApi {
        lateinit var client: ParentApi
        client =
            ParentApi(
                Endpoint(origin),
                cookie,
                { value ->
                    if (api === client) vault.save(client.endpoint.origin.toString(), value)
                },
            )
        return client
    }

    var beforeAccountChange: (() -> Unit)? = null

    fun activate(client: ParentApi, value: JSONObject) {
        if (api !== client) beforeAccountChange?.invoke()
        vault.remember(client.endpoint.origin.toString(), client.cookie, value)
        client.diskRoot = noBackupFilesDir
        client.accountScope =
            "${client.endpoint.origin}|${value.getJSONObject("user").getString("id")}"
        api?.takeIf { it !== client }?.artwork?.close()
        api?.takeIf { it !== client }?.artworkUploads?.close()
        val changed = api !== client
        api = client
        session = value
        if (changed) {
            uploads.bind(client, accountKey)
            reminderUploads.bind(client, accountKey)
        }
    }

    fun clear(expired: Boolean = false) {
        beforeAccountChange?.invoke()
        api?.artwork?.close()
        api?.artworkUploads?.close()
        api = null
        session = null
        if (expired) vault.expireActive() else vault.clear()
        uploads.bind(null, "signed-out")
        reminderUploads.bind(null, "signed-out")
    }
}
