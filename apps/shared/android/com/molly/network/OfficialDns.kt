package com.molly.network

import java.net.InetAddress
import java.net.UnknownHostException
import okhttp3.Dns

/** Changes address resolution only. URLs, TLS names and credential boundaries stay unchanged. */
class OfficialDns(
    private val encrypted: List<Dns>,
    private val system: Dns = Dns.SYSTEM,
) : Dns {
    override fun lookup(hostname: String): List<InetAddress> {
        if (!protectedHost(hostname)) return system.lookup(hostname)
        val failures = mutableListOf<UnknownHostException>()
        for (resolver in encrypted + system) {
            try {
                val addresses = resolver.lookup(hostname)
                if (addresses.isNotEmpty()) return addresses
            } catch (failure: UnknownHostException) {
                failures.add(failure)
            }
        }
        throw UnknownHostException("Unable to resolve $hostname").also { failure ->
            failures.forEach { failure.addSuppressed(it) }
        }
    }

    companion object {
        // OSS signed media/download URLs also pass through the shared transport. Custom server
        // names, LAN names and IP literals retain the user's resolver and private-network access.
        fun protectedHost(hostname: String): Boolean {
            val name = hostname.lowercase().removeSuffix(".")
            return name == "mollytime.app" || name.endsWith(".mollytime.app") ||
                name.endsWith(".aliyuncs.com")
        }
    }
}
