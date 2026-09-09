package app.floatphone.shell.reality.data.local

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.util.UUID

/** Stable shell identity shared by binding, local commands, and the cloud runtime. */
class RealityIdentityStore(context: Context) {
    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val lock = Any()

    fun deviceId(): String = synchronized(lock) {
        preferences.getString(DEVICE_ID_KEY, null)?.takeIf(String::isNotBlank)?.let { return@synchronized it }
        val created = "shell_${UUID.randomUUID().toString().replace("-", "")}".take(128)
        preferences.edit().putString(DEVICE_ID_KEY, created).apply()
        created
    }

    fun publicKeyBase64(): String = synchronized(lock) {
        Base64.encodeToString(getOrCreateKeyPair().public.encoded, Base64.NO_WRAP)
    }

    private fun getOrCreateKeyPair(): KeyPair {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val privateKey = keyStore.getKey(KEY_ALIAS, null) as? java.security.PrivateKey
        val certificate = keyStore.getCertificate(KEY_ALIAS)
        if (privateKey != null && certificate != null) return KeyPair(certificate.publicKey, privateKey)
        return KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE).apply {
            initialize(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
                )
                    .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA512)
                    .build(),
            )
        }.generateKeyPair()
    }

    private companion object {
        const val PREFERENCES = "float_shell_reality_identity"
        const val DEVICE_ID_KEY = "device_id"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "float_shell_reality_identity_v1"
    }
}
