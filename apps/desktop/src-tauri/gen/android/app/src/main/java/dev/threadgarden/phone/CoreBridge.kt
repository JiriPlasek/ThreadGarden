package dev.threadgarden.phone

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.util.Log

/**
 * The JNI seam with the Rust side (`src/android/shell.rs`). The `external`
 * functions go into the core; the other `@JvmStatic` functions are what Rust
 * calls back, on its own threads. Keep this thin: the logic is in Rust, where
 * it's tested.
 */
object CoreBridge {
  private const val TAG = "Threadgarden"
  const val EXTRA_MACHINE = "dev.threadgarden.phone.MACHINE_ID"
  const val EXTRA_SESSION = "dev.threadgarden.phone.SESSION_ID"

  @Volatile private var app: Context? = null

  init {
    // The service and the boot receiver can run without the activity, which loads it too.
    System.loadLibrary("threadgarden_lib")
  }

  /** Starts the process's core, or finds it running. */
  fun ensureStarted(context: Context): Boolean {
    val c = context.applicationContext
    app = c
    KeystoreSecrets.init(c)
    CoreService.channels(c)
    return start(c.filesDir.absolutePath, deviceName(c))
  }

  private fun deviceName(c: Context): String =
    Settings.Global.getString(c.contentResolver, Settings.Global.DEVICE_NAME)?.takeIf { it.isNotBlank() }
      ?: Build.MODEL

  @JvmStatic private external fun start(dataDir: String, name: String): Boolean
  @JvmStatic external fun wasConnected(dataDir: String): Boolean
  @JvmStatic external fun connect()
  @JvmStatic external fun disconnect()
  @JvmStatic external fun networkChanged()
  @JvmStatic external fun statusText(): String
  @JvmStatic external fun front(front: Boolean)
  @JvmStatic external fun opened(machineId: String, sessionId: String)

  // Called from Rust.

  @JvmStatic fun secretGet(key: String): String? = KeystoreSecrets.get(key)

  @JvmStatic fun secretSet(key: String, value: String) {
    KeystoreSecrets.set(key, value)
  }

  @JvmStatic fun secretDelete(key: String) {
    KeystoreSecrets.delete(key)
  }

  /** An alert, one per chat (a newer one for the same chat replaces it). Tapping it opens that chat. */
  @JvmStatic fun postAlert(machineId: String, sessionId: String, title: String) {
    val c = app ?: return
    val tag = "$machineId/$sessionId"
    val open = Intent(c, MainActivity::class.java)
      .putExtra(EXTRA_MACHINE, machineId)
      .putExtra(EXTRA_SESSION, sessionId)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val tap = PendingIntent.getActivity(
      c, tag.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val n = Notification.Builder(c, CoreService.ALERTS)
      .setContentTitle(title)
      .setSmallIcon(android.R.drawable.stat_notify_chat)
      .setCategory(Notification.CATEGORY_MESSAGE)
      .setContentIntent(tap)
      .setAutoCancel(true)
      .build()
    c.getSystemService(NotificationManager::class.java).notify(tag, CoreService.ALERT_ID, n)
  }

  /** The chat is on screen: its alert has been seen. */
  @JvmStatic fun cancelAlert(machineId: String, sessionId: String) {
    val c = app ?: return
    c.getSystemService(NotificationManager::class.java).cancel("$machineId/$sessionId", CoreService.ALERT_ID)
  }

  @JvmStatic fun postStatus(text: String) {
    CoreService.postStatus(text)
  }

  @JvmStatic fun notificationsAllowed(): Boolean =
    app?.getSystemService(NotificationManager::class.java)?.areNotificationsEnabled() ?: false

  @JvmStatic fun batteryExempt(): Boolean {
    val c = app ?: return false
    return c.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(c.packageName)
  }

  /** Android's own dialog; the first run explains it before asking. */
  @SuppressLint("BatteryLife")
  @JvmStatic fun requestBatteryExemption() {
    val c = app ?: return
    if (batteryExempt()) return
    c.startActivity(
      Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${c.packageName}"))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
    )
  }

  @JvmStatic fun startService() {
    app?.let { CoreService.start(it, CoreService.ACTION_CONNECT) }
  }

  @JvmStatic fun stopService() {
    app?.let { it.stopService(Intent(it, CoreService::class.java)) }
  }

  /** For `adb logcat -s Threadgarden`. Rust never passes a secret or a frame here. */
  @JvmStatic fun log(message: String) {
    Log.i(TAG, message)
  }
}
