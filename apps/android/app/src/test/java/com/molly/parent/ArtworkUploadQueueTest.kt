package com.molly.parent

import androidx.test.core.app.ApplicationProvider
import java.io.File
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import okhttp3.*
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class ArtworkUploadQueueTest {
    private val dispatcher = StandardTestDispatcher()
    private lateinit var root: File
    private val queues = mutableListOf<ArtworkUploadQueue>()

    @Before fun setup() {
        Dispatchers.setMain(dispatcher)
        val app = ApplicationProvider.getApplicationContext<ParentApplication>()
        root = File(app.noBackupFilesDir, "artwork-test-${System.nanoTime()}").apply { mkdirs() }
    }
    @After fun cleanup() { queues.forEach { it.close() }; root.deleteRecursively(); Dispatchers.resetMain() }
    private fun api(account: String = "alice", handler: (Request) -> String): ParentApi {
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1)
                .code(200).message("fixture").body(handler(chain.request()).toResponseBody()).build()
        }.build()
        return ParentApi(Endpoint("https://fixture.example"), transport = client).also {
            it.diskRoot = root; it.accountScope = "https://fixture.example|$account"
        }
    }
    private fun queue(api: ParentApi) = ArtworkUploadQueue(api, dispatcher).also { queues.add(it) }

    @Test fun localPreviewSurvivesRestartAndLostAcknowledgementWithoutResendingBytes() = runTest(dispatcher) {
        var creates = 0; var chunks = 0; var offset = 0
        fun upload(status: String) = json("id" to "u", "status" to status, "offset" to offset,
            "transport" to "local", "partSize" to 4194304).toString()
        val api = api { request ->
            when (request.url.encodedPath) {
                "/api/manage/uploads" -> { creates++; upload("uploading") }
                "/api/manage/uploads/u/chunks" -> { chunks++; offset = 3; throw IOException("acknowledgement lost") }
                "/api/manage/uploads/u" -> upload("uploading")
                "/api/manage/uploads/u/complete" -> upload("ready")
                "/api/manage/resources/e" -> json("imageUrl" to "/image?v=new").toString()
                else -> error("Unexpected request: ${request.url}")
            }
        }
        val first = queue(api)
        first.enqueue(byteArrayOf(1, 2, 3), "e")
        assertArrayEquals(byteArrayOf(1, 2, 3), first.drafts["e"]!!.data)
        runCurrent() // First chunk was accepted; the queue is now waiting to retry.
        assertEquals(1, chunks)
        first.close()
        // Android 8/9 AtomicFile can leave only the backup after process death.
        val saved = root.walkTopDown().first { it.extension == "json" }
        assertTrue(saved.renameTo(File(saved.path + ".bak")))
        val other = queue(api("bob") { error("Wrong account must not send anything") })
        other.resume(); advanceUntilIdle(); assertTrue(other.drafts.isEmpty())
        val restored = queue(api)
        restored.resume(); advanceUntilIdle()
        assertEquals("/image?v=new", restored.drafts["e"]?.savedURL)
        assertEquals(1, creates); assertEquals(1, chunks)
        restored.acknowledge("e", "/image?v=old"); assertNotNull(restored.drafts["e"])
        restored.acknowledge("e", "/image?v=new"); advanceUntilIdle(); assertTrue(restored.drafts.isEmpty())
        val finished = queue(api); finished.resume(); advanceUntilIdle(); assertTrue(finished.drafts.isEmpty())
    }

    @Test fun acceptedProcessingJobIsPolledWithoutUploadOrCancellation() = runTest(dispatcher) {
        var reads = 0
        val api = api { request ->
            assertEquals("GET", request.method)
            assertEquals("/api/manage/uploads/u", request.url.encodedPath)
            reads++
            json("id" to "u", "status" to if (reads == 1) "processing" else "ready").toString()
        }
        sendArtwork(api, byteArrayOf(1), "e", json("id" to "u"), dispatcher)
        assertEquals(2, reads)
    }

    @Test fun retrySkipsAcceptedOssParts() = runTest(dispatcher) {
        val paths = mutableListOf<String>()
        val api = api { request ->
            paths.add(request.url.encodedPath)
            when {
                request.url.encodedPath.endsWith("/parts") -> "{\"parts\":[{\"number\":1,\"size\":3}]}"
                request.url.encodedPath.endsWith("/complete") -> json("id" to "u", "status" to "ready").toString()
                else -> json("id" to "u", "status" to "uploading", "transport" to "oss", "partSize" to 4).toString()
            }
        }
        sendArtwork(api, byteArrayOf(1, 2, 3), "e", json("id" to "u"), dispatcher)
        assertEquals(listOf("/api/manage/uploads/u", "/api/manage/uploads/u/parts", "/api/manage/uploads/u/complete"), paths)
    }
}
