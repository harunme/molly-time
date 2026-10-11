package org.jellyfin.androidtv.molly

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.jellyfin.androidtv.ui.startup.StartupActivity

/** Preview entry point. The server button retains the complete upstream client. */
class MollyHomeActivity : Activity() {
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(48), dp(28), dp(48), dp(28))
            setBackgroundColor(Color.rgb(16, 25, 36))
        }
        setContentView(ScrollView(this).apply { addView(content) })
        fun label(text: String, size: Float, color: Int = Color.WHITE) {
            content.addView(TextView(this).apply {
                this.text = text
                textSize = size
                setTextColor(color)
                setPadding(0, dp(8), 0, dp(8))
            })
        }
        label("MOLLY TV", 32f)
        label("一起看，慢慢长大", 20f, Color.rgb(155, 195, 207))
        val server = action("连接家庭媒体库") {
            startActivity(Intent(this, StartupActivity::class.java))
        }
        content.addView(server)
        label("离线试看", 23f)
        val episodes = runCatching { SampleCatalog.load(this) }.getOrElse { emptyList() }
        if (episodes.isEmpty()) label("暂无内置视频", 18f)
        episodes.groupBy { it.category to it.series }.forEach { (group, items) ->
            label("${group.first} · ${group.second}", 17f, Color.rgb(155, 195, 207))
            items.forEach { episode ->
                val progress = getSharedPreferences("molly-preview-progress", MODE_PRIVATE)
                    .getLong(episode.id, 0L) / 1000
                val suffix = if (progress > 0) "  ·  继续 ${progress / 60}:${(progress % 60).toString().padStart(2, '0')}" else ""
                content.addView(action(episode.title + suffix) {
                    startActivity(Intent(this, SamplePlayerActivity::class.java).putExtra("episode_id", episode.id))
                })
            }
        }
        server.requestFocus()
    }

    override fun onRestart() {
        super.onRestart()
        recreate()
    }

    private fun action(title: String, run: () -> Unit): Button = Button(this).apply {
        text = title
        textSize = 19f
        isAllCaps = false
        gravity = android.view.Gravity.CENTER_VERTICAL or android.view.Gravity.START
        typeface = Typeface.DEFAULT_BOLD
        setTextColor(Color.WHITE)
        setPadding(dp(20), dp(8), dp(20), dp(8))
        layoutParams = LinearLayout.LayoutParams(-1, dp(60)).apply { bottomMargin = dp(8) }
        fun paint(focused: Boolean) {
            background = GradientDrawable().apply {
                cornerRadius = dp(10).toFloat()
                setColor(if (focused) Color.rgb(44, 91, 100) else Color.rgb(29, 43, 58))
                if (focused) setStroke(dp(2), Color.rgb(143, 231, 201))
            }
        }
        paint(false)
        onFocusChangeListener = View.OnFocusChangeListener { _, focused -> paint(focused) }
        setOnClickListener { run() }
    }
}
