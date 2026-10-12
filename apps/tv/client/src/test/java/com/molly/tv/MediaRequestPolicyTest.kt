package com.molly.tv

import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test

class MediaRequestPolicyTest {
    @Test fun credentialsStayOnTheApiOrigin() {
        val api = "https://molly.example".toHttpUrl()
        assertTrue(MediaRequestPolicy.sameOrigin(api, "https://molly.example/api/video".toHttpUrl()))
        for (target in listOf("https://bucket.oss-cn-hangzhou.aliyuncs.com/file?signature=x",
            "https://molly.example:8443/api/video", "http://molly.example/api/video",
            "https://molly.example.evil.test/api/video")) {
            assertFalse(target, MediaRequestPolicy.sameOrigin(api, target.toHttpUrl()))
        }
    }
}
