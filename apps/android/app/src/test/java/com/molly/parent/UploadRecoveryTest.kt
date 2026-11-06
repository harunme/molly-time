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
class UploadRecoveryTest {
    private val dispatcher = StandardTestDispatcher()
    private lateinit var app: ParentApplication
    private lateinit var controller: UploadController
    private lateinit var directory: File
    private lateinit var video: File
    private val calls = mutableListOf<Request>()
    private var failTransfer = false

    @Before
    fun setup() {
        Dispatchers.setMain(dispatcher)
        app = ApplicationProvider.getApplicationContext()
        val scope = "upload-test-${System.nanoTime()}"
        directory =
            File(app.noBackupFilesDir, "Uploads-v1/${digest(scope.toByteArray())}/library").apply {
                mkdirs()
            }
        video =
            File(directory, "fixture.mp4").apply { writeBytes(byteArrayOf(1, 2, 3, 4, 5, 6, 7)) }
        File(directory, "draft.json")
            .writeText(
                json(
                        "file" to video.path,
                        "filename" to "fixture.mp4",
                        "name" to "fixture",
                        "resource" to json("id" to "r"),
                        "upload" to json("id" to "u", "status" to "uploading"),
                        "autoResume" to true,
                        "allowChildren" to false,
                        "metadata" to json("runtimeMs" to 1200),
                    )
                    .toString()
            )
        val transport =
            OkHttpClient.Builder()
                .addInterceptor { chain ->
                    val request = chain.request()
                    calls.add(request)
                    val path = request.url.encodedPath
                    if (failTransfer && path.endsWith("/chunks"))
                        throw IOException("fixture offline")
                    val body =
                        when {
                            path.endsWith("/chunks") ->
                                json("id" to "u", "status" to "uploading", "offset" to 7)
                            path.endsWith("/complete") ->
                                json("id" to "u", "status" to "processing")
                            path.endsWith("/cancel") -> json("ok" to true)
                            else ->
                                json(
                                    "id" to "u",
                                    "status" to
                                        if (calls.any { it.url.encodedPath.endsWith("/complete") })
                                            "ready"
                                        else "uploading",
                                    "transport" to "local",
                                    "offset" to 3,
                                )
                        }
                    Response.Builder()
                        .request(request)
                        .protocol(Protocol.HTTP_1_1)
                        .code(200)
                        .message("fixture")
                        .body(body.toString().toResponseBody())
                        .build()
                }
                .build()
        controller = UploadController(app, io = dispatcher)
        controller.bind(
            ParentApi(Endpoint("https://fixture.example"), "fixture", {}, transport),
            scope,
        )
    }

    @After
    fun teardown() {
        controller.pause()
        directory.deleteRecursively()
        Dispatchers.resetMain()
    }

    @Test
    fun resumesAtServerOffsetAndDoesNotCreateAnotherResource() =
        runTest(dispatcher) {
            controller.run()
            advanceUntilIdle()
            assertTrue(controller.state.value!!.optBoolean("completed"))
            val chunk = calls.single { it.url.encodedPath.endsWith("/chunks") }
            assertEquals("3", chunk.url.queryParameter("offset"))
            val buffer = okio.Buffer()
            chunk.body!!.writeTo(buffer)
            assertArrayEquals(byteArrayOf(4, 5, 6, 7), buffer.readByteArray())
            assertFalse(calls.any { it.url.encodedPath == "/api/manage/resources" })
            assertTrue(video.exists())
        }

    @Test
    fun interruptedTransferKeepsDraftAndConfirmedServerUpload() =
        runTest(dispatcher) {
            failTransfer = true
            controller.run()
            advanceUntilIdle()
            assertTrue(video.exists())
            assertEquals("u", controller.state.value!!.getJSONObject("upload").getString("id"))
            assertFalse(controller.busy)
            assertFalse(controller.state.value!!.optBoolean("autoResume"))
            assertTrue(controller.state.value!!.getString("error").contains("offline"))
            assertFalse(calls.any { it.url.encodedPath.endsWith("/cancel") })
            assertTrue(File(directory, "draft.json").isFile)
        }
}
