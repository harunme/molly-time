package com.molly.tv

import android.content.Context
import android.os.Build
import android.provider.Settings

object DeviceName {
    fun read(context: Context): String {
        val configured = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N_MR1) {
            runCatching {
                Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)
            }.getOrNull()
        } else null
        return select(configured, Build.MANUFACTURER, Build.MODEL)
    }

    internal fun select(configured: String?, manufacturer: String?, model: String?): String {
        fun clean(value: String?): String = value.orEmpty()
            .filterNot { it.isISOControl() }.trim()
            .takeUnless { it.equals("unknown", ignoreCase = true) }.orEmpty()
        val name = clean(configured)
        val maker = clean(manufacturer)
        val product = clean(model)
        // Some TVs use the model code as their default device name. Include the
        // manufacturer for those defaults while preserving custom names.
        if (name.isNotEmpty() && !name.equals(product, ignoreCase = true)) return name.take(128)
        return when {
            product.isEmpty() -> maker.ifEmpty { "Android TV" }
            maker.isEmpty() || product.startsWith(maker, ignoreCase = true) -> product
            else -> "$maker $product"
        }.take(128)
    }
}
