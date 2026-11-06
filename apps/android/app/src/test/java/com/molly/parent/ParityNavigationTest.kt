package com.molly.parent

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import okhttp3.*
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ParityNavigationTest {
    @get:Rule val compose = createComposeRule()

    @Test
    fun profileNavigationSurvivesUiRecreationAndSettingsAreReachable() {
        val app = ApplicationProvider.getApplicationContext<ParentApplication>()
        val settingsReads = java.util.concurrent.atomic.AtomicInteger()
        val api =
            ParentApi(
                Endpoint("https://fixture.example"),
                "fixture",
                {},
                OkHttpClient.Builder()
                    .addInterceptor { chain ->
                        val r = chain.request()
                        if (r.url.encodedPath == "/api/manage/settings" && r.method == "GET") settingsReads.incrementAndGet()
                        val body =
                            when (r.url.encodedPath) {
                                "/api/manage/resources" ->
                                    json(
                                        "items" to org.json.JSONArray(),
                                        "page" to 1,
                                        "pageSize" to 30,
                                        "total" to 0,
                                    )
                                "/api/manage/settings" ->
                                    json(
                                        "defaultSubtitle" to "zh",
                                        "storage" to
                                            json(
                                                "usedBytes" to 20,
                                                "reservedBytes" to 10,
                                                "limitBytes" to 100,
                                            ),
                                    )
                                "/api/manage/trash" ->
                                    json(
                                        "items" to org.json.JSONArray(),
                                        "page" to 1,
                                        "pageSize" to 30,
                                        "total" to 0,
                                        "retentionDays" to 7,
                                    )
                                else -> error("Unexpected fixture request ${r.url}")
                            }
                        Response.Builder()
                            .request(r)
                            .protocol(Protocol.HTTP_1_1)
                            .code(200)
                            .message("fixture")
                            .body(body.toString().toResponseBody())
                            .build()
                    }
                    .build(),
            )
        ParentApplication::class
            .java
            .getDeclaredField("api")
            .apply { isAccessible = true }
            .set(app, api)
        ParentApplication::class
            .java
            .getDeclaredField("session")
            .apply { isAccessible = true }
            .set(
                app,
                json(
                    "user" to
                        json(
                            "id" to "u",
                            "name" to "家长示例",
                            "role" to "admin",
                            "accountId" to "123456",
                        ),
                    "family" to json("name" to "fixture"),
                ),
            )
        val model = ParentViewModel(app)
        model.startup.stop()
        val restoration = StateRestorationTester(compose)
        restoration.setContent { MollyTheme { ParentScreen(model) } }
        compose.waitUntil(5000) { model.page > 0 }
        compose.onNodeWithText("我的").performSemanticsAction(SemanticsActions.OnClick) { it() }
        compose.waitForIdle()
        compose.onNodeWithText("退出登录").assertDoesNotExist()
        compose.onNodeWithText("家长示例").performClick()
        compose.onNodeWithText("个人信息").assertExists()
        compose.onNodeWithText("修改登录密码").assertExists()
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("个人信息").assertExists()
        compose.onNodeWithText("修改登录密码").assertExists()
        compose.onNodeWithContentDescription("返回").performClick()
        compose.waitUntil(5000) { model.settings != null }
        val prefetchedReads = settingsReads.get()
        compose.onNodeWithText("播放偏好").performScrollTo().performClick()
        compose.waitUntil(5000) {
            compose.onAllNodesWithText("关闭字幕").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithText("中英文").assertExists()
        compose.onNodeWithContentDescription("返回").performClick()
        compose.onNodeWithText("播放偏好").performScrollTo().performClick()
        compose.onNodeWithText("中英文").assertExists()
        assertEquals(prefetchedReads, settingsReads.get())
        compose.onNodeWithContentDescription("返回").performClick()
        compose.onNodeWithText("最近删除").performScrollTo().performClick()
        compose.waitUntil(5000) {
            compose.onAllNodesWithText("最近没有删除内容").fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription("返回").performClick()
        assertNotNull(model.trashSnapshot)
        compose.onNodeWithText("最近删除").performScrollTo().performClick()
        compose.onNodeWithText("最近没有删除内容").assertExists()
        compose.onNodeWithContentDescription("正在载入最近删除").assertDoesNotExist()
        compose.onNodeWithContentDescription("返回").performClick()
        compose.onNodeWithText("资料库").performSemanticsAction(SemanticsActions.OnClick) { it() }
        compose.onNodeWithContentDescription("添加内容").performClick()
        compose.onNodeWithText("新建合集").assertExists()
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText("新建合集").assertExists()
        assertEquals(0, model.accountGeneration)
    }
}
