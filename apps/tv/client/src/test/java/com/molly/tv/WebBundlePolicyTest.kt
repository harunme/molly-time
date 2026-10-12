package com.molly.tv

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

class WebBundlePolicyTest {
    @Test fun rejectsArchiveTraversalAndAcceptsNormalAssets() {
        assertEquals("assets/main.js", WebBundlePolicy.safeRelative("assets/main.js"))
        listOf("../outside", "/absolute", "assets/../../outside", "assets\\main.js", "assets//main.js").forEach {
            assertNull(WebBundlePolicy.safeRelative(it))
        }
    }

    @Test fun enforcesBridgeCompatibilityRange() {
        assertTrue(WebBundlePolicy.bridgeCompatible(2, 1, 2))
        assertFalse(WebBundlePolicy.bridgeCompatible(3, 1, 2))
        assertFalse(WebBundlePolicy.bridgeCompatible(1, 0, 2))
        assertFalse(WebBundlePolicy.bridgeCompatible(1, 2, 1))
    }
}
