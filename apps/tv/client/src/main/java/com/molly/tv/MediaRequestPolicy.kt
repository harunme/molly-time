package com.molly.tv

import okhttp3.HttpUrl

/** Compare full origins, including scheme and port, before attaching app credentials. */
object MediaRequestPolicy {
    fun sameOrigin(server: HttpUrl, target: HttpUrl): Boolean =
        server.scheme == target.scheme && server.host == target.host && server.port == target.port
}
