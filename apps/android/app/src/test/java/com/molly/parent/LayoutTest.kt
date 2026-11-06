package com.molly.parent

import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.ParameterizedRobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(ParameterizedRobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w1024dp-h1366dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LayoutTest(private val width: Int, private val height: Int, private val fontScale: Float, private val dark: Boolean) {
    companion object {
        @JvmStatic
        @ParameterizedRobolectricTestRunner.Parameters(name = "{0}x{1}, font={2}, dark={3}")
        fun sizes(): List<Array<Any>> = listOf(
            arrayOf(320, 640, 1f, false), arrayOf(375, 812, 1f, false),
            arrayOf(320, 640, 2f, true), arrayOf(640, 320, 2f, false),
            arrayOf(768, 1024, 2f, true),
        )
    }

    @get:Rule val compose = createAndroidComposeRule<ComponentActivity>()

    private fun content(body: @Composable ColumnScope.() -> Unit) {
        compose.setContent {
            val configuration = Configuration(LocalConfiguration.current).apply {
                uiMode = if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO
            }
            CompositionLocalProvider(LocalDensity provides Density(1f, fontScale), LocalConfiguration provides configuration) {
                MollyTheme {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.TopStart) {
                        Surface(Modifier.size(width.dp, height.dp).testTag("viewport"), color = MaterialTheme.colorScheme.background) {
                            SheetContent(content = body)
                        }
                    }
                }
            }
        }
    }

    private fun textFits(text: String) {
        val layouts = mutableListOf<TextLayoutResult>()
        compose.onNodeWithText(text, useUnmergedTree = true).performSemanticsAction(SemanticsActions.GetTextLayoutResult) { it(layouts) }
        assertTrue("No text layout for $text", layouts.isNotEmpty())
        layouts.forEach { layout ->
            assertFalse("Text height clipped: $text at width=$width, scale=$fontScale", layout.didOverflowHeight)
            // MultiParagraph.width may retain the maximum constraint even when
            // Text uses its smaller intrinsic width. Check actual glyph bounds.
            for (line in 0 until layout.lineCount) {
                assertTrue("Text width clipped: $text", layout.getLineRight(line) <= layout.size.width + 1f)
                assertTrue("Text starts outside its bounds: $text", layout.getLineLeft(line) >= -1f)
            }
        }
    }

    private fun snapshot(name: String) {
        val directory = System.getenv("MOLLYTIME_LAYOUT_SCREENSHOTS") ?: return
        val file = File(directory, "$name-${width}x$height-$fontScale-$dark.png")
        file.parentFile.mkdirs()
        val bounds = compose.onNodeWithTag("viewport").fetchSemanticsNode().boundsInRoot
        compose.runOnIdle {
            val bitmap = Bitmap.createBitmap(bounds.width.toInt(), bounds.height.toInt(), Bitmap.Config.ARGB_8888)
            val canvas = Canvas(bitmap)
            canvas.translate(-bounds.left, -bounds.top)
            compose.activity.window.decorView.draw(canvas)
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }

    @Test fun folderFooterHasGuttersAndDoesNotOverlapAction() {
        val footer = "隐藏合集不改变视频的观看设置。"
        content { ResourceVisibilitySection(json("type" to "Series", "status" to "published"), true) {} }
        textFits(footer)
        val bounds = compose.onNodeWithText(footer).fetchSemanticsNode().boundsInRoot
        val viewport = compose.onNodeWithTag("viewport").fetchSemanticsNode().boundsInRoot
        val action = compose.onNodeWithText("仅家长可看").fetchSemanticsNode().boundsInRoot
        assertTrue(bounds.left >= viewport.left + 44f)
        assertTrue(bounds.right <= viewport.right - 44f)
        assertTrue(bounds.top > action.bottom)
        snapshot("folder-actions")
    }

    @Test fun longAncestorNamesWrapWithoutClipping() {
        val name = "这是一个很长的合集名称LongCollectionNameWithoutSpaces1234567890".repeat(2)
        val footer = "所在合集「$name」也需允许孩子观看。"
        content { ResourceVisibilitySection(json("type" to "Episode", "status" to "draft", "hiddenByFolder" to json("name" to name)), true) {} }
        textFits(footer)
        snapshot("long-ancestor")
    }

    @Test fun overflowingSheetKeepsLastActionReachable() {
        var clicked = false
        val title = "保存这个名称很长的合集并允许孩子观看"
        content {
            repeat(12) { Hint("较长的说明文字会随系统字号换行，第 $it 段。") }
            PrimaryAction(title, Icons.Outlined.Add) { clicked = true }
        }
        compose.onNodeWithText(title).performScrollTo().assertIsDisplayed()
        textFits(title)
        compose.onNodeWithText(title).performClick()
        assertTrue(clicked)
        snapshot("scrolled-sheet")
    }

    @Test fun heatmapWeekdaysFitAtLargeTextSizes() {
        content { WatchStatisticsCard(WatchStatistics(json("days" to org.json.JSONArray().put(
            json("date" to "2026-11-06", "playedMs" to 3_660_000L))))) {} }
        textFits("一")
        textFits("三")
        textFits("今日观看 ›")
        textFits("近一周观看 ›")
        snapshot("watch-statistics")
    }
}
