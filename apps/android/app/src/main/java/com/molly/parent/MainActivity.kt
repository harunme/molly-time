package com.molly.parent

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels

class MainActivity : ComponentActivity() {
    private val updater: UpdateViewModel by viewModels()

    override fun onResume() {
        super.onResume()
        updater.permissionReturned(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        updater.result(this, intent)
    }

    private val model: ParentViewModel by viewModels()

    override fun onStart() {
        super.onStart()
        model.foreground(true)
    }

    override fun onStop() {
        if (!isChangingConfigurations) model.foreground(false)
        super.onStop()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // Anchor sound/motion to the first visible app frame, after Android's system splash.
        if (android.os.Build.VERSION.SDK_INT >= 31) {
            splashScreen.setOnExitAnimationListener { splash ->
                splash.remove()
                model.startup.start()
            }
        } else {
            val observer = window.decorView.viewTreeObserver
            observer.addOnPreDrawListener(
                object : android.view.ViewTreeObserver.OnPreDrawListener {
                    override fun onPreDraw(): Boolean {
                        window.decorView.viewTreeObserver.removeOnPreDrawListener(this)
                        window.decorView.post { model.startup.start() }
                        return true
                    }
                }
            )
        }
        setContent { MollyTheme { ParentScreen(model, updater) } }
        updater.result(this, intent)
    }
}
