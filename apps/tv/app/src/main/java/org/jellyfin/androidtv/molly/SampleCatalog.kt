package org.jellyfin.androidtv.molly

import android.content.Context
import org.json.JSONObject

/** Local diagnostic data only; not a family authorization or server catalog. */
data class SampleEpisode(
    val id: String,
    val title: String,
    val category: String,
    val series: String,
    val video: String,
    val subtitles: List<SampleSubtitle>,
)

data class SampleSubtitle(val path: String, val label: String, val language: String)

object SampleCatalog {
    fun load(context: Context): List<SampleEpisode> {
        val json = context.assets.open("molly/catalog.json").bufferedReader().use { it.readText() }
        val items = JSONObject(json).getJSONArray("episodes")
        return List(items.length()) { index ->
            val item = items.getJSONObject(index)
            val tracks = item.optJSONArray("subtitles")
            SampleEpisode(
                item.getString("id"), item.getString("title"), item.getString("category"),
                item.getString("series"), item.getString("video"),
                List(tracks?.length() ?: 0) { trackIndex ->
                    val track = tracks!!.getJSONObject(trackIndex)
                    SampleSubtitle(track.getString("path"), track.getString("label"), track.getString("language"))
                },
            )
        }
    }
}
