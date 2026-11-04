package com.molly.tv

import android.content.Context
import android.util.AtomicFile
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID

/** Native-only credential. Not a hardware identifier and never exposed to WebView. */
class DeviceIdentityStore(context: Context) {
    private val directory = File(context.noBackupFilesDir, "device-identities")

    @Synchronized fun proof(origin: String): JSONObject {
        check(directory.isDirectory || directory.mkdirs()) { "无法保存设备身份" }
        val key = MessageDigest.getInstance("SHA-256").digest(origin.toByteArray())
            .joinToString("") { "%02x".format(it) }
        val file = AtomicFile(File(directory, "$key.json"))
        if (file.baseFile.exists()) {
            // Corruption must be visible; silently replacing identity would lose history.
            return JSONObject(String(file.readFully(), Charsets.UTF_8)).also {
                UUID.fromString(it.getString("id"))
                require(it.getString("secret").matches(Regex("[0-9a-f]{64}")))
            }
        }
        val bytes = ByteArray(32).also { SecureRandom().nextBytes(it) }
        val proof = JSONObject().put("id", UUID.randomUUID().toString())
            .put("secret", bytes.joinToString("") { "%02x".format(it) })
        val output = file.startWrite()
        try {
            output.write(proof.toString().toByteArray(Charsets.UTF_8))
            file.finishWrite(output)
        } catch (failure: Exception) {
            file.failWrite(output)
            throw failure
        }
        return proof
    }
}
