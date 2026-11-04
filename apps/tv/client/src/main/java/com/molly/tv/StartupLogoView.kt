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
    private var markRest: Array<PathParser.PathDataNode>? = null
    private var markFrame: Array<PathParser.PathDataNode>? = null
    private val markPath = Path()
    private var budNodes: Array<PathParser.PathDataNode>? = null
    private var openNodes: Array<PathParser.PathDataNode>? = null
    private var petalNodes: Array<PathParser.PathDataNode>? = null
    private val petalPath = Path()
    private val leftWaveTimes = floatArrayOf(.89f, .99f, 1.10f, 1.22f, 1.34f, 1.46f)
    private val leftWaveValues = floatArrayOf(0f, 1.22f, .92f, 1.14f, .99f, 1f)
    private val rightWaveTimes = floatArrayOf(.97f, 1.10f, 1.22f, 1.34f, 1.46f)
    private val rightWaveValues = floatArrayOf(0f, 1.18f, .96f, 1.025f, 1f)
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
                        if (paths.isEmpty()) {
                            markRest = PathParser.createNodesFromPathData(it)
                            markFrame = markRest?.let(PathParser::deepCopyNodes)
                        }
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
        // Three decaying crests travel left, right, left; preserve each arch's tangents.
        val turn = easeOut(((time - .24f) / .36f).coerceIn(0f, 1f))
        val leftUnfold = waveUnfold(time, leftWaveTimes, leftWaveValues)
        val rightUnfold = waveUnfold(time, rightWaveTimes, rightWaveValues)
        val bloomProgress = easeOut(((time - .3f) / .82f).coerceIn(0f, 1f))
        pose(canvas, turn)
        paint.alpha = (255 * ease((time / .3f).coerceIn(0f, 1f))).toInt()
        canvas.drawPath(openingMark(leftUnfold, rightUnfold), paint)
        canvas.translate(0f, 12f * (1f - rightUnfold))
        val bloom = .12f + .88f * bloomProgress
        canvas.rotate(-24f * (1f - bloomProgress), 211f, 188f)
        canvas.scale(bloom, bloom, 211f, 188f)
        canvas.drawPath(openingFlower(bloomProgress), paint)
        canvas.restore()
    }
    private fun openingMark(left: Float, right: Float): Path {
        val rest = markRest ?: return paths[0]
        val frame = markFrame ?: return paths[0]
        var x = 0f
        fun fold(x: Float, y: Float): Float = when {
            y <= 110f -> {
                // Flat crest handles move together; only the central valley blends phases.
                val weight = ease(((x - 110f) / 32f).coerceIn(0f, 1f))
                24f * ((1f - left) * (1f - weight) + (1f - right) * weight)
            }
            x >= 183f && y <= 175f -> 12f * (1f - right)
            else -> 0f
        }
        for (n in frame.indices) {
            val source = rest[n].params
            val target = frame[n].params
            when (rest[n].type) {
                'V' -> target[0] = source[0] + fold(x, source[0])
                'M', 'C' -> {
                    for (i in source.indices step 2) {
                        target[i] = source[i]
                        target[i + 1] = source[i + 1] + fold(source[i], source[i + 1])
                    }
                    x = source[source.size - 2]
                }
            }
        }
        markPath.reset()
        PathParser.PathDataNode.nodesToPath(frame, markPath)
        return markPath
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
    private fun waveUnfold(seconds: Float, times: FloatArray, values: FloatArray): Float {
        if (seconds <= times.first()) return values.first()
        for (i in 0 until times.lastIndex) {
            if (seconds <= times[i + 1]) {
                val t = ((seconds - times[i]) / (times[i + 1] - times[i])).coerceIn(0f, 1f)
                val progress = if (i == 0) easeOut(t) else ease(t)
                return values[i] + (values[i + 1] - values[i]) * progress
            }
        }
        return values.last()
    }
    private fun easeOut(t: Float) = 1f - (1f - t) * (1f - t) * (1f - t)
    private fun ease(t: Float) = t * t * (3f - 2f * t)
}
