package com.molly.parent

import okhttp3.*
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class ParentApiTest {
    private fun client(block: (Request) -> Response): ParentApi = ParentApi(Endpoint("https://family.example"), "secret", {},
        OkHttpClient.Builder().addInterceptor { block(it.request()) }.build())
    private fun response(request: Request, body: String = "{}", code: Int = 200, cookie: String? = null) = Response.Builder()
        .request(request).protocol(Protocol.HTTP_1_1).code(code).message("test").body(body.toResponseBody())
        .apply { if (cookie != null) header("Set-Cookie", cookie) }.build()

    @Test fun unsafeOriginsAreRejected() {
        listOf("http://family.example", "https://user:pass@family.example", "https://family.example/path", "https://family.example?q=x", "https://family.example#x").forEach {
            assertTrue(it, runCatching { Endpoint(it) }.isFailure)
        }
    }
    @Test fun sameOriginIncludesPortAndScheme() {
        val endpoint = Endpoint("https://family.example:8443")
        assertTrue(endpoint.sameOrigin(endpoint.resolve("/api/manage/resources")))
        assertFalse(endpoint.sameOrigin(Endpoint("https://family.example").origin))
        assertTrue(runCatching { endpoint.api("https://other.example/api/manage/resources") }.isFailure)
        assertTrue(runCatching { endpoint.api("/manage/") }.isFailure)
    }
    @Test fun pairingOnlyAcceptsAsciiCodesAndOwnLinks() {
        val endpoint = Endpoint("https://family.example")
        assertEquals("0123", endpoint.pairingCode(" 0123 "))
        assertEquals("0123", endpoint.pairingCode("https://family.example/manage/?pair=0123"))
        listOf("１２３４", "12345", "https://other.example/manage/?pair=0123", "https://family.example:8443/manage/?pair=0123", "https://family.example/other?pair=0123").forEach {
            assertNull(endpoint.pairingCode(it))
        }
    }
    @Test fun apiAttachesSessionAndCSRFOnlyForMutations() {
        val requests = mutableListOf<Request>()
        val api = client { request -> requests.add(request); response(request) }; api.csrf = "csrf"
        api.request("/api/manage/settings")
        api.request("/api/manage/resources/a/publish", "POST")
        assertEquals("molly_parent=secret", requests[0].header("Cookie"))
        assertNull(requests[0].header("X-CSRF-Token"))
        assertEquals("csrf", requests[1].header("X-CSRF-Token"))
        assertFalse(api.anonymous.followRedirects)
        assertFalse(api.mediaClient.followRedirects)
    }
    @Test fun sessionCookieAndLoginCSRFRefresh() {
        var saved = ""
        val transport = OkHttpClient.Builder().addInterceptor { response(it.request(), "{\"csrfToken\":\"new-csrf\"}", cookie = "molly_parent=new-secret; Path=/; Secure; HttpOnly") }.build()
        val api = ParentApi(Endpoint("https://family.example"), "old", { saved = it }, transport)
        api.login("parent", "password")
        assertEquals("new-secret", api.cookie); assertEquals("new-secret", saved); assertEquals("new-csrf", api.csrf)
    }
    @Test fun foreignMediaNeverGetsCredentialsEvenIfCallerAddsThem() {
        var intercepted: Request? = null
        // Capture the output of the actual media policy without network I/O.
        val api = ParentApi(Endpoint("https://family.example"), "secret")
        val policy = api.mediaClient.interceptors.last()
        val terminal = Interceptor { chain -> intercepted = chain.request(); response(chain.request()) }
        val isolated = OkHttpClient.Builder().addInterceptor(policy).addInterceptor(terminal).build()
        isolated.newCall(Request.Builder().url("https://oss.example/video.mp4").header("Cookie", "secret").header("Authorization", "Bearer secret").header("X-CSRF-Token", "secret").build()).execute().close()
        assertNull(intercepted!!.header("Cookie")); assertNull(intercepted!!.header("Authorization")); assertNull(intercepted!!.header("X-CSRF-Token"))
        isolated.newCall(Request.Builder().url("https://family.example/api/episodes/e/play").build()).execute().close()
        assertEquals("molly_parent=secret", intercepted!!.header("Cookie"))
    }
    @Test fun statusAndServerFailureArePreserved() {
        val api = client { response(it, "{\"detail\":\"安排已更新\"}", 409) }
        val failure = runCatching { api.request("/api/manage/watch-control/a/commands", "POST") }.exceptionOrNull() as ApiFailure
        assertEquals(409, failure.status); assertEquals("安排已更新", failure.message)
    }
    @Test fun libraryQueryUsesBackendContractAndEncodesSearch() {
        var url: HttpUrl? = null
        val api = client { url = it.url; response(it) }
        api.resources("folder/id", 2, "小猫 & 狗")
        assertEquals("folder/id", url!!.queryParameter("parentId"))
        assertEquals("小猫 & 狗", url!!.queryParameter("q"))
        assertEquals("2", url!!.queryParameter("page")); assertEquals("manual", url!!.queryParameter("sort"))
    }
    @Test fun identifiersCannotEscapePathSegment() {
        assertEquals("a%2Fb%3Fadmin=true", ParentApi.segment("a/b?admin=true"))
    }
}
