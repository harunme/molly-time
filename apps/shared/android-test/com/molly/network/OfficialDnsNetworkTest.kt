package com.molly.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import okhttp3.Request
import java.net.Proxy
import java.util.concurrent.TimeUnit

/** Explicit local smoke test. Never makes an availability dependency part of CI unit tests. */
class OfficialDnsNetworkTest {
    @Test fun productionHTTPSWorksThroughTheRealEncryptedResolver() {
        assumeTrue(System.getenv("MOLLYTIME_NETWORK_SMOKE") == "1")
        val client = MollyHttp.newBuilder().proxy(Proxy.NO_PROXY)
            .callTimeout(15, TimeUnit.SECONDS).build()
        try {
            client.newCall(Request.Builder().url("https://mollytime.app/healthz").build())
                .execute().use { response ->
                    assertEquals(200, response.code)
                    assertTrue(response.body!!.string().contains("\"ok\":true"))
                    assertEquals("mollytime.app", response.request.url.host)
                    assertTrue(response.handshake!!.peerCertificates.isNotEmpty())
                }
        } finally {
            client.connectionPool.evictAll()
            client.dispatcher.executorService.shutdown()
        }
    }
}
