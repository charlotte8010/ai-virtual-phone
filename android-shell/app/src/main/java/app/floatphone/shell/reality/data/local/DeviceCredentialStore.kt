package app.floatphone.shell.reality.data.local

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.floatphone.shell.reality.domain.model.BridgeAction
import app.floatphone.shell.reality.domain.model.DeviceCapabilities
import app.floatphone.shell.reality.domain.model.DeviceCredentials
import org.json.JSONArray
import org.json.JSONObject
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

interface DeviceCredentialStore {
    fun load(): DeviceCredentials?
    fun save(credentials: DeviceCredentials)
    fun clear()
}

/** Stores the device JWT and cloud config encrypted with an app-private Keystore AES key. */
class KeystoreCredentialStore(context: Context) : DeviceCredentialStore {
    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    override fun load(): DeviceCredentials? = runCatching {
        val iv = preferences.getString(KEY_IV, null) ?: return null
        val encrypted = preferences.getString(KEY_VALUE, null) ?: return null
        val cipher = Cipher.getInstance(TRANSFORMATION).apply {
            init(
                Cipher.DECRYPT_MODE,
                getOrCreateKey(),
                GCMParameterSpec(TAG_LENGTH_BITS, Base64.decode(iv, Base64.NO_WRAP)),
            )
        }
        val json = JSONObject(String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), Charsets.UTF_8))
        val actions = json.optJSONArray("capabilities")?.let(::decodeActions)
            ?: BridgeAction.entries.toList()
        DeviceCredentials(
            deviceId = json.getString("deviceId"),
            deviceName = json.getString("deviceName"),
            supabaseUrl = json.getString("supabaseUrl"),
            anonKey = json.getString("anonKey"),
            deviceToken = json.getString("deviceToken"),
            capabilities = DeviceCapabilities(actions),
        )
    }.getOrNull()

    override fun save(credentials: DeviceCredentials) {
        val json = JSONObject()
            .put("deviceId", credentials.deviceId)
            .put("deviceName", credentials.deviceName)
            .put("supabaseUrl", credentials.supabaseUrl)
            .put("anonKey", credentials.anonKey)
            .put("deviceToken", credentials.deviceToken)
            .put("capabilities", JSONArray(credentials.capabilities.toWireNames()))
        val iv = ByteArray(12).also { java.security.SecureRandom().nextBytes(it) }
        val cipher = Cipher.getInstance(TRANSFORMATION).apply {
            init(Cipher.ENCRYPT_MODE, getOrCreateKey(), GCMParameterSpec(TAG_LENGTH_BITS, iv))
        }
        val encrypted = cipher.doFinal(json.toString().toByteArray(Charsets.UTF_8))
        preferences.edit()
            .putString(KEY_IV, Base64.encodeToString(iv, Base64.NO_WRAP))
            .putString(KEY_VALUE, Base64.encodeToString(encrypted, Base64.NO_WRAP))
            .apply()
    }

    override fun clear() {
        preferences.edit().clear().apply()
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = java.security.KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).apply {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                )
                    .setKeySize(256)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
        }.generateKey()
    }

    private fun decodeActions(json: JSONArray): List<BridgeAction> = buildList {
        for (index in 0 until json.length()) {
            BridgeAction.fromWire(json.optString(index))?.let(::add)
        }
    }.ifEmpty { BridgeAction.entries.toList() }

    private companion object {
        const val PREFERENCES = "float_shell_reality_credentials"
        const val KEY_IV = "encrypted_iv"
        const val KEY_VALUE = "encrypted_value"
        const val KEY_ALIAS = "float_shell_reality_credentials_v1"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val TAG_LENGTH_BITS = 128
    }
}
