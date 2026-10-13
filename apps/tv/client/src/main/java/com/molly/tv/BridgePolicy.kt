package com.molly.tv

object BridgePolicy {
    private const val ID = "[A-Za-z0-9-]{1,64}"
    private val reads = Regex("/api/(home|me|families/me/children|(?:series|seasons|episodes)/$ID|series/$ID/playlist)")
    private val select = Regex("/api/children/($ID)/select")
    val image = Regex("/api/items/$ID/image")
    val id = Regex(ID)
    fun allows(method: String, path: String): Boolean =
        (method == "GET" && reads.matches(path)) || (method == "POST" && select.matches(path)) ||
            (method in listOf("GET", "PUT") && path == "/api/settings/playback")
    fun selectedChild(path: String): String? = select.matchEntire(path)?.groupValues?.get(1)
}
