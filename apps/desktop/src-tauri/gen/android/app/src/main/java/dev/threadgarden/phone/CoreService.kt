package dev.threadgarden.phone

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock

/**
 * The foreground service that keeps the core running without the screens
 * (`specialUse`, proven on the owner's phone by the spike), with the permanent
 * notification. The core lives in the process, not here: stopping the service
 * (Disconnect) leaves it serving the screens.
 */
class CoreService : Service() {
  companion object {
    const val ACTION_CONNECT = "dev.threadgarden.phone.CONNECT"
    const val ACTION_DISCONNECT = "dev.threadgarden.phone.DISCONNECT"
    const val KEEP = "connection"
    const val ALERTS = "alerts"
    private const val STATUS_ID = 1
    const val ALERT_ID = 2
    /** At most one network change passed on per this long: Android sends bursts of them. */
    private const val NETWORK_DEBOUNCE_MS = 3_000L

    @Volatile private var instance: CoreService? = null

    fun channels(c: Context) {
      val nm = c.getSystemService(NotificationManager::class.java)
      nm.createNotificationChannel(NotificationChannel(KEEP, "Connection", NotificationManager.IMPORTANCE_LOW))
      nm.createNotificationChannel(NotificationChannel(ALERTS, "Alerts", NotificationManager.IMPORTANCE_HIGH))
    }

    fun start(c: Context, action: String?) {
      c.startForegroundService(Intent(c, CoreService::class.java).setAction(action))
    }

    fun postStatus(text: String) {
      val s = instance ?: return
      s.getSystemService(NotificationManager::class.java).notify(STATUS_ID, s.status(text))
    }
  }

  private val main = Handler(Looper.getMainLooper())
  private var network: ConnectivityManager.NetworkCallback? = null
  private var current: Network? = null
  private var lastChange = 0L
  private val passChange = Runnable {
    lastChange = SystemClock.elapsedRealtime()
    CoreBridge.networkChanged()
  }

  override fun onCreate() {
    super.onCreate()
    instance = this
    CoreBridge.ensureStarted(this)
    watchNetwork()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_DISCONNECT) {
      CoreBridge.disconnect()
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }
    // Every startForegroundService needs its startForeground.
    val n = status(CoreBridge.statusText())
    if (Build.VERSION.SDK_INT >= 34) startForeground(STATUS_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    else startForeground(STATUS_ID, n)
    if (intent?.action == ACTION_CONNECT) CoreBridge.connect()
    // Killed by Android: started again (with no intent; the core keeps its own Disconnect).
    return START_STICKY
  }

  override fun onDestroy() {
    network?.let { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) }
    network = null
    main.removeCallbacks(passChange)
    instance = null
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun status(text: String): Notification {
    val open = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
    )
    val disconnect = PendingIntent.getService(
      this, 1, Intent(this, CoreService::class.java).setAction(ACTION_DISCONNECT), PendingIntent.FLAG_IMMUTABLE,
    )
    return Notification.Builder(this, KEEP)
      .setContentTitle("Connected to your machines")
      .setContentText(text)
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentIntent(open)
      .addAction(Notification.Action.Builder(null as Icon?, "Disconnect", disconnect).build())
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .build()
  }

  /**
   * Only a new default network (Wi-Fi to mobile data, Tailscale coming up)
   * retries the links, at most once per NETWORK_DEBOUNCE_MS. The network
   * there at registration is reported at once and isn't a change.
   */
  private fun watchNetwork() {
    val cm = getSystemService(ConnectivityManager::class.java)
    current = cm.activeNetwork
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(n: Network) {
        main.post { changedTo(n) }
      }

      override fun onLost(n: Network) {
        // The same network coming back is a change again.
        main.post { if (current == n) current = null }
      }
    }
    cm.registerDefaultNetworkCallback(callback)
    network = callback
  }

  private fun changedTo(n: Network) {
    if (n == current) return
    current = n
    main.removeCallbacks(passChange)
    val wait = (lastChange + NETWORK_DEBOUNCE_MS - SystemClock.elapsedRealtime()).coerceAtLeast(0)
    main.postDelayed(passChange, wait)
  }
}
