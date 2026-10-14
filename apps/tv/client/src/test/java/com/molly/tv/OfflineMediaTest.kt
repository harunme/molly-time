package com.molly.tv

import android.app.Application
import android.net.Uri
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.ByteArrayDataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.cache.Cache
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.CacheWriter
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.UUID

@UnstableApi
@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [28])
class OfflineMediaTest {
    @Test fun completeVerifiedVideoAndPrivateSubtitlesPlayWithoutAnyNetworkUpstream() {
        val context = RuntimeEnvironment.getApplication()
        val session = SessionStore(context)
        session.clear(); session.connect("https://unreachable.invalid")
        session.save(JSONObject().put("deviceId", UUID.randomUUID().toString()).put("accessToken", "a").put("refreshToken", "r"))
        val media = MediaStore(context, session, MollyTimeApi(session) { "Test" })
        val store = CatalogStore(context, session.server + "|" + session.deviceId)
        try {
            val bytes = "0123456789".toByteArray()
            val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
            val key = "m:$hash"
            val field = MediaStore::class.java.getDeclaredField("cache").apply { isAccessible = true }
            val cache = field.get(media) as Cache
            val source = CacheDataSource.Factory().setCache(cache).setUpstreamDataSourceFactory { ByteArrayDataSource(bytes) }.createDataSource()
            val spec = DataSpec.Builder().setUri("https://unreachable.invalid/video").setKey(key).setLength(10).build()
            CacheWriter(source, spec, null, null).cache()
            context.getSharedPreferences("molly.media.v1", 0).edit().putBoolean("verified:$key", true).commit()
            OfflinePolicy.accept(store, GrantFixture().state(session.deviceId, sha = hash))
            val subtitle = File(context.filesDir, "offline-subtitles/en.vtt").apply { parentFile!!.mkdirs(); writeText("WEBVTT\n") }
            store.put("media:a", JSONObject().put("playback", JSONObject().put("mediaId", "m").put("version", hash).put("size", 10)
                .put("subtitles", JSONArray().put(JSONObject().put("url", Uri.fromFile(subtitle).toString())))).toString())
            val info = media.offline("a", store).getJSONObject("playback")
            media.offlineFactory().createDataSource().let { reader ->
                try { reader.open(DataSpec.Builder().setUri(info.getString("url")).setKey(key).setLength(10).build()); val actual = ByteArray(10); assertEquals(10, reader.read(actual, 0, 10)); assertArrayEquals(bytes, actual) }
                finally { reader.close() }
            }
            media.offlineFactory().createDataSource().let { reader ->
                try { reader.open(DataSpec(Uri.fromFile(subtitle))); assertTrue(reader.read(ByteArray(20), 0, 20) > 0) }
                finally { reader.close() }
            }
            val missing = media.offlineFactory().createDataSource()
            try { assertThrows(IOException::class.java) { missing.open(DataSpec.Builder().setUri("https://unreachable.invalid/missing").setKey("missing").build()) } }
            finally { missing.close() }
            subtitle.delete()
            assertThrows(IllegalStateException::class.java) { media.offline("a", store) }
        } finally { store.close(); media.close(); session.clear() }
    }
}
