package com.molly.parent

import android.content.Intent
import android.content.pm.PackageInstaller
import androidx.test.core.app.ApplicationProvider
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.*
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.*
import org.junit.Assert.*
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ClientUpdatesTest {
    private val app
        get() = ApplicationProvider.getApplicationContext<ParentApplication>()

    private val data = "verified parent apk fixture".toByteArray()

    private fun release() =
        ClientUpdates.Release(
            app.packageName,
            BuildConfig.VERSION_CODE + 1L,
            "next",
            26,
            data.size.toLong(),
            digest(data),
            "update",
            "https://fixture.example/update.apk",
        )

    private fun transport(block: (Request) -> Response) =
        OkHttpClient.Builder().addInterceptor { block(it.request()) }.build()

    private fun response(request: Request, body: ByteArray, code: Int = 200) =
        Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message("fixture")
            .body(body.toResponseBody())
            .build()

    @Test
    fun discoveryIsPackageSpecificAndCarriesNoLoginCredentials() {
        val client =
            ClientUpdates(
                app,
                transport { r ->
                    assertEquals(app.packageName, r.url.queryParameter("packageName"))
                    assertNull(r.header("Cookie"))
                    assertNull(r.header("Authorization"))
                    assertNull(r.header("X-CSRF-Token"))
                    response(r, json("release" to release().json()).toString().toByteArray())
                },
            )
        assertEquals(release(), client.check("https://fixture.example"))
    }

    @Test
    fun staleVersionAndOlderServerProduceNoPrompt() {
        val client =
            ClientUpdates(
                app,
                transport { r ->
                    response(
                        r,
                        json(
                                "release" to
                                    release()
                                        .copy(versionCode = BuildConfig.VERSION_CODE.toLong())
                                        .json()
                            )
                            .toString()
                            .toByteArray(),
                    )
                },
            )
        assertNull(client.check("https://fixture.example"))
        val old = ClientUpdates(app, transport { r -> response(r, byteArrayOf(), 404) })
        assertNull(old.check("https://fixture.example"))
    }

    @Test
    fun unsafeChannelsUrlsAndOversizedMetadataAreRejected() {
        for (value in
            listOf(
                release().copy(packageName = "com.molly.tv"),
                release().copy(url = "http://fixture.example/apk"),
                release().copy(url = "https://user:password@fixture.example/apk"),
                release().copy(size = UpdatePolicy.MAX_APK_BYTES + 1),
            )) {
            val client =
                ClientUpdates(
                    app,
                    transport { r ->
                        response(r, json("release" to value.json()).toString().toByteArray())
                    },
                )
            assertThrows(IllegalArgumentException::class.java) {
                client.check("https://fixture.example")
            }
        }
        val large = ClientUpdates(app, transport { r -> response(r, ByteArray(32769) { 32 }) })
        assertThrows(IllegalArgumentException::class.java) {
            large.check("https://fixture.example")
        }
    }

    @Test
    fun verifiedDownloadIsReusedAndCorruptionIsRefetched() {
        val count = AtomicInteger()
        val client =
            ClientUpdates(
                app,
                transport { r ->
                    count.incrementAndGet()
                    assertNull(r.header("Cookie"))
                    response(r, data)
                },
            )
        val value = release()
        val file = client.download(value, ClientUpdates.Operation()) {}
        try {
            assertArrayEquals(data, file.readBytes())
            client.download(value, ClientUpdates.Operation()) {}
            assertEquals(1, count.get())
            file.writeBytes(ByteArray(data.size) { 9 })
            client.download(value, ClientUpdates.Operation()) {}
            assertEquals(2, count.get())
            assertArrayEquals(data, file.readBytes())
        } finally {
            file.delete()
        }
    }

    @Test
    fun incompleteDownloadAndCancellationNeverLeaveInstallableFile() {
        val value = release().copy(sha256 = "a".repeat(64))
        val client = ClientUpdates(app, transport { r -> response(r, data.copyOfRange(0, 2)) })
        assertThrows(IllegalArgumentException::class.java) {
            client.download(value, ClientUpdates.Operation()) {}
        }
        val cancelled = ClientUpdates.Operation().apply { cancel() }
        assertThrows(IllegalStateException::class.java) { client.download(value, cancelled) {} }
        assertFalse(java.io.File(app.filesDir, "client-updates/${value.sha256}.apk").exists())
    }

    @Test
    fun installerCallbacksRequireMatchingNonceAndSession() {
        val activity =
            Robolectric.buildActivity(androidx.activity.ComponentActivity::class.java).setup().get()
        val model = UpdateViewModel(app)
        val prefs = app.getSharedPreferences("molly.updates", 0)
        prefs.edit().putInt("session", 42).putString("nonce", "private-test-nonce").commit()
        val intent =
            Intent(ClientUpdateInstaller.INSTALL_RESULT)
                .putExtra(PackageInstaller.EXTRA_SESSION_ID, 42)
                .putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE_ABORTED)
                .putExtra("nonce", "forged")
        model.result(activity, intent)
        assertFalse(model.visible)
        intent
            .putExtra("nonce", "private-test-nonce")
            .putExtra(PackageInstaller.EXTRA_SESSION_ID, 43)
        model.result(activity, intent)
        assertFalse(model.visible)
        intent.putExtra(PackageInstaller.EXTRA_SESSION_ID, 42)
        model.result(activity, intent)
        assertTrue(model.visible)
        assertTrue(model.message.contains("尚未安装"))
        assertFalse(prefs.contains("nonce"))
    }

    @Test
    fun approvedInstallRemainsBusyAndCannotBeReplacedByAnotherInstallOrCheck() {
        val client = ClientUpdates(app, transport { r ->
            response(r, if (r.url.encodedPath.endsWith(".apk")) data
                else json("release" to release().json()).toString().toByteArray())
        })
        val activity = Robolectric.buildActivity(androidx.activity.ComponentActivity::class.java).setup().get()
        val prefs = app.getSharedPreferences("molly.updates", 0)
        val model = UpdateViewModel(app, client)
        fun finishWork() {
            client.executor.submit {}.get(3, java.util.concurrent.TimeUnit.SECONDS)
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
        }
        try {
            model.check("https://fixture.example", true)
            finishWork()
            model.download()
            finishWork()
            assertEquals("ready", model.stage)
            prefs.edit().putInt("session", 42).putString("nonce", "test-nonce").commit()
            val confirmation = Intent("fixture.CONFIRM_INSTALL")
            model.result(activity, Intent(ClientUpdateInstaller.INSTALL_RESULT)
                .putExtra(PackageInstaller.EXTRA_SESSION_ID, 42)
                .putExtra("nonce", "test-nonce")
                .putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_PENDING_USER_ACTION)
                .putExtra(Intent.EXTRA_INTENT, confirmation))
            assertEquals(confirmation.action, org.robolectric.Shadows.shadowOf(activity).nextStartedActivity.action)
            assertEquals("awaiting", model.stage)
            assertTrue(model.busy)

            // Returning from Android's confirmation is not a failed installation.
            model.install(activity)
            model.check("https://fixture.example", true)
            finishWork()
            assertEquals("awaiting", model.stage)
            assertEquals(42, prefs.getInt("session", -1))
            assertNull(org.robolectric.Shadows.shadowOf(activity).nextStartedActivity)

            model.result(activity, Intent(ClientUpdateInstaller.INSTALL_RESULT)
                .putExtra(PackageInstaller.EXTRA_SESSION_ID, 42)
                .putExtra("nonce", "test-nonce")
                .putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE_ABORTED))
            assertEquals("ready", model.stage)
            assertFalse(model.busy)
        } finally {
            client.executor.shutdownNow()
        }
    }

    @Test
    fun installerFailureIncludesSystemReasonAndReleasesTheSession() {
        val activity = Robolectric.buildActivity(androidx.activity.ComponentActivity::class.java).setup().get()
        val model = UpdateViewModel(app)
        val prefs = app.getSharedPreferences("molly.updates", 0)
        prefs.edit().putInt("session", 42).putString("nonce", "test-nonce").commit()
        model.result(activity, Intent(ClientUpdateInstaller.INSTALL_RESULT)
            .putExtra(PackageInstaller.EXTRA_SESSION_ID, 42)
            .putExtra("nonce", "test-nonce")
            .putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE_CONFLICT)
            .putExtra(PackageInstaller.EXTRA_STATUS_MESSAGE, "INSTALL_FAILED_UPDATE_INCOMPATIBLE\n signatures differ"))
        assertTrue(model.message.contains("INSTALL_FAILED_UPDATE_INCOMPATIBLE signatures differ"))
        assertFalse(model.busy)
        assertFalse(prefs.contains("session"))
    }

    @Test
    fun activityRecreationDoesNotReplayConsumedInstallConfirmation() {
        val prefs = app.getSharedPreferences("molly.updates", 0)
        prefs.edit().putInt("session", 42).putString("nonce", "test-nonce").commit()
        val callback = Intent(app, androidx.activity.ComponentActivity::class.java)
            .setAction(ClientUpdateInstaller.INSTALL_RESULT)
            .putExtra(PackageInstaller.EXTRA_SESSION_ID, 42)
            .putExtra("nonce", "test-nonce")
            .putExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_PENDING_USER_ACTION)
            .putExtra(Intent.EXTRA_INTENT, Intent("fixture.CONFIRM_INSTALL"))
        val model = UpdateViewModel(app)
        val controller = Robolectric.buildActivity(androidx.activity.ComponentActivity::class.java, callback).setup()
        try {
            model.result(controller.get(), controller.get().intent)
            assertEquals("fixture.CONFIRM_INSTALL", org.robolectric.Shadows.shadowOf(controller.get()).nextStartedActivity.action)
            assertNotEquals(ClientUpdateInstaller.INSTALL_RESULT, controller.get().intent.action)
            controller.recreate()
            model.result(controller.get(), controller.get().intent)
            assertNull(org.robolectric.Shadows.shadowOf(controller.get()).nextStartedActivity)
        } finally {
            controller.pause().stop().destroy()
        }
    }

    @Test
    fun dismissedCheckCannotReopenDialogWhenItsResponseArrives() {
        val entered = java.util.concurrent.CountDownLatch(1)
        val proceed = java.util.concurrent.CountDownLatch(1)
        val client =
            ClientUpdates(
                app,
                transport { r ->
                    entered.countDown()
                    check(proceed.await(3, java.util.concurrent.TimeUnit.SECONDS))
                    response(r, json("release" to release().json()).toString().toByteArray())
                },
            )
        try {
            val model = UpdateViewModel(app, client)
            model.check("https://fixture.example", true)
            assertTrue(entered.await(3, java.util.concurrent.TimeUnit.SECONDS))
            model.dismiss()
            assertFalse(model.visible)
            proceed.countDown()
            client.executor.submit {}.get(3, java.util.concurrent.TimeUnit.SECONDS)
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
            assertFalse(model.visible)
            assertNull(model.release)
        } finally {
            proceed.countDown()
            client.executor.shutdownNow()
        }
    }
}
