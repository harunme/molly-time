package com.molly.tv

/** Pure validation rules shared by archive extraction and local asset routing. */
internal object WebBundlePolicy {
    fun safeRelative(value: String): String? {
        if (value.isEmpty() || value.startsWith('/') || value.contains('\\') || value.contains('\u0000')) return null
        val parts = value.split('/')
        if (parts.any { it.isEmpty() || it == "." || it == ".." }) return null
        return parts.joinToString("/")
    }

    fun bridgeCompatible(bridge: Int, minimum: Int, maximum: Int) = minimum > 0 && maximum >= minimum && bridge in minimum..maximum
}
