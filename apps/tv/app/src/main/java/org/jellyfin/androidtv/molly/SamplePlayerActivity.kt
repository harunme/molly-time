package org.jellyfin.androidtv.molly

import android.app.Activity
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.KeyEvent
import android.view.WindowManager
import android.widget.Toast
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView

/** Local playback probe using the fork's existing Media3 dependency, not the server player replacement. */
class SamplePlayerActivity : Activity() {
    private lateinit var episode: SampleEpisode
    private lateinit var view: PlayerView
    private var player: ExoPlayer? = null
    private var position = 0L
    private var playing = true

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val selected = runCatching { SampleCatalog.load(this) }.getOrDefault(emptyList())
            .find { it.id == intent.getStringExtra("episode_id") }
        if (selected == null) {
            Toast.makeText(this, "视频不存在", Toast.LENGTH_LONG).show()
            finish()
            return
        }
        episode = selected
        position = savedInstanceState?.getLong("position")
            ?: getSharedPreferences("molly-preview-progress", MODE_PRIVATE).getLong(episode.id, 0L)
        playing = savedInstanceState?.getBoolean("playing") ?: true
        view = PlayerView(this).apply {
            keepScreenOn = true
            setShowSubtitleButton(true)
        }
        setContentView(view)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    override fun onStart() {
        super.onStart()
        if (!::episode.isInitialized) return
        val item = MediaItem.Builder().setMediaId(episode.id)
            .setUri("asset:///molly/${episode.video}")
        val defaultTrack = episode.subtitles.indexOfFirst { it.language == "en" }.coerceAtLeast(0)
        item.setSubtitleConfigurations(episode.subtitles.mapIndexed { index, track ->
                MediaItem.SubtitleConfiguration.Builder(Uri.parse("asset:///molly/${track.path}"))
                    .setMimeType(MimeTypes.APPLICATION_SUBRIP)
                    .setLanguage(track.language).setLabel(track.label)
                    .setSelectionFlags(if (index == defaultTrack) C.SELECTION_FLAG_DEFAULT else 0).build()
        })
        player = ExoPlayer.Builder(this).build().also { p ->
            view.player = p
            p.addListener(object : Player.Listener {
                override fun onPlayerError(error: PlaybackException) {
                    Log.e("MollySamplePlayer", "Playback failed for ${episode.id}", error)
                    Toast.makeText(this@SamplePlayerActivity, "播放失败：${error.errorCodeName}", Toast.LENGTH_LONG).show()
                }
                override fun onPlaybackStateChanged(playbackState: Int) {
                    if (playbackState == Player.STATE_ENDED) {
                        position = 0L
                        getSharedPreferences("molly-preview-progress", MODE_PRIVATE).edit()
                            .putLong(episode.id, 0L).apply()
                    }
                }
            })
            p.setMediaItem(item.build())
            p.seekTo(position)
            p.prepare()
            p.playWhenReady = playing
        }
        view.requestFocus()
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val p = player
        if (p != null && event.action == KeyEvent.ACTION_DOWN) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> { p.playWhenReady = !p.playWhenReady; return true }
                KeyEvent.KEYCODE_MEDIA_PLAY -> { p.play(); return true }
                KeyEvent.KEYCODE_MEDIA_PAUSE -> { p.pause(); return true }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putLong("position", player?.currentPosition ?: position)
        outState.putBoolean("playing", player?.playWhenReady ?: playing)
        super.onSaveInstanceState(outState)
    }

    override fun onStop() {
        player?.let { p ->
            position = if (p.playbackState == Player.STATE_ENDED) 0L else p.currentPosition
            playing = p.playWhenReady
            getSharedPreferences("molly-preview-progress", MODE_PRIVATE).edit().putLong(episode.id, position).apply()
            view.player = null
            p.release()
        }
        player = null
        super.onStop()
    }
}
