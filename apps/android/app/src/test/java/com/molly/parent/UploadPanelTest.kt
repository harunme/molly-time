package com.molly.parent

import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.ViewModelStore
import androidx.test.core.app.ApplicationProvider
import java.io.File
import org.junit.After
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowLooper

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class UploadPanelTest {
    @get:Rule val compose = createComposeRule()
    private val viewModels = ViewModelStore()
    private lateinit var directory: File
    private lateinit var controller: UploadController
    private lateinit var api: ParentApi
    private lateinit var account: String

    private fun showPanel(reminderKind: String? = null) {
        val app = ApplicationProvider.getApplicationContext<ParentApplication>()
        api = ParentApi(Endpoint("https://fixture.example"), "fixture", {})
        ParentApplication::class.java.getDeclaredField("api")
            .apply { isAccessible = true }.set(app, api)
        ParentApplication::class.java.getDeclaredField("session")
            .apply { isAccessible = true }
            .set(app, json("user" to json("id" to "u", "role" to "admin")))
        val model = ParentViewModel(app)
        viewModels.put("upload", model)
        model.startup.stop()
        val kind = if (reminderKind == null) "library" else "reminder"
        controller = UploadController(app, kind)
        account = "upload-panel-test-${System.nanoTime()}"
        directory = File(app.noBackupFilesDir, "Uploads-v1/${digest(account.toByteArray())}/$kind")
        directory.mkdirs()
        loadProgress(0.25)
        compose.setContent {
            MollyTheme { Column { UploadPanel(model, controller, null, reminderKind) } }
        }
    }

    private fun loadProgress(progress: Double) {
        val video = File(directory, "fixture.mp4").apply { writeBytes(byteArrayOf(1)) }
        File(directory, "draft.json").writeText(
            json(
                "file" to video.path,
                "name" to "fixture",
                "completed" to true,
                "resource" to json("id" to "r"),
                "upload" to json("id" to "u", "status" to "ready"),
                "progress" to progress,
                "phase" to "可以在手机观看",
            ).toString()
        )
        controller.bind(api, account)
    }

    private val progressMatcher =
        SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo)

    private fun clearBeforeRecomposition(reminderKind: String? = null) {
        showPanel(reminderKind)
        val progressNode = compose.onNode(progressMatcher).fetchSemanticsNode()
        compose.mainClock.autoAdvance = false
        try {
            compose.runOnIdle {
                controller.clear()
                // Deliver collectAsState and semantics invalidation while the old UI is attached.
                ShadowLooper.idleMainLooper()
                Snapshot.sendApplyNotifications()
                assertNull(controller.state.value)
                assertEquals(0.25f, progressNode.config[SemanticsProperties.ProgressBarRangeInfo].current)
            }
        } finally {
            compose.mainClock.autoAdvance = true
        }
        compose.onNode(progressMatcher).assertDoesNotExist()
        compose.onNodeWithText("从相册选择").assertExists()
    }

    @Test fun clearingLibraryDraftBeforeRecompositionKeepsSemanticsSafe() {
        clearBeforeRecomposition()
    }

    @Test fun clearingReminderDraftBeforeRecompositionKeepsSemanticsSafe() {
        clearBeforeRecomposition("farewell")
    }

    @Test fun newDraftProgressAppearsAfterRecomposition() {
        showPanel()
        compose.onNode(progressMatcher).assertRangeInfoEquals(
            androidx.compose.ui.semantics.ProgressBarRangeInfo(0.25f, 0f..1f)
        )
        compose.runOnIdle {
            controller.clear()
            loadProgress(0.75)
        }
        compose.onNode(progressMatcher).assertRangeInfoEquals(
            androidx.compose.ui.semantics.ProgressBarRangeInfo(0.75f, 0f..1f)
        )
    }

    @After fun tearDown() {
        viewModels.clear()
        if (::controller.isInitialized) controller.pause()
        if (::directory.isInitialized) directory.deleteRecursively()
    }
}
