package com.molly.tv

object BridgePolicy {
    private const val ID = "[A-Za-z0-9-]{1,64}"
    private val reads = Regex("/api/(home|me|families/me/children|(?:series|seasons|episodes)/$ID|series/$ID/playlist)")
    private val select = Regex("/api/children/($ID)/select")
    val image = Regex("/api/items/$ID/image")
    private val ossImageHost = Regex("[a-z0-9-]+\\.oss-[a-z0-9-]+\\.aliyuncs\\.com")
    val id = Regex(ID)
    fun allowsOssImage(url: String): Boolean = runCatching {
        val uri = java.net.URI(url)
        val parameters = uri.rawQuery?.split('&')?.map { it.substringBefore('=') }?.toSet() ?: emptySet()
        uri.scheme == "https" && uri.port == -1 && uri.userInfo == null &&
            ossImageHost.matches(uri.host.orEmpty()) && uri.path.orEmpty().isNotEmpty() &&
            parameters.containsAll(setOf("OSSAccessKeyId", "Signature", "Expires"))
    }.getOrDefault(false)
    fun allows(method: String, path: String): Boolean {
        if (method == "GET" && path == "/api/watch-control") return true
        if (method == "POST" && path in setOf("/api/watch-control/commands", "/api/watch-control/pin")) return true
        if (method == "GET" && path == "/api/live-tv") return true
        if (method == "GET" && path.contains('?')) {
            val route = path.substringBefore('?')
            if (route != "/api/home" && !Regex("/api/series/$ID/playlist").matches(route)) return false
            val pairs = path.substringAfter('?').split('&').map { it.split('=') }
            if (pairs.any { it.size != 2 } || pairs.map { it[0] }.distinct().size != pairs.size) return false
            return pairs.all { (key, value) ->
                when (key) {
                    "page" -> value.matches(Regex("[0-9]+")) && (value.toIntOrNull() ?: 0) > 0
                    "pageSize" -> value.matches(Regex("[0-9]+")) && (value.toIntOrNull() ?: 0) in 1..48
                    "rowId" -> route == "/api/home" && id.matches(value)
                    else -> false
                }
            }
        }
        return (method == "GET" && reads.matches(path)) || (method == "POST" && select.matches(path)) ||
            (method in listOf("GET", "PUT") && path == "/api/settings/playback")
    }
    fun selectedChild(path: String): String? = select.matchEntire(path)?.groupValues?.get(1)
}
