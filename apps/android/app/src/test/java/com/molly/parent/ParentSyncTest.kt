package com.molly.parent

import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import okhttp3.*
import okhttp3.ResponseBody.Companion.toResponseBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class ParentSyncTest {
    private val dispatcher = StandardTestDispatcher()
    private lateinit var app: ParentApplication
    private lateinit var api: ParentApi
    private lateinit var model: ParentViewModel
    private val calls = mutableListOf<String>()
    private var storageCalls = 0
    private var conflictWrites = false
    private val requests = mutableListOf<Request>()
    private var invalidateDuringStorage = false

    @Before
    fun setup() {
        Dispatchers.setMain(dispatcher)
        app = ApplicationProvider.getApplicationContext()
        api =
            ParentApi(
                Endpoint("https://fixture.example"),
                "test-cookie",
                {},
                OkHttpClient.Builder()
                    .addInterceptor { chain ->
                        val request = chain.request()
                        val path = request.url.encodedPath
                        calls.add(path)
                        requests.add(request)
                        val body: String =
                            when (path) {
                                "/api/manage/settings" -> {
                                    storageCalls++
                                    if (invalidateDuringStorage) {
                                        invalidateDuringStorage = false
                                        api.onMutation?.invoke(ParentInvalidation(storage = true))
                                    }
                                    json(
                                            "storage" to
                                                json(
                                                    "usedBytes" to storageCalls,
                                                    "reservedBytes" to 0,
                                                    "limitBytes" to 100,
                                                )
                                        )
                                        .toString()
                                }
                                "/api/manage/devices" -> {
                                    val page = request.url.queryParameter("page")!!.toInt()
                                    json(
                                            "items" to
                                                JSONArray()
                                                    .put(
                                                        json("id" to "d$page", "name" to "TV $page")
                                                    ),
                                            "page" to page,
                                            "pageSize" to 1,
                                            "total" to 2,
                                        )
                                        .toString()
                                }
                                "/api/manage/watch-control" ->
                                    json(
                                            "pinSet" to true,
                                            "devices" to
                                                JSONArray()
                                                    .put(
                                                        json(
                                                            "deviceId" to "d1",
                                                            "name" to "TV 1",
                                                            "version" to 1,
                                                        )
                                                    ),
                                        )
                                        .toString()
                                "/api/manage/reminders/devices" -> "[]"
                                "/api/manage/overview" ->
                                    json(
                                            "watch" to
                                                json(
                                                    "days" to JSONArray(),
                                                    "summaryUpdating" to false,
                                                )
                                        )
                                        .toString()
                                "/api/manage/resources" ->
                                    json(
                                            "items" to
                                                JSONArray()
                                                    .put(
                                                        json(
                                                            "id" to
                                                                (request.url.queryParameter(
                                                                    "parentId"
                                                                ) ?: "folder"),
                                                            "name" to "fixture",
                                                            "type" to "Series",
                                                        )
                                                    ),
                                            "page" to 1,
                                            "pageSize" to 30,
                                            "total" to 1,
                                        )
                                        .toString()
                                else ->
                                    if (path.startsWith("/api/manage/resources/"))
                                        json(
                                                "id" to "child",
                                                "name" to "child updated",
                                                "type" to "Series",
                                            )
                                            .toString()
                                    else "{}"
                            }
                        Response.Builder()
                            .request(request)
                            .protocol(Protocol.HTTP_1_1)
                            .code(if (conflictWrites && request.method != "GET") 409 else 200)
                            .message("fixture")
                            .body(
                                (if (conflictWrites && request.method != "GET")
                                        "{\"detail\":\"fixture conflict\"}"
                                    else body)
                                    .toResponseBody()
                            )
                            .build()
                    }
                    .build(),
            )
        ParentApplication::class
            .java
            .getDeclaredField("api")
            .apply { isAccessible = true }
            .set(app, api)
        ParentApplication::class
            .java
            .getDeclaredField("session")
            .apply { isAccessible = true }
            .set(app, json("user" to json("id" to "u", "role" to "admin")))
        model = ParentViewModel(app, dispatcher) { dispatcher.scheduler.currentTime }
        model.startup.stop()
    }

    @After
    fun teardown() {
        model.foreground(false)
        Dispatchers.resetMain()
    }

    @Test
    fun pollingMatchesIOSAndStopsWhenBackgrounded() =
        runTest(dispatcher) {
            try {
                model.foreground(true)
                runCurrent()
                assertEquals(1, storageCalls)
                model.tab = 1
                model.ensureTab()
                runCurrent()
                assertEquals(2, model.devices.size)
                val controls = calls.count { it == "/api/manage/watch-control" }
                advanceTimeBy(5_000)
                runCurrent()
                assertEquals(controls + 1, calls.count { it == "/api/manage/watch-control" })
                advanceTimeBy(55_000)
                runCurrent()
                assertEquals(2, storageCalls)
                model.foreground(false)
                val previous = calls.size
                advanceTimeBy(120_000)
                runCurrent()
                assertEquals(previous, calls.size)
                model.foreground(true)
                runCurrent()
                assertEquals(3, storageCalls)
                model.foreground(false)
            } finally {
                model.foreground(false)
            }
        }

    @Test
    fun returningToFolderReusesSnapshotWithoutLoadingFlash() =
        runTest(dispatcher) {
            try {
                model.loadLibrary()
                runCurrent()
                val root = model.resources
                model.openFolder(json("id" to "child", "name" to "child"))
                runCurrent()
                assertEquals("child", model.resources.first().getString("id"))
                assertTrue(model.back())
                assertEquals(root, model.resources)
                assertFalse(model.libraryBusy)
                runCurrent()
                assertEquals(2, calls.count { it == "/api/manage/resources" })
            } finally {
                model.foreground(false)
            }
        }

    @Test
    fun storageInvalidationDuringFlightDiscardsOlderValue() =
        runTest(dispatcher) {
            try {
                invalidateDuringStorage = true
                model.loadStorage()
                runCurrent()
                assertEquals(2, storageCalls)
                assertEquals(2, model.settings!!.getJSONObject("storage").getInt("usedBytes"))
                model.loadStorage()
                runCurrent()
                assertEquals(2, storageCalls)
            } finally {
                model.foreground(false)
            }
        }

    @Test
    fun mutationUpdatesStorageAndLibraryWithoutButtons() =
        runTest(dispatcher) {
            try {
                model.foreground(true)
                model.loadLibrary()
                runCurrent()
                val before = calls.count { it == "/api/manage/resources" }
                api.request("/api/manage/resources/fixture/publish", "POST")
                runCurrent()
                assertEquals(before + 1, calls.count { it == "/api/manage/resources" })
                assertEquals(2, storageCalls)
                model.foreground(false)
            } finally {
                model.foreground(false)
            }
        }

    @Test
    fun resourceConflictDoesNotRebaseWatchSettings() =
        runTest(dispatcher) {
            conflictWrites = true
            model.mutate("/api/manage/resources/fixture/publish")
            runCurrent()
            assertEquals("fixture conflict", model.notice)
            assertEquals(0, model.watchConflictRevision)
            assertFalse(calls.contains("/api/manage/devices"))
            model.watchCommand(json("deviceId" to "d1", "version" to 1), "add")
            runCurrent()
            assertTrue(model.watchConflictRevision > 0)
            assertTrue(calls.contains("/api/manage/devices"))
        }

    @Test
    fun sortingSendsOneNeighborAnchorAndDefersReloadDuringEditing() =
        runTest(dispatcher) {
            val field =
                ParentViewModel::class.java.getDeclaredField("resources\$delegate").apply {
                    isAccessible = true
                }
            @Suppress("UNCHECKED_CAST")
            val state = field.get(model) as androidx.compose.runtime.MutableState<List<JSONObject>>
            state.value = listOf("a", "b", "c").map { json("id" to it, "name" to it) }
            model.foreground(true)
            runCurrent()
            val before = calls.count { it == "/api/manage/resources" }
            model.updateReordering(true)
            model.reorder(0, 2)
            runCurrent()
            assertEquals(listOf("b", "c", "a"), model.resources.map { it.getString("id") })
            val request = requests.single { it.url.encodedPath.endsWith("/position") }
            assertEquals("PUT", request.method)
            val buffer = okio.Buffer()
            request.body!!.writeTo(buffer)
            val body = JSONObject(buffer.readUtf8())
            assertEquals(1, body.length())
            assertEquals("c", body.getString("afterId"))
            assertEquals(before, calls.count { it == "/api/manage/resources" })
            model.updateReordering(false)
            runCurrent()
            assertEquals(before + 1, calls.count { it == "/api/manage/resources" })
            model.foreground(false)
        }

    @Test
    fun onlyActualMutationsInvalidateSharedState() {
        assertEquals(
            ParentInvalidation(),
            ParentInvalidation.forRequest("/api/manage/resources", "GET"),
        )
        assertEquals(
            ParentInvalidation(),
            ParentInvalidation.forRequest("/api/manage/uploads/u/chunks", "PUT"),
        )
        assertTrue(ParentInvalidation.forRequest("/api/manage/uploads/u/complete", "POST").storage)
        assertTrue(ParentInvalidation.forRequest("/api/manage/trash/r/restore", "POST").library)
        assertTrue(ParentInvalidation.forRequest("/api/manage/pairing/confirm", "POST").devices)
    }
}
