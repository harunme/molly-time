package com.molly.tv

import org.junit.Assert.assertThrows
import org.junit.Test

class UpdatePolicyTest {
    private fun validate(pkg: String = "com.molly.tv", version: Long = 4, sdk: Int = 23,
                         size: Long = 100, hash: String = "a".repeat(64)) =
        UpdatePolicy.validate(pkg, version, sdk, size, hash, "com.molly.tv", 3, 34)

    @Test fun acceptsNewCompatibleRelease() { validate() }
    @Test fun rejectsWrongPackageDowngradeAndUnsupportedSystem() {
        assertThrows(IllegalArgumentException::class.java) { validate(pkg = "com.molly.tv.debug") }
        assertThrows(IllegalArgumentException::class.java) { validate(version = 3) }
        assertThrows(IllegalArgumentException::class.java) { validate(version = 2) }
        assertThrows(IllegalArgumentException::class.java) { validate(sdk = 35) }
    }
    @Test fun rejectsUnboundedDownloadsAndInvalidHashes() {
        assertThrows(IllegalArgumentException::class.java) { validate(size = 0) }
        assertThrows(IllegalArgumentException::class.java) { validate(size = UpdatePolicy.MAX_APK_BYTES + 1) }
        assertThrows(IllegalArgumentException::class.java) { validate(hash = "bad") }
    }
    @Test fun requiresSameNonEmptySigningIdentity() {
        UpdatePolicy.verifySigners(setOf("production"), setOf("production"))
        assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.verifySigners(setOf("production"), setOf("debug")) }
        assertThrows(IllegalArgumentException::class.java) { UpdatePolicy.verifySigners(emptySet(), emptySet()) }
    }
}
