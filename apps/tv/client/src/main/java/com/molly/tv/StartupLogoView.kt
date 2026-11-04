package com.molly.tv

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.provider.Settings
import android.view.View
import android.view.animation.LinearInterpolator
import androidx.core.graphics.PathParser
import kotlin.math.min

/** Native rendering of the approved paths: available before the WebView is ready. */
class StartupLogoView(context: Context, private val cycleFinished: () -> Unit) : View(context) {
    private val paths = mutableListOf<Path>()
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFF8DE7E.toInt() }
    private var budNodes: Array<PathParser.PathDataNode>? = null
    private var openNodes: Array<PathParser.PathDataNode>? = null
    private var petalNodes: Array<PathParser.PathDataNode>? = null
    private val petalPath = Path()
    private var time = 0f
    private var reported = false
    private var requested = false
    private var reducedCompletion: Runnable? = null
    private val animator = ValueAnimator.ofFloat(0f, 1.8f).apply {
        duration = 1800; interpolator = LinearInterpolator(); repeatCount = 0
        addUpdateListener { time = it.animatedValue as Float; invalidate() }
        addListener(object : AnimatorListenerAdapter() {
            override fun onAnimationEnd(animation: Animator) {
                if (requested && !reported) { reported = true; cycleFinished() }
            }
        })
    }
    init {
        setBackgroundColor(context.getColor(R.color.startup_background))
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
                        if (paths.size == 1) {
                            openNodes = PathParser.createNodesFromPathData(it)
                            budNodes = PathParser.createNodesFromPathData(it.replace("A14 14", "A17 17"))
                            petalNodes = openNodes?.let(PathParser::deepCopyNodes)
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
            time = 1.8f
            invalidate()
            // Respect disabled motion, while keeping the static logo visible
            // long enough to avoid a one-frame flash on a cached warm launch.
            reducedCompletion = Runnable {
                reducedCompletion = null
                if (!reported) { reported = true; cycleFinished() }
            }.also { postDelayed(it, 600) }
        } else { time = 0f; animator.start() }
    }
    override fun onDetachedFromWindow() { stop(); super.onDetachedFromWindow() }
    fun pause() { animator.pause(); reducedCompletion?.let(::removeCallbacks) }
    fun resume() {
        if (animator.isPaused) animator.resume()
        reducedCompletion?.let { removeCallbacks(it); postDelayed(it, 600) }
    }
    fun stop() { requested = false; animator.cancel(); reducedCompletion?.let(::removeCallbacks); reducedCompletion = null }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        if (paths.size != 2) return
        val size = min(width, height) * .27f
        canvas.save()
        canvas.translate(width / 2f, height / 2f)
        canvas.scale(size / 352f, size / 352f)
        canvas.translate(-128f, -128f)
        // One progress value keeps the M, rotation, growth and petals in sync.
        val progress = ease(((time - .3f) / 1.5f).coerceIn(0f, 1f))
        pose(canvas, progress)
        paint.alpha = (255 * ease((time / .3f).coerceIn(0f, 1f))).toInt()
        val markScale = .88f + .12f * progress
        canvas.save()
        canvas.scale(markScale, markScale, 126f, 213f)
        canvas.drawPath(paths[0], paint)
        canvas.restore()
        val bloom = .12f + .88f * progress
        canvas.rotate(-24f * (1f - progress), 211f, 188f)
        canvas.scale(bloom, bloom, 211f, 188f)
        canvas.drawPath(openingFlower(progress), paint)
        canvas.restore()
    }
    private fun openingFlower(progress: Float): Path {
        val bud = budNodes ?: return paths[1]
        val open = openNodes ?: return paths[1]
        val frame = petalNodes ?: return paths[1]
        for (i in frame.indices) frame[i].interpolatePathDataNode(bud[i], open[i], progress)
        petalPath.reset()
        PathParser.PathDataNode.nodesToPath(frame, petalPath)
        return petalPath
    }
    private fun pose(canvas: Canvas, unfold: Float) {
        canvas.translate(120f, 130f); canvas.rotate(-25f * (1f - unfold)); canvas.scale(1.02f, 1.02f); canvas.translate(-128f, -128f)
    }
    private fun ease(t: Float) = t * t * (3f - 2f * t)
}
