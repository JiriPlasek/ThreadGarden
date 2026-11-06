package dev.threadgarden.spike

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder

/** THROWAWAY spike: the foreground service that keeps the Rust core alive without the screens. */
class CoreService : Service() {
  companion object {
    private const val KEEP = "keep"
    private const val ALERTS = "alerts"
    private var instance: CoreService? = null
    private var nextId = 100

    init { System.loadLibrary("app_lib") }

    @JvmStatic external fun startCore(dataDir: String)
    @JvmStatic external fun networkChanged()

    @JvmStatic fun postAlert(title: String, body: String) {
      val s = instance ?: return
      s.getSystemService(NotificationManager::class.java)
        .notify(nextId++, s.build(ALERTS, title, body).build())
    }

    @JvmStatic fun postStatus(title: String, body: String) {
      val s = instance ?: return
      s.getSystemService(NotificationManager::class.java)
        .notify(1, s.build(KEEP, title, body).setOngoing(true).build())
    }
  }

  private fun build(channel: String, title: String, body: String): Notification.Builder {
    val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
    return Notification.Builder(this, channel)
      .setContentTitle(title).setContentText(body)
      .setSmallIcon(android.R.drawable.stat_notify_sync).setContentIntent(open)
      .setAutoCancel(channel == ALERTS)
  }

  override fun onCreate() {
    super.onCreate()
    instance = this
    val nm = getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(NotificationChannel(KEEP, "Connection", NotificationManager.IMPORTANCE_LOW))
    nm.createNotificationChannel(NotificationChannel(ALERTS, "Alerts", NotificationManager.IMPORTANCE_HIGH))
    val n = build(KEEP, "Connected to your machines", "Starting").setOngoing(true).build()
    if (Build.VERSION.SDK_INT >= 34) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    else startForeground(1, n)
    startCore(filesDir.absolutePath)
    getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) { networkChanged() }
    })
  }

  // Restart it if Android kills it.
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_STICKY
  override fun onBind(intent: Intent?): IBinder? = null
}
