package com.molly.tv

import android.app.Application
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [28])
class DeviceIdentityStoreTest {
    @Test fun identitySurvivesLogoutAndNewStoreButIsScopedByServer() {
        val context = RuntimeEnvironment.getApplication()
        val session = SessionStore(context)
        val original = session.identityProof().toString()
        session.clear()
        assertEquals(original, SessionStore(context).identityProof().toString())
        assertNotEquals(original, session.identityProof("https://other.example").toString())
        assertEquals(64, session.identityProof().getString("secret").length)
        assertFalse(session.identityProof().getString("secret").contains("-"))
    }
}
