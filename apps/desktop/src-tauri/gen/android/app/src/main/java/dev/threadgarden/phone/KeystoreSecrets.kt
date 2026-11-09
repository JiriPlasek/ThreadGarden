package dev.threadgarden.phone

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Log
import java.io.File
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.InvalidKeyException
import java.security.KeyStore
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.json.JSONObject

/**
 * The core's secrets (device tokens, bridge passwords): one file in
 * `noBackupFilesDir`, encrypted with an AES-GCM key that never leaves
 * AndroidKeyStore. The file is `[IV length][IV][ciphertext + tag]` of a JSON
 * object. Nothing here logs a key's value.
 *
 * A key that's gone or can't open the file (a restored or reset phone) loses
 * the secrets: the machines then show as needing to be paired again, rather
 * than the app failing. Any other failure (the file unreadable, the keystore
 * busy) throws, so a passing fault never wipes the pairings.
 */
object KeystoreSecrets {
  private const val TAG = "Threadgarden"
  private const val ALIAS = "threadgarden-secrets"
  private const val KEYSTORE = "AndroidKeyStore"
  private const val TRANSFORM = "AES/GCM/NoPadding"

  private var file: File? = null
  private var values: Map<String, String>? = null

  @Synchronized fun init(c: Context) {
    if (file == null) file = File(c.noBackupFilesDir, "secrets.bin")
  }

  @Synchronized fun get(key: String): String? = load()[key]

  @Synchronized fun set(key: String, value: String) {
    save(load() + (key to value))
  }

  @Synchronized fun delete(key: String) {
    val now = load()
    if (key in now) save(now - key)
  }

  private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

  private fun existingKey(): SecretKey? = keyStore().getKey(ALIAS, null) as SecretKey?

  private fun newKey(): SecretKey {
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    gen.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return gen.generateKey()
  }

  private fun load(): Map<String, String> {
    values?.let { return it }
    val f = file ?: throw IllegalStateException("KeystoreSecrets.init was not called")
    if (!f.exists()) return emptyMap<String, String>().also { values = it }
    val bytes = f.readBytes() // An IOException here is passing: throw, keep the file.
    val loaded = try {
      decode(decrypt(bytes, existingKey() ?: throw UnrecoverableKeyException("the key is gone")))
    } catch (e: UnrecoverableKeyException) {
      forget(f, e) // The key is gone or can't be had.
    } catch (e: InvalidKeyException) {
      forget(f, e) // Invalidated (KeyPermanentlyInvalidatedException).
    } catch (e: AEADBadTagException) {
      forget(f, e) // Another key's file.
    } catch (e: IllegalArgumentException) {
      forget(f, e) // A damaged file.
    } catch (e: org.json.JSONException) {
      forget(f, e)
    }
    values = loaded
    return loaded
  }

  private fun forget(f: File, e: Exception): Map<String, String> {
    Log.w(TAG, "The secrets can't be opened (${e.javaClass.simpleName}): pair the machines again")
    f.delete()
    try {
      keyStore().deleteEntry(ALIAS)
    } catch (_: GeneralSecurityException) {
    } catch (_: IOException) {
    }
    return emptyMap()
  }

  private fun save(next: Map<String, String>) {
    val f = file ?: throw IllegalStateException("KeystoreSecrets.init was not called")
    val cipher = Cipher.getInstance(TRANSFORM)
    cipher.init(Cipher.ENCRYPT_MODE, existingKey() ?: newKey())
    val iv = cipher.iv
    val sealed = cipher.doFinal(JSONObject(next).toString().toByteArray(Charsets.UTF_8))
    val tmp = File(f.parentFile, f.name + ".tmp")
    tmp.writeBytes(byteArrayOf(iv.size.toByte()) + iv + sealed)
    if (!tmp.renameTo(f)) throw IOException("the secrets file could not be replaced")
    values = next
  }

  private fun decrypt(bytes: ByteArray, key: SecretKey): ByteArray {
    require(bytes.isNotEmpty()) { "empty" }
    val ivLen = bytes[0].toInt()
    require(ivLen in 12..16 && bytes.size > 1 + ivLen) { "truncated" }
    val cipher = Cipher.getInstance(TRANSFORM)
    cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, bytes, 1, ivLen))
    return cipher.doFinal(bytes, 1 + ivLen, bytes.size - 1 - ivLen)
  }

  private fun decode(plain: ByteArray): Map<String, String> {
    val json = JSONObject(String(plain, Charsets.UTF_8))
    return json.keys().asSequence().associateWith { json.getString(it) }
  }
}
