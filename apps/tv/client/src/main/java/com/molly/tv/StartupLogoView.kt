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
    private var cradleRest: Array<PathParser.PathDataNode>? = null
    private var cradleLifted: Array<PathParser.PathDataNode>? = null
    private var cradlePressed: Array<PathParser.PathDataNode>? = null
    private var cradleFrame: Array<PathParser.PathDataNode>? = null
    private val cradlePath = Path()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFF8DE7E.toInt() }
    private val route = PathMeasure(Path().apply {
        moveTo(0f, 0f); cubicTo(55.2f, -25.3f, 55.2f, -110.4f, 9.2f, -142.6f)
        cubicTo(55.2f, -110.4f, 55.2f, -25.3f, 0f, 0f)
    }, false)
    private val position = FloatArray(2)
    private var time = 0f
    private var reported = false
    private var requested = false
    private var reducedCompletion: Runnable? = null
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
        readLogoPaths()
    }
    // This is intentionally a vector drawable: the animation needs its individual
    // pathData values rather than an inflated Drawable.
    @android.annotation.SuppressLint("ResourceType")
    private fun readLogoPaths() {
        resources.getXml(R.drawable.app_mark).use { xml ->
            while (xml.eventType != org.xmlpull.v1.XmlPullParser.END_DOCUMENT) {
                if (xml.eventType == org.xmlpull.v1.XmlPullParser.START_TAG && xml.name == "path") {
                    xml.getAttributeValue("http://schemas.android.com/apk/res/android", "pathData")?.let {
                        if (paths.isEmpty() && it.contains("V151C212 143 194 149 183 163")) {
                            cradleRest = PathParser.createNodesFromPathData(it)
                            cradleLifted = PathParser.createNodesFromPathData(it.replace(
                                "V151C212 143 194 149 183 163", "V148C212 139 194 145 183 160"))
                            cradlePressed = PathParser.createNodesFromPathData(it.replace(
                                "V151C212 143 194 149 183 163", "V153C212 145 194 151 183 165"))
                            cradleFrame = cradleRest?.let { nodes -> PathParser.deepCopyNodes(nodes) }
                        }
                        PathParser.createPathFromPathData(it)?.let(paths::add)
                    }
                }
                xml.next()
            }
        }
    }
    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (requested) startMotion()
    }
    fun startMotion() {
        requested = true
        if (!isAttachedToWindow || animator.isStarted || reducedCompletion != null || reported) return
        val reduced = Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        if (reduced) {
            // Respect disabled motion, while keeping the static logo visible
            // long enough to avoid a one-frame flash on a cached warm launch.
            reducedCompletion = Runnable {
                reducedCompletion = null
                if (!reported) { reported = true; cycleFinished() }
            }.also { postDelayed(it, 600) }
        } else animator.start()
    }
    override fun onDetachedFromWindow() { stop(); super.onDetachedFromWindow() }
    fun pause() { animator.pause(); reducedCompletion?.let(::removeCallbacks) }
    fun resume() {
        if (animator.isPaused) animator.resume()
        reducedCompletion?.let { removeCallbacks(it); postDelayed(it, 600) }
    }
    fun stop() { animator.cancel(); reducedCompletion?.let(::removeCallbacks); reducedCompletion = null }

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
        canvas.drawPath(animatedCradle(time), paint); canvas.restore()
        val progress = when {
            time < .17f -> 0f
            time < .45f -> .5f * ease((time - .17f) / .28f)
            time < .49f -> .5f
            time < .72f -> .5f + .5f * ease((time - .49f) / .23f)
            else -> 1f
        }
        route.getPosTan(route.length * progress, position, null)
        canvas.save(); canvas.translate(position[0], position[1]); pose(canvas)
        val carry = flowerCarry(time)
        canvas.translate(carry.first, carry.second)
        canvas.rotate(-720f * progress, 218f, 190f)
        canvas.drawPath(paths[1], paint); canvas.restore(); canvas.restore()
    }
    // Translate the flower with the supporting M; keep the petals undistorted.
    private fun flowerCarry(t: Float): Pair<Float, Float> {
        val times = floatArrayOf(0f, .08f, .17f, .29f, .72f, .76f, .88f, .94f, 1f)
        val x = floatArrayOf(0f, 0f, 2.76f, 0f, 0f, 1.656f, -.736f, 0f, 0f)
        val y = floatArrayOf(0f, 0f, 1.15f, 0f, 0f, 2.575f, -.276f, 0f, 0f)
        val i = (0 until times.lastIndex).firstOrNull { t <= times[it + 1] } ?: times.lastIndex - 1
        val p = ease(((t - times[i]) / (times[i + 1] - times[i])).coerceIn(0f, 1f))
        return (x[i] + (x[i + 1] - x[i]) * p) to (y[i] + (y[i + 1] - y[i]) * p)
    }
    private fun animatedCradle(t: Float): Path {
        val rest = cradleRest ?: return paths[0]
        val lifted = cradleLifted ?: return paths[0]
        val pressed = cradlePressed ?: return paths[0]
        val frame = cradleFrame ?: return paths[0]
        val times = floatArrayOf(0f, .17f, .32f, .52f, .72f, .76f, .88f, 1f)
        val poses = arrayOf(rest, rest, lifted, rest, rest, pressed, rest, rest)
        val i = (0 until times.lastIndex).firstOrNull { t <= times[it + 1] } ?: times.lastIndex - 1
        val p = ease(((t - times[i]) / (times[i + 1] - times[i])).coerceIn(0f, 1f))
        for (n in frame.indices) frame[n].interpolatePathDataNode(poses[i][n], poses[i + 1][n], p)
        cradlePath.reset()
        PathParser.PathDataNode.nodesToPath(frame, cradlePath)
        return cradlePath
    }
    private fun pose(canvas: Canvas) {
        canvas.translate(120f, 130f); canvas.rotate(-25f); canvas.scale(1.02f, 1.02f); canvas.translate(-128f, -128f)
    }
    private fun ease(t: Float) = t * t * (3f - 2f * t)
    private fun spring(t: Float): Pair<Float, Float> {
        val times = floatArrayOf(0f, .08f, .17f, .29f, .43f, .55f, .63f, .72f, .76f, .88f, .94f, 1f)
        val x = floatArrayOf(1f, 1f, 1.03f, .97f, 1.012f, .995f, 1f, 1f, 1.018f, .992f, 1f, 1f)
        val y = floatArrayOf(1f, 1f, .95f, 1.05f, .985f, 1.008f, 1f, 1f, .975f, 1.012f, 1f, 1f)
        val i = (0 until times.lastIndex).firstOrNull { t <= times[it + 1] } ?: times.lastIndex - 1
        val p = ease(((t - times[i]) / (times[i + 1] - times[i])).coerceIn(0f, 1f))
        return (x[i] + (x[i + 1] - x[i]) * p) to (y[i] + (y[i + 1] - y[i]) * p)
    }
}
