package com.molly.parent

import android.app.*
import android.content.Intent
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.combine

class UploadService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var observation: Job? = null
    private val app
        get() = application as ParentApplication

    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java)
            .createNotificationChannel(
                NotificationChannel("uploads", "视频上传", NotificationManager.IMPORTANCE_LOW)
            )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ServiceCompat.startForeground(
            this,
            71,
            notification("正在上传视频"),
            if (android.os.Build.VERSION.SDK_INT >= 29)
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            else 0,
        )
        if (app.api == null) {
            stopSelf()
            return START_NOT_STICKY
        }
        app.uploads.run()
        app.reminderUploads.run()
        observation?.cancel()
        observation =
            scope.launch {
                combine(app.uploads.state, app.reminderUploads.state) { a, b ->
                        listOfNotNull(a, b).firstOrNull { it.optBoolean("busy") }
                    }
                    .collect { draft ->
                        if (draft == null) {
                            stopSelf()
                            return@collect
                        }
                        getSystemService(NotificationManager::class.java)
                            .notify(
                                71,
                                notification(
                                    "${draft.optString("name","视频")} · ${(draft.optDouble("progress",0.0)*100).toInt()}%"
                                ),
                            )
                    }
            }
        return START_NOT_STICKY
    }

    private fun notification(text: String): Notification {
        val open =
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        return NotificationCompat.Builder(this, "uploads")
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setContentTitle("MollyTime")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    override fun onTimeout(startId: Int, fgsType: Int) {
        app.uploads.pause()
        app.reminderUploads.pause()
        stopSelf()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        fun finishIfIdle(app: ParentApplication) {
            if (!app.uploads.busy && !app.reminderUploads.busy)
                app.stopService(Intent(app, UploadService::class.java))
        }
    }
}
