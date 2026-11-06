package com.molly.parent

import java.nio.file.Files
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class ParityRulesTest {
    @Test
    fun invitationAndPasswordUseIOSBoundaries() {
        assertEquals("ABCD2345EFGH", invitationCode(" abcd-2345 efgh "))
        assertNull(invitationCode("0123456789IO"))
        assertNull(invitationCode("1234"))
        assertEquals("parent@example.com", registrationEmail(" Parent@Example.com "))
        assertNull(registrationEmail("a..b@example.com"))
        assertNull(registrationEmail("a@-example.com"))
        assertNull(passwordError("😀".repeat(8), "😀".repeat(8)))
        assertNotNull(passwordError("1234567", "1234567"))
        assertNotNull(passwordError("界".repeat(25), "界".repeat(25)))
        assertNotNull(passwordError("12345678", "12345679"))
    }

    @Test
    fun cacheIdentitySurvivesUrlRenewalButSeparatesAccountsAndVersions() {
        val info =
            json(
                "mediaId" to "video",
                "version" to "one",
                "size" to 1024,
                "mime" to "video/mp4",
                "url" to "https://oss.example/one",
            )
        val first = MediaDiskCache.key("account-one", info)
        info.put("url", "https://oss.example/two")
        assertEquals(first, MediaDiskCache.key("account-one", info))
        assertNotEquals(first, MediaDiskCache.key("account-two", info))
        info.put("version", "two")
        assertNotEquals(first, MediaDiskCache.key("account-one", info))
        info.put("version", org.json.JSONObject.NULL)
        assertNull(MediaDiskCache.key("account-one", info))
    }

    @Test
    fun corruptedAndTruncatedChunksAreRefetchedWithoutDiscardingOtherChunks() {
        val root = Files.createTempDirectory("molly-cache-test").toFile()
        try {
            val store = VideoChunkStore(root)
            var fetched = 0
            fun read() =
                store.chunk("account-media-v1", 0, 4) {
                    fetched++
                    byteArrayOf(1, 2, 3, 4)
                }
            assertArrayEquals(byteArrayOf(1, 2, 3, 4), read())
            read()
            assertEquals(1, fetched)
            val file = root.listFiles()!!.single()
            val broken = file.readBytes()
            broken[35] = 9
            file.writeBytes(broken)
            read()
            assertEquals(2, fetched)
            file.writeBytes(byteArrayOf(1, 2))
            read()
            assertEquals(3, fetched)
            store.chunk("account-media-v1", 1, 4) { byteArrayOf(4, 3, 2, 1) }
            assertEquals(2, root.listFiles()!!.size)
            try {
                store.chunk("another", 0, 4) { byteArrayOf(1) }
                fail("short response accepted")
            } catch (_: java.io.IOException) {}
            assertEquals(2, root.listFiles()!!.size)
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun namesRespectScalarLengthAndFoldedConflicts() {
        assertEquals(
            "Épisode (3)",
            availableUploadTitle("Épisode", setOf("EPISODE", "episode (2)")),
        )
        val title = availableUploadTitle("😀".repeat(256), setOf("😀".repeat(256)))
        assertEquals(256, title.codePointCount(0, title.length))
        assertTrue(title.endsWith(" (2)"))
    }

    @Test
    fun reportsConvertServerTimestampInFamilyTimezone() {
        assertEquals("11/06 08:30", reportTime("2026-11-06T00:30:00.000Z", "Asia/Shanghai"))
        assertEquals("—", reportTime("invalid", "Asia/Shanghai"))
    }
}
