package com.molly.tv

import org.junit.Assert.*
import org.junit.Test

class BridgePolicyTest {
    @Test fun signedOssCoversAreTheOnlyExternalImagesAllowed() {
        val cover = "https://covers.oss-cn-test.aliyuncs.com/cover.jpg?OSSAccessKeyId=id&Expires=1&Signature=sig"
        assertTrue(BridgePolicy.allowsOssImage(cover))
        assertFalse(BridgePolicy.allowsOssImage(cover.replace("https:", "http:")))
        assertFalse(BridgePolicy.allowsOssImage(cover.replace(".aliyuncs.com", ".example.com")))
        assertFalse(BridgePolicy.allowsOssImage(cover.substringBefore("&Signature=")))
    }
    @Test fun rejectsCredentialAndCrossOriginRequests() {
        for (path in listOf("https://evil.test/api/home", "//evil.test/api/home",
            "/api/auth/refresh", "/api/auth/pairing/poll", "/api/auth/pairing/start", "/api/home?token=secret", "/api/../auth/login",
            "/api/episodes/a%2Fb", "/api/episodes/a/play")) {
            assertFalse(path, BridgePolicy.allows("GET", path))
        }
    }
    @Test fun mutationIsLimitedToChildSelectionAndPlaybackPreferences() {
        assertTrue(BridgePolicy.allows("GET", "/api/settings/playback"))
        assertTrue(BridgePolicy.allows("PUT", "/api/settings/playback"))
        assertFalse(BridgePolicy.allows("POST", "/api/settings/playback"))
        assertFalse(BridgePolicy.allows("PUT", "/api/manage/settings"))
        assertFalse(BridgePolicy.allows("PUT", "/api/settings/playback?token=secret"))
        assertTrue(BridgePolicy.allows("POST", "/api/children/child-1/select"))
        assertEquals("child-1", BridgePolicy.selectedChild("/api/children/child-1/select"))
        assertFalse(BridgePolicy.allows("DELETE", "/api/children/child-1/select"))
        assertFalse(BridgePolicy.allows("POST", "/api/episodes/episode-1/progress"))
        assertFalse(BridgePolicy.allows("POST", "/api/auth/pairing/poll"))
        assertFalse(BridgePolicy.allows("POST", "/api/auth/pairing/reset"))
    }
    @Test fun catalogReadsAreAllowed() {
        assertTrue(BridgePolicy.allows("GET", "/api/home"))
        assertTrue(BridgePolicy.allows("GET", "/api/series/folder-1/playlist"))
        assertFalse(BridgePolicy.allows("POST", "/api/series/folder-1/playlist"))
        assertTrue(BridgePolicy.allows("GET", "/api/episodes/episode-1"))
        assertFalse(BridgePolicy.allows("GET", "/api/episodes/"))
    }
    @Test fun paginationAllowsOnlyBoundedCatalogParameters() {
        assertTrue(BridgePolicy.allows("GET", "/api/home?page=2&pageSize=24&rowId=library"))
        assertTrue(BridgePolicy.allows("GET", "/api/series/folder-1/playlist?page=1&pageSize=24"))
        for (path in listOf("/api/home?page=0", "/api/home?page=2147483648", "/api/home?pageSize=49",
            "/api/home?page=1&page=2", "/api/home?page=1&token=secret", "/api/home?rowId=a%2Fb",
            "/api/home?page=1?token=secret", "/api/series/folder-1/playlist?rowId=library", "/api/me?page=1")) {
            assertFalse(path, BridgePolicy.allows("GET", path))
        }
        assertFalse(BridgePolicy.allows("POST", "/api/home?page=1"))
    }
}
