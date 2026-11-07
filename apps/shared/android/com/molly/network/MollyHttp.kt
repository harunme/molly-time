package com.molly.network

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Build
import java.io.File
import java.net.InetAddress
import java.net.Proxy
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import okhttp3.Cache
import okhttp3.Dns
import okhttp3.OkHttpClient
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.dnsoverhttps.DnsOverHttps

/** One resolver/cache per process; independent HTTP dispatchers keep media off API queues. */
object MollyHttp {
    private val maintenance = Executors.newSingleThreadExecutor()
    private var initialized = false
    private var cache: Cache? = null
    private var generation = 0L
    @Volatile private var officialDns: OfficialDns = resolver(null)

    fun newBuilder(): OkHttpClient.Builder = OkHttpClient.Builder().dns(object : Dns {
        override fun lookup(hostname: String): List<InetAddress> = officialDns.lookup(hostname)
    })

    @Synchronized fun initialize(context: Context) {
        if (initialized) return
        initialized = true
        cache = runCatching { Cache(File(context.cacheDir, "encrypted-dns"), 1024L * 1024) }.getOrNull()
        officialDns = resolver(cache)
        val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val changes = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = reset()
            override fun onLost(network: Network) = reset()
        }
        // Reaching Android's callback limit must not prevent the app from starting. DNS HTTP
        // cache entries retain their normal TTL even if the optional invalidation hook fails.
        runCatching {
            if (Build.VERSION.SDK_INT >= 24) connectivity.registerDefaultNetworkCallback(changes)
            else connectivity.registerNetworkCallback(NetworkRequest.Builder()
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), changes)
        }
    }

    private fun reset() {
        // New lookups bypass disk while it is evicted. Disk work stays off the connectivity
        // callback/main threads; existing business requests and active streams are not canceled.
        val current = synchronized(this) { generation += 1; officialDns = resolver(null); generation }
        maintenance.execute {
            runCatching { cache?.evictAll() }
            synchronized(this) {
                if (current == generation) officialDns = resolver(cache)
            }
        }
    }

    private fun resolver(cache: Cache?): OfficialDns {
        val bootstrap = OkHttpClient.Builder()
            .proxy(Proxy.NO_PROXY)
            .followRedirects(false).followSslRedirects(false)
            .connectTimeout(2, TimeUnit.SECONDS).readTimeout(3, TimeUnit.SECONDS)
            .callTimeout(4, TimeUnit.SECONDS).cache(cache).build()
        fun provider(url: String, vararg addresses: String) = DnsOverHttps.Builder()
            .client(bootstrap).url(url.toHttpUrl()).post(false)
            .bootstrapDnsHosts(*addresses.map { InetAddress.getByName(it) }.toTypedArray())
            .build()
        // Only the resolvers' bootstrap addresses are packaged. Application server IPs are
        // always resolved dynamically. HTTPS authenticates both resolvers and business hosts.
        return OfficialDns(listOf(
            provider("https://dns.alidns.com/dns-query", "223.5.5.5", "223.6.6.6"),
            provider("https://doh.pub/dns-query", "1.12.12.12", "120.53.53.53"),
        ))
    }
}
