package com.molly.tv

import android.os.SystemClock
import android.util.Base64
import org.json.JSONObject
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

/** Signed by the paired server, bound to this device and exact downloaded media. */
object OfflinePolicy {
    private const val FLAGS = Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING
    fun decode(value: String): ByteArray = Base64.decode(value, FLAGS)
    fun payload(token: String, publicKey: String): JSONObject {
        val parts = token.split('.')
        require(parts.size == 2)
        val data = decode(parts[0])
        val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(decode(publicKey)))
        val verifier = Signature.getInstance("SHA256withECDSA")
        verifier.initVerify(key); verifier.update(data)
        require(verifier.verify(decode(parts[1]))) { "离线授权签名无效" }
        return JSONObject(String(data, Charsets.UTF_8))
    }
    fun accept(store: CatalogStore, state: JSONObject) {
        val grant = state.getJSONObject("offlineGrant")
        val data = payload(grant.getString("token"), grant.getString("publicKey"))
        require(data.getString("deviceId") == store.owner.substringAfterLast('|'))
        val pinned = store.get("serverPublicKey")
        require(pinned == null || pinned == grant.getString("publicKey")) { "媒体库离线签名密钥已变化，请重新配对" }
        store.put("serverPublicKey", grant.getString("publicKey"))
        store.put("grant", grant.toString())
        store.put("serverTime", state.getLong("serverTime").toString())
        store.put("clockElapsed", SystemClock.elapsedRealtime().toString())
        store.put("clockWall", System.currentTimeMillis().toString())
        store.put("clockMax", state.getLong("serverTime").toString())
        store.put("offlineBlocked", state.optBoolean("offlineBlocked").toString())
        store.remove("authorizationDenied")
    }
    fun now(store: CatalogStore): Long {
        val server = store.get("serverTime")?.toLongOrNull() ?: throw IllegalStateException("请先联网完成同步")
        val elapsed = store.get("clockElapsed")!!.toLong()
        val delta = SystemClock.elapsedRealtime() - elapsed
        val wallDelta = System.currentTimeMillis() - store.get("clockWall")!!.toLong()
        require(wallDelta >= -2000) { "设备时间已回拨，请联网确认" }
        // Across reboot elapsed time resets; use the saved server/wall offset.
        val estimated = server + if (delta >= 0 && kotlin.math.abs(delta - wallDelta) < 120000) delta else wallDelta
        val maximum = store.get("clockMax")?.toLongOrNull() ?: server
        require(estimated + 2000 >= maximum) { "设备时间已回拨，请联网确认" }
        store.put("clockMax", maxOf(maximum, estimated).toString())
        return estimated
    }
    fun permissions(store: CatalogStore, device: String): org.json.JSONArray {
        require(store.get("authorizationDenied") != "true" && store.get("offlineBlocked") != "true") { "离线播放已暂停，请联网确认" }
        val grant = JSONObject(store.get("grant") ?: throw IllegalStateException("尚未取得离线授权"))
        val data = payload(grant.getString("token"), store.get("serverPublicKey")!!)
        require(data.getString("deviceId") == device && now(store) <= data.getLong("expiresAt")) { "离线授权已到期，请联网确认" }
        return data.getJSONArray("permissions")
    }
    fun permission(store: CatalogStore, device: String, episode: String, media: String, version: String): JSONObject {
        val values = permissions(store, device)
        for (i in 0 until values.length()) {
            val value = values.getJSONObject(i)
            if (value.getString("episodeId") == episode && value.getString("mediaId") == media && value.getString("version") == version) return value
        }
        throw IllegalStateException("此视频没有有效的离线副本授权")
    }
}
