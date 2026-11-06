package com.molly.parent

import java.util.Locale
import kotlin.math.floor

// Shared display contract: tools/fixtures/storage-byte-format.tsv.
internal fun storageBytes(value: Long): String {
    val units = arrayOf("B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB")
    var amount = value.toDouble()
    var unit = 0
    while (amount >= 1024 && unit < units.lastIndex) {
        amount /= 1024
        unit += 1
    }
    if (unit == 0) return "$value B"
    val rounded = floor(amount * 10 + 0.5) / 10
    return String.format(Locale.ROOT, "%.1f %s", rounded, units[unit])
}
