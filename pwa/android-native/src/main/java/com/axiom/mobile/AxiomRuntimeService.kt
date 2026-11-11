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
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

class AxiomRuntimeService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null
    private val channelId = "axiom_runtime"
    private val monitorRunning = AtomicBoolean(false)
    @Volatile private var monitorThread: Thread? = null
    @Volatile private var gatewayUrl: String = ""
    @Volatile private var sessionToken: String = ""
    @Volatile private var monitorStatus: String = "Runtime active"

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= 26) {
            val manager = getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(channelId, "Axiom runtime", NotificationManager.IMPORTANCE_LOW))
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopMonitor()
                releaseWakeLock()
                if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_REMOVE) else stopForeground(true)
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_WAKE_LOCK -> updateWakeLock()
            ACTION_MONITOR, ACTION_START, null -> {
                updateWakeLock()
                gatewayUrl = intent?.getStringExtra(EXTRA_GATEWAY_URL)?.trimEnd('/') ?: gatewayUrl
                sessionToken = intent?.getStringExtra(EXTRA_SESSION_TOKEN) ?: sessionToken
                if (gatewayUrl.isNotBlank() && sessionToken.isNotBlank()) startMonitor()
            }
        }
        startForeground(NOTIFICATION_ID, buildNotification())
        return START_STICKY
    }

    private fun startMonitor() {
        if (gatewayUrl.isBlank() || sessionToken.isBlank()) return
        monitorThread?.interrupt()
        monitorRunning.set(true)
        monitorThread = Thread({
            while (monitorRunning.get() && !Thread.currentThread().isInterrupted) {
                monitorStatus = checkOllama()
                updateNotification()
                try {
                    Thread.sleep(MONITOR_INTERVAL_MS)
                } catch (_: InterruptedException) {
                    break
                }
            }
        }, "axiom-ollama-monitor").apply {
            isDaemon = true
            start()
        }
    }

    private fun checkOllama(): String {
        var connection: HttpURLConnection? = null
        return try {
            connection = URL("$gatewayUrl/api/ollama/api/tags").openConnection() as HttpURLConnection
            connection.requestMethod = "GET"
            connection.connectTimeout = 6000
            connection.readTimeout = 6000
            connection.setRequestProperty("Authorization", "Bearer $sessionToken")
            val status = connection.responseCode
            if (status in 200..299) "Ollama connected · background checks active"
            else if (status == 401) "Gateway session expired · open Axiom to reconnect"
            else "Ollama unavailable · retrying"
        } catch (_: Exception) {
            "Ollama unreachable · retrying"
        } finally {
            connection?.disconnect()
        }
    }

    private fun updateNotification() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification())
    }

    private fun stopMonitor() {
        monitorRunning.set(false)
        monitorThread?.interrupt()
        monitorThread = null
        gatewayUrl = ""
        sessionToken = ""
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
            .setContentText(monitorStatus)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setContentIntent(pending)
            .build()
    }

    override fun onDestroy() {
        stopMonitor()
        releaseWakeLock()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    companion object {
        const val ACTION_START = "com.axiom.mobile.RUNTIME_START"
        const val ACTION_STOP = "com.axiom.mobile.RUNTIME_STOP"
        const val ACTION_WAKE_LOCK = "com.axiom.mobile.RUNTIME_WAKE_LOCK"
        const val ACTION_MONITOR = "com.axiom.mobile.RUNTIME_MONITOR"
        const val EXTRA_GATEWAY_URL = "gateway_url"
        const val EXTRA_SESSION_TOKEN = "session_token"
        const val NOTIFICATION_ID = 8787
        private const val MONITOR_INTERVAL_MS = 30_000L
    }
}
