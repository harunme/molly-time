package com.molly.tv

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PathMeasure
import android.provider.Settings
import android.view.View
import android.view.animation.LinearInterpolator
import androidx.core.graphics.PathParser
import kotlin.math.min

/** Native rendering of the approved paths: available before the WebView is ready. */
class StartupLogoView(context: Context, private val cycleFinished: () -> Unit) : View(context) {
    private val paths = mutableListOf<Path>()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFF8DE7E.toInt() }
    private val route = PathMeasure(Path().apply {
        moveTo(0f, 0f); cubicTo(48f, -22f, 48f, -96f, 8f, -124f)
        cubicTo(48f, -96f, 48f, -22f, 0f, 0f)
    }, false)
    private val position = FloatArray(2)
    private var time = 0f
    private var reported = false
    private val animator = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 2800; interpolator = LinearInterpolator(); repeatCount = ValueAnimator.INFINITE
        addUpdateListener { time = it.animatedValue as Float; invalidate() }
        addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationRepeat(animation: Animator) {
                if (!reported) { reported = true; cycleFinished() }
            }
        })
    }
    init {
        setBackgroundColor(0xFF211F1B.toInt())
        contentDescription = "MollyTime 正在启动"
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
        resources.getXml(R.drawable.app_mark).use { xml ->
            while (xml.eventType != org.xmlpull.v1.XmlPullParser.END_DOCUMENT) {
                if (xml.eventType == org.xmlpull.v1.XmlPullParser.START_TAG && xml.name == "path") {
                    xml.getAttributeValue("http://schemas.android.com/apk/res/android", "pathData")?.let {
                        PathParser.createPathFromPathData(it)?.let(paths::add)
                    }
                }
                xml.next()
            }
        }
    }
    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        val reduced = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        if (reduced) { reported = true; post { cycleFinished() } } else animator.start()
    }
    override fun onDetachedFromWindow() { animator.cancel(); super.onDetachedFromWindow() }
    fun pause() { animator.pause() }
    fun resume() { if (animator.isPaused) animator.resume() }
    fun stop() { animator.cancel() }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (paths.size != 2) return
        val size = min(width, height) * .27f
        canvas.save()
        canvas.translate(width / 2f, height / 2f)
        canvas.scale(size / 352f, size / 352f)
        canvas.translate(-128f, -128f)
        val scales = spring(time)
        canvas.save(); pose(canvas)
        canvas.scale(scales.first, scales.second, 126f, 213f)
        canvas.drawPath(paths[0], paint); canvas.restore()
        val progress = when {
            time < .17f -> 0f
            time < .45f -> .5f * ease((time - .17f) / .28f)
            time < .49f -> .5f
            time < .72f -> .5f + .5f * ease((time - .49f) / .23f)
            else -> 1f
        }
        route.getPosTan(route.length * progress, position, null)
        canvas.save(); canvas.translate(position[0], position[1]); pose(canvas)
        canvas.rotate(-720f * progress, 218f, 190f)
        canvas.drawPath(paths[1], paint); canvas.restore(); canvas.restore()
    }
    private fun pose(canvas: Canvas) {
        canvas.translate(120f, 130f); canvas.rotate(-25f); canvas.scale(1.02f, 1.02f); canvas.translate(-128f, -128f)
    }
    private fun ease(t: Float) = t * t * (3f - 2f * t)
    private fun spring(t: Float): Pair<Float, Float> {
        val times = floatArrayOf(0f, .08f, .17f, .29f, .43f, .55f, .63f, .71f, .80f, .90f, 1f)
        val x = floatArrayOf(1f, 1f, 1.065f, .94f, 1.025f, .99f, 1f, 1.035f, .985f, 1f, 1f)
        val y = floatArrayOf(1f, 1f, .90f, 1.10f, .97f, 1.015f, 1f, .95f, 1.025f, 1f, 1f)
        val i = (0 until times.lastIndex).firstOrNull { t <= times[it + 1] } ?: times.lastIndex - 1
        val p = ease(((t - times[i]) / (times[i + 1] - times[i])).coerceIn(0f, 1f))
        return (x[i] + (x[i + 1] - x[i]) * p) to (y[i] + (y[i + 1] - y[i]) * p)
    }
}
