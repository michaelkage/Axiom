package com.axiom.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

class AxiomRuntimeService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private val channelId = "axiom_runtime"

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= 26) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(channelId, "Axiom runtime", NotificationManager.IMPORTANCE_LOW))
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { releaseWakeLock(); if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else stopForeground(true); stopSelf(); return START_NOT_STICKY }
            ACTION_WAKE_LOCK -> updateWakeLock()
            ACTION_START, null -> updateWakeLock()
        }
        startForeground(NOTIFICATION_ID, buildNotification())
        return START_STICKY
    }

    private fun updateWakeLock() {
        val enabled = getSharedPreferences("axiom_runtime", 0).getBoolean("keep_awake", false)
        if (enabled && (wakeLock == null || wakeLock?.isHeld != true)) {
            val manager = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Axiom:Runtime").apply {
                setReferenceCounted(false)
                acquire()
            }
        } else if (!enabled) releaseWakeLock()
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    private fun buildNotification(): Notification {
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val pending = launch?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE) }
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, channelId) else Notification.Builder(this)
        return builder.setContentTitle("Axiom runtime active")
            .setContentText("Local shell sessions are available. Tap to return to Axiom.")
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setContentIntent(pending)
            .build()
    }

    override fun onDestroy() {
        releaseWakeLock()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_START = "com.axiom.mobile.RUNTIME_START"
        const val ACTION_STOP = "com.axiom.mobile.RUNTIME_STOP"
        const val ACTION_WAKE_LOCK = "com.axiom.mobile.RUNTIME_WAKE_LOCK"
        const val NOTIFICATION_ID = 8787
    }
}
