package dev.threadgarden.phone

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * After a reboot (or an update of the app, which also stops it) the service
 * starts again, but only if the core was connected: after Disconnect it waits
 * for the app to be opened.
 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    if (CoreBridge.wasConnected(context.filesDir.absolutePath)) CoreService.start(context, null)
  }
}
