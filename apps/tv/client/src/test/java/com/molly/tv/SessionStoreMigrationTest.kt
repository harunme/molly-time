package com.molly.tv

import android.app.Application
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [28])
class SessionStoreMigrationTest {
    @Test fun oldIpBindingMovesToDomainWithoutLosingDeviceCredentials() {
        val context = RuntimeEnvironment.getApplication()
        val prefs = context.getSharedPreferences("molly.shell.v1", 0)
        prefs.edit().clear().putString("server", "https://118.89.122.66:8096")
            .putString("access", "access-token").putString("refresh", "refresh-token")
            .putString("device", "device-id").commit()
        try {
            val session = SessionStore(context)
            assertEquals("https://mollytime.app", session.server)
            assertEquals("access-token", session.access)
            assertEquals("refresh-token", session.refresh)
            assertEquals("device-id", session.deviceId)
            session.connect(SessionStore.DEFAULT_SERVER)
            assertEquals("refresh-token", session.refresh)
        } finally {
            prefs.edit().clear().commit()
        }
    }

    @Test fun customServerIsNotChanged() {
        val context = RuntimeEnvironment.getApplication()
        val prefs = context.getSharedPreferences("molly.shell.v1", 0)
        prefs.edit().clear().putString("server", "https://family.example").commit()
        try {
            assertEquals("https://family.example", SessionStore(context).server)
        } finally {
            prefs.edit().clear().commit()
        }
    }
}
