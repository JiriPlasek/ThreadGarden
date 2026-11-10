package dev.threadgarden.phone

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AlertDialog
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  /** onCreate has just sent CONNECT itself. */
  private var justCreated = false

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // The core before the webview, so the screens' service_connection finds it.
    CoreBridge.ensureStarted(this)
    // Opening the app connects again after a Disconnect; being made again (a
    // configuration change, the process restored) isn't opening it.
    if (savedInstanceState == null) CoreService.start(this, CoreService.ACTION_CONNECT)
    justCreated = true
    super.onCreate(savedInstanceState)
    keepClearOfSystemBars()
    if (savedInstanceState == null) openChat(intent)
    firstRun()
  }

  // An alert tapped while the activity runs (singleTask), or the launcher icon.
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    if (intent.action == Intent.ACTION_MAIN) CoreService.start(this, CoreService.ACTION_CONNECT)
    openChat(intent)
  }

  // In the background nothing is on screen, so the chat last shown alerts again.
  override fun onStart() {
    super.onStart()
    CoreBridge.front(true)
    // Back from Recents after Disconnect counts as opening the app again
    // (R14); back from Android's battery dialog doesn't.
    val fromBattery = CoreBridge.batteryDialogOpen
    CoreBridge.batteryDialogOpen = false
    if (!justCreated && !fromBattery && !CoreBridge.linksOn()) {
      CoreService.start(this, CoreService.ACTION_CONNECT)
    }
    justCreated = false
  }

  // A battery dialog that only paused the activity (no onStart to clear it).
  override fun onResume() {
    super.onResume()
    CoreBridge.batteryDialogOpen = false
  }

  override fun onStop() {
    CoreBridge.front(false)
    super.onStop()
  }

  /**
   * Edge to edge, the window spans the status bar, the gesture bar and a
   * cutout, and the keyboard no longer resizes it: the screens are padded
   * clear of all four here, so the webview never draws under them and shrinks
   * as the keyboard opens. The insets are used up, so the webview's own
   * `safe-area-inset-*` reads 0 and the page's padding (env() or `--sat`…)
   * adds nothing on top.
   */
  private fun keepClearOfSystemBars() {
    val content = findViewById<View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val clear = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime(),
      )
      view.setPadding(clear.left, clear.top, clear.right, clear.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  private fun openChat(intent: Intent?) {
    if (intent == null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
    val machine = intent.getStringExtra(CoreBridge.EXTRA_MACHINE) ?: return
    val session = intent.getStringExtra(CoreBridge.EXTRA_SESSION) ?: return
    intent.removeExtra(CoreBridge.EXTRA_MACHINE)
    intent.removeExtra(CoreBridge.EXTRA_SESSION)
    CoreBridge.opened(machine, session)
  }

  /** Once: ask for notifications, then explain and ask for the battery exemption. */
  private fun firstRun() {
    val prefs = getSharedPreferences("threadgarden", MODE_PRIVATE)
    if (prefs.getBoolean("askedKeepAlive", false)) return
    prefs.edit().putBoolean("askedKeepAlive", true).apply()
    if (Build.VERSION.SDK_INT >= 33 &&
      checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS)) { explainBattery() }
    } else {
      explainBattery()
    }
  }

  private fun explainBattery() {
    if (CoreBridge.batteryExempt() || isFinishing) return
    AlertDialog.Builder(this)
      .setTitle("Stay connected")
      .setMessage(
        "Threadgarden stays connected to your machines in the background, so it can tell you " +
          "at once when a chat needs you. Android may stop it to save battery unless you allow " +
          "it to run in the background. Staying connected uses some battery.",
      )
      .setPositiveButton("Allow") { _, _ -> CoreBridge.requestBatteryExemption() }
      .setNegativeButton("Not now", null)
      .show()
  }
}
