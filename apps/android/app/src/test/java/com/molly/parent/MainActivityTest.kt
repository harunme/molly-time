package com.molly.parent

import androidx.compose.ui.test.*
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w412dp-h915dp")
class MainActivityTest {
    @get:Rule val compose = createComposeRule()
    private fun login(): ParentViewModel {
        val model = ParentViewModel(ApplicationProvider.getApplicationContext())
        model.startup.stop()
        compose.setContent { MollyTheme { ParentScreen(model) } }
        compose.waitUntil(5_000) { !model.restoring }
        return model
    }
    @Test fun loginHasAccessibleFieldsAndRejectsEmptySubmission() {
        val model = login()
        compose.onNodeWithContentDescription("输入邮箱或账号").assertExists()
        compose.onNodeWithContentDescription("输入密码").assertExists()
        compose.onNodeWithText("登录").performScrollTo().performClick()
        compose.onNodeWithText("请输入账号和密码").performScrollTo().assertIsDisplayed()
        assertNull(model.session)
    }
    @Test fun connectionSettingsAreSeparateAndRejectUnsafeOrigins() {
        val model = login()
        compose.onNodeWithText("MollyTime 官方服务").performScrollTo().performClick()
        compose.mainClock.advanceTimeBy(1_000)
        compose.waitForIdle()
        compose.onNodeWithText("连接设置").assertIsDisplayed()
        compose.onNodeWithContentDescription("https://mollytime.app").performTextReplacement("http://unsafe.example")
        compose.onNodeWithText("保存连接设置").performClick()
        compose.onNodeWithText("请输入完整的 HTTPS 服务地址").assertExists()
        assertEquals("https://mollytime.app", model.server)
    }
    @Test fun passwordVisibilityCanBeToggledWithoutLosingInput() {
        login()
        compose.onNodeWithContentDescription("输入密码").performTextInput("local-test-only")
        compose.onNodeWithContentDescription("显示密码").performClick()
        compose.onNodeWithContentDescription("隐藏密码").assertExists()
        compose.onNodeWithContentDescription("输入密码").assertTextContains("local-test-only")
    }
    @Test fun mainPagesHaveNoAddedSearchOrRefreshActions() {
        val app = ApplicationProvider.getApplicationContext<ParentApplication>()
        val transport = okhttp3.OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            val body = when (request.url.encodedPath) {
                "/api/manage/resources" -> "{\"items\":[],\"page\":1,\"pageSize\":30,\"total\":0}"
                "/api/manage/devices" -> "{\"items\":[],\"page\":1,\"pageSize\":100,\"total\":0}"
                "/api/manage/watch-control" -> "{\"devices\":[],\"pinSet\":false}"
                "/api/manage/reminders/devices" -> "[]"
                "/api/manage/overview" -> "{\"watch\":{\"days\":[]}}"
                "/api/manage/settings" -> "{\"storage\":{\"usedBytes\":0,\"reservedBytes\":0,\"limitBytes\":0}}"
                else -> error("Unexpected request: ${request.url.encodedPath}")
            }
            okhttp3.Response.Builder().request(request).protocol(okhttp3.Protocol.HTTP_1_1).code(200).message("fixture").body(body.toResponseBody()).build()
        }.build()
        val api = ParentApi(Endpoint("https://fixture.example"), "test-only", {}, transport)
        ParentApplication::class.java.getDeclaredField("api").apply { isAccessible = true }.set(app, api)
        ParentApplication::class.java.getDeclaredField("session").apply { isAccessible = true }.set(app,
            json("user" to json("id" to "u", "name" to "fixture", "role" to "admin"), "family" to json("name" to "fixture")))
        val model = ParentViewModel(app); model.startup.stop()
        compose.setContent { MollyTheme { ParentScreen(model) } }
        compose.waitUntil(5000) { model.page > 0 }
        fun noExtras() {
            listOf("搜索当前目录", "刷新片库", "刷新电视状态", "刷新空间用量").forEach { compose.onNodeWithContentDescription(it).assertDoesNotExist() }
            compose.onNodeWithText("加载更多").assertDoesNotExist()
        }
        noExtras()
        compose.onNodeWithText("电视").performSemanticsAction(SemanticsActions.OnClick) { it() }; compose.waitForIdle(); compose.waitUntil(5000) { model.devicesLoaded || model.devicesError != null }; assertNull(model.devicesError); noExtras()
        compose.onNodeWithText("我的").performSemanticsAction(SemanticsActions.OnClick) { it() }; compose.waitForIdle(); compose.waitUntil(5000) { model.settings != null }; noExtras()
    }

}
