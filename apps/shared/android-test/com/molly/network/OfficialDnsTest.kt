package com.molly.network

import java.net.InetAddress
import java.net.Proxy
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException
import javax.net.ssl.SSLPeerUnverifiedException
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

class OfficialDnsTest {
    private val correct = listOf(InetAddress.getByAddress(byteArrayOf(43, 133.toByte(), 227.toByte(), 83)))
    private fun dns(block: (String) -> List<InetAddress>) = object : Dns {
        override fun lookup(hostname: String): List<InetAddress> = block(hostname)
    }

    @Test fun corruptedSystemDNSIsNotConsultedForOfficialHosts() {
        var systemCalls = 0
        val resolver = OfficialDns(listOf(dns { correct }), dns { systemCalls++; throw UnknownHostException() })
        for (host in listOf("mollytime.app", "api.mollytime.app", "bucket.oss-cn-shanghai.aliyuncs.com")) {
            assertEquals(correct, resolver.lookup(host))
        }
        assertEquals(0, systemCalls)
    }

    @Test fun backupResolverRecoversAnUnreachableOrEmptyPrimary() {
        var backupCalls = 0
        for (primary in listOf(dns { throw UnknownHostException("blocked") }, dns { emptyList() })) {
            val resolver = OfficialDns(listOf(primary, dns { backupCalls++; correct }), dns { fail("System DNS should not be used"); emptyList() })
            assertEquals(correct, resolver.lookup("mollytime.app"))
        }
        assertEquals(2, backupCalls)
    }

    @Test fun systemIsLastAvailabilityPathAndAllFailuresArePreserved() {
        val blocked = dns { throw UnknownHostException("blocked") }
        assertEquals(correct, OfficialDns(listOf(blocked, blocked), dns { correct }).lookup("mollytime.app"))
        try {
            OfficialDns(listOf(blocked, blocked), blocked).lookup("mollytime.app")
            fail("All failures must be surfaced")
        } catch (failure: UnknownHostException) { assertEquals(3, failure.suppressed.size) }
    }

    @Test fun privateAndLookalikeNamesKeepTheUsersResolver() {
        val resolver = OfficialDns(listOf(dns { fail("Custom names must not be sent to public DNS"); emptyList() }), dns { correct })
        for (host in listOf("family.local", "family.example", "192.168.1.2", "mollytime.app.evil.example", "notmollytime.app", "evilaliyuncs.com")) {
            assertFalse(host, OfficialDns.protectedHost(host))
            assertEquals(correct, resolver.lookup(host))
        }
    }

    private fun withTLS(certificateHost: String, trustServer: Boolean = true, run: (MockWebServer, OkHttpClient) -> Unit) {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName(certificateHost).build()
        val serverTLS = HandshakeCertificates.Builder().heldCertificate(cert).build()
        val trusted = if (trustServer) cert else HeldCertificate.Builder().build()
        val clientTLS = HandshakeCertificates.Builder().addTrustedCertificate(trusted.certificate).build()
        MockWebServer().use { server ->
            server.useHttps(serverTLS.sslSocketFactory(), false)
            server.enqueue(MockResponse().setBody("{\"ok\":true}"))
            server.start()
            val resolver = OfficialDns(listOf(dns { listOf(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))) }),
                dns { fail("Poisoned system DNS must be bypassed"); emptyList() })
            val client = OkHttpClient.Builder().dns(resolver).proxy(Proxy.NO_PROXY)
                .sslSocketFactory(clientTLS.sslSocketFactory(), clientTLS.trustManager)
                .callTimeout(3, TimeUnit.SECONDS).build()
            try { run(server, client) }
            finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
        }
    }

    @Test fun addressOverridePreservesTLSHostnameHostAndCredentials() = withTLS("mollytime.app") { server, client ->
        val url = server.url("/api/manage/auth/session").newBuilder().host("mollytime.app").build()
        val cookie = listOf("molly_parent", "test-session").joinToString("=")
        client.newCall(Request.Builder().url(url).header("Cookie", cookie).build()).execute().use {
            assertEquals(200, it.code)
        }
        val received = server.takeRequest(1, TimeUnit.SECONDS)!!
        assertEquals("mollytime.app:${server.port}", received.getHeader(":authority") ?: received.getHeader("Host"))
        assertEquals(cookie, received.getHeader("Cookie"))
    }

    @Test fun wrongHostnameCertificateIsRejectedBeforeCredentialsAreSent() = withTLS("other.example") { server, client ->
        val url = server.url("/api/manage/auth/session").newBuilder().host("mollytime.app").build()
        try {
            client.newCall(Request.Builder().url(url).header("Cookie", "secret").build()).execute().close()
            fail("Certificate hostname mismatch must fail")
        } catch (_: SSLPeerUnverifiedException) { }
        assertEquals(0, server.requestCount)
    }

    @Test fun untrustedCertificateIsRejectedBeforeCredentialsAreSent() = withTLS("mollytime.app", false) { server, client ->
        val url = server.url("/api/manage/auth/session").newBuilder().host("mollytime.app").build()
        try {
            client.newCall(Request.Builder().url(url).header("Cookie", "secret").build()).execute().close()
            fail("Untrusted certificate must fail")
        } catch (_: SSLException) { }
        assertEquals(0, server.requestCount)
    }
}
