package com.molly.tv

import android.app.Application
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.util.UUID

internal class GrantFixture {
    val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    private fun b64(data: ByteArray) = Base64.encodeToString(data, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    fun state(device: String, now: Long = System.currentTimeMillis(), expires: Long = now + 7 * 86400000L, sha: String = "sha"): JSONObject {
        val payload = JSONObject().put("deviceId", device).put("issuedAt", now).put("expiresAt", expires)
            .put("permissions", JSONArray().put(JSONObject().put("episodeId", "a").put("mediaId", "m").put("version", sha).put("sha256", sha).put("size", 10)))
        val data = payload.toString().toByteArray()
        val signature = Signature.getInstance("SHA256withECDSA").run { initSign(pair.private); update(data); sign() }
        return JSONObject().put("serverTime", now).put("offlineBlocked", false)
            .put("offlineGrant", JSONObject().put("token", b64(data) + "." + b64(signature)).put("publicKey", b64(pair.public.encoded)))
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [28])
class OfflinePolicyTest {
    private fun CatalogStore.withCatalog(block: (CatalogStore) -> Unit) { try { block(this) } finally { close() } }
    private fun store() = CatalogStore(RuntimeEnvironment.getApplication(), "https://media.test|${UUID.randomUUID()}")
    @Test fun exactMediaAndDeviceBindingAreRequired() = store().withCatalog { s ->
        val device = s.owner.substringAfterLast('|')
        OfflinePolicy.accept(s, GrantFixture().state(device))
        assertEquals("m", OfflinePolicy.permission(s, device, "a", "m", "sha").getString("mediaId"))
        assertThrows(IllegalArgumentException::class.java) { OfflinePolicy.permission(s, "other", "a", "m", "sha") }
        assertThrows(IllegalStateException::class.java) { OfflinePolicy.permission(s, device, "a", "m", "changed") }
    }
    @Test fun expiredGrantAndClockRollbackAreRejected() = store().withCatalog { s ->
        val device = s.owner.substringAfterLast('|')
        val now = System.currentTimeMillis()
        OfflinePolicy.accept(s, GrantFixture().state(device, now, now - 1))
        assertThrows(IllegalArgumentException::class.java) { OfflinePolicy.permission(s, device, "a", "m", "sha") }
        s.put("clockWall", (now + 60000).toString())
        assertThrows(IllegalArgumentException::class.java) { OfflinePolicy.now(s) }
    }
    @Test fun signatureKeyReplacementAndKnownRestrictionsFailClosed() = store().withCatalog { s ->
        val device = s.owner.substringAfterLast('|'); val fixture = GrantFixture()
        val state = fixture.state(device)
        OfflinePolicy.accept(s, state)
        assertThrows(IllegalArgumentException::class.java) { OfflinePolicy.accept(s, GrantFixture().state(device)) }
        val grant = state.getJSONObject("offlineGrant")
        assertThrows(Exception::class.java) { OfflinePolicy.payload(grant.getString("token") + "broken", grant.getString("publicKey")) }
        s.put("offlineBlocked", "true")
        assertThrows(IllegalArgumentException::class.java) { OfflinePolicy.permission(s, device, "a", "m", "sha") }
        s.put("offlineBlocked", "false"); s.put("authorizationDenied", "true")
        assertThrows(IllegalArgumentException::class.java) { OfflinePolicy.permission(s, device, "a", "m", "sha") }
    }
}
