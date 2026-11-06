package com.molly.parent

import android.content.Context
import android.graphics.*
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.transformer.*
import java.io.*
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.*

object MediaPreparation {
    fun jpeg(
        context: Context,
        uri: Uri,
        max: Int,
        quality: Int,
        square: Boolean = false,
    ): ByteArray {
        val data =
            context.contentResolver.openInputStream(uri)!!.use { stream ->
                val out = ByteArrayOutputStream()
                val buffer = ByteArray(32768)
                while (out.size() <= 20 * 1024 * 1024) {
                    val n = stream.read(buffer)
                    if (n < 0) break
                    out.write(buffer, 0, n)
                }
                out.toByteArray()
            }
        require(data.size <= 20 * 1024 * 1024) { "图片不能超过 20 MB" }
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(data, 0, data.size, bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0) { "无法读取图片，请重新选择。" }
        val options =
            BitmapFactory.Options().apply {
                inSampleSize = 1
                while (
                    maxOf(bounds.outWidth, bounds.outHeight) / inSampleSize > max * 2
                ) inSampleSize *= 2
            }
        val bitmap = BitmapFactory.decodeByteArray(data, 0, data.size, options) ?: error("无法读取图片")
        val exif = ExifInterface(ByteArrayInputStream(data))
        val matrix =
            Matrix().apply {
                if (exif.isFlipped) postScale(-1f, 1f)
                postRotate(exif.rotationDegrees.toFloat())
            }
        val oriented = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        val scale =
            if (square) max.toFloat() / minOf(oriented.width, oriented.height)
            else minOf(1f, max.toFloat() / maxOf(oriented.width, oriented.height))
        val w = if (square) max else (oriented.width * scale).toInt().coerceAtLeast(1)
        val h = if (square) max else (oriented.height * scale).toInt().coerceAtLeast(1)
        val result = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
        Canvas(result).apply {
            drawColor(Color.WHITE)
            val rw = oriented.width * scale
            val rh = oriented.height * scale
            drawBitmap(
                oriented,
                null,
                RectF((w - rw) / 2, (h - rh) / 2, (w + rw) / 2, (h + rh) / 2),
                Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG),
            )
        }
        val out = ByteArrayOutputStream()
        result.compress(Bitmap.CompressFormat.JPEG, quality, out)
        result.recycle()
        if (oriented !== bitmap) oriented.recycle()
        bitmap.recycle()
        return out.toByteArray()
    }

    @androidx.annotation.OptIn(androidx.media3.common.util.UnstableApi::class)
    suspend fun mp4(context: Context, input: File, output: File) =
        withContext(Dispatchers.Main) {
            suspendCancellableCoroutine<Unit> { continuation ->
                val transformer =
                    Transformer.Builder(context)
                        .setVideoMimeType(MimeTypes.VIDEO_H264)
                        .setAudioMimeType(MimeTypes.AUDIO_AAC)
                        .addListener(
                            object : Transformer.Listener {
                                override fun onCompleted(
                                    composition: Composition,
                                    exportResult: ExportResult,
                                ) {
                                    if (continuation.isActive) continuation.resume(Unit)
                                }

                                override fun onError(
                                    composition: Composition,
                                    exportResult: ExportResult,
                                    exportException: ExportException,
                                ) {
                                    if (continuation.isActive)
                                        continuation.resumeWithException(exportException)
                                }
                            }
                        )
                        .build()
                continuation.invokeOnCancellation {
                    android.os.Handler(android.os.Looper.getMainLooper()).post {
                        transformer.cancel()
                        output.delete()
                    }
                }
                transformer.start(
                    EditedMediaItem.Builder(MediaItem.fromUri(Uri.fromFile(input))).build(),
                    output.path,
                )
            }
        }
}
