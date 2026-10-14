package com.molly.tv

import android.app.Application
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import java.util.concurrent.TimeUnit

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [28])
class MollyTimeApiTest {
    @Test fun subtitlePreferenceIsSavedAndPutIsPreservedAfterTokenRefresh() {
        val server = MockWebServer()
        var preference = "zh"
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if (request.path == "/api/auth/refresh") {
                    return MockResponse().setBody("""{"accessToken":"new-access","refreshToken":"new-refresh"}""")
                }
                if (request.getHeader("Authorization") == "Bearer old-access") {
                    return MockResponse().setResponseCode(401)
                }
                if (request.method == "PUT") {
                    preference = JSONObject(request.body.clone().readUtf8()).getString("defaultSubtitle")
                }
                return MockResponse().setBody(JSONObject().put("defaultSubtitle", preference).toString())
            }
        }
        server.start()
        val session = SessionStore(RuntimeEnvironment.getApplication())
        session.clear()
        session.connect(server.url("/").toString())
        session.save(JSONObject().put("accessToken", "old-access")
            .put("refreshToken", "old-refresh").put("deviceId", "test-tv"))
        val api = MollyTimeApi(session) { "Test TV" }
        try {
            val path = "/api/settings/playback"
            assertEquals("en", api.json("PUT", path, JSONObject().put("defaultSubtitle", "en")).getString("defaultSubtitle"))
            val initial = server.takeRequest(1, TimeUnit.SECONDS)!!
            assertEquals("PUT", initial.method)
            assertEquals(path, initial.path)
            assertEquals("en", JSONObject(initial.body.readUtf8()).getString("defaultSubtitle"))
            val refresh = server.takeRequest(1, TimeUnit.SECONDS)!!
            assertEquals("POST", refresh.method)
            assertEquals("/api/auth/refresh", refresh.path)
            val retry = server.takeRequest(1, TimeUnit.SECONDS)!!
            assertEquals("PUT", retry.method)
            assertEquals(path, retry.path)
            assertEquals("Bearer new-access", retry.getHeader("Authorization"))
            assertEquals("application/json; charset=utf-8", retry.getHeader("Content-Type"))
            assertEquals("en", JSONObject(retry.body.readUtf8()).getString("defaultSubtitle"))
            assertEquals("en", api.json("GET", path).getString("defaultSubtitle"))
            assertEquals("GET", server.takeRequest(1, TimeUnit.SECONDS)!!.method)
            assertEquals("off", api.json("PUT", path, JSONObject().put("defaultSubtitle", "off")).getString("defaultSubtitle"))
            assertEquals("off", api.json("GET", path).getString("defaultSubtitle"))
        } finally {
            server.shutdown()
            session.clear()
        }
    }
}
