package app.floatphone.shell.reality.data.local

import android.content.Context
import app.floatphone.shell.reality.data.network.toJson
import app.floatphone.shell.reality.data.network.toStringMap
import app.floatphone.shell.reality.domain.model.DeviceResult
import app.floatphone.shell.reality.domain.model.DeviceResultStatus
import org.json.JSONObject

/** Bounded app-private result outbox; receipt completion and result delivery are independent. */
class SharedPreferencesResultOutboxStore(context: Context) {
    private val preferences = context.applicationContext
        .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val lock = Any()

    fun enqueue(result: DeviceResult) = synchronized(lock) {
        val outbox = read()
        outbox.put(result.commandId, encode(result))
        write(trim(outbox))
    }

    fun pending(): List<DeviceResult> = synchronized(lock) {
        val outbox = read()
        outbox.keys().asSequence().mapNotNull { key -> decode(outbox.optJSONObject(key)) }.toList()
    }

    fun acknowledge(commandId: String) = synchronized(lock) {
        val outbox = read()
        outbox.remove(commandId)
        write(outbox)
    }

    private fun encode(result: DeviceResult): JSONObject = JSONObject()
        .put("commandId", result.commandId)
        .put("deviceId", result.deviceId)
        .put("status", result.status.wireName)
        .put("result", result.result.toJson())
        .put("errorCode", result.errorCode)
        .put("errorMessage", result.errorMessage)
        .put("completedAt", result.completedAtEpochMs)

    private fun decode(json: JSONObject?): DeviceResult? = runCatching {
        if (json == null) return null
        DeviceResult(
            commandId = json.getString("commandId"),
            deviceId = json.getString("deviceId"),
            status = DeviceResultStatus.entries.first { it.wireName == json.getString("status") },
            result = json.optJSONObject("result")?.toStringMap() ?: emptyMap(),
            errorCode = json.optString("errorCode").takeIf(String::isNotBlank),
            errorMessage = json.optString("errorMessage").takeIf(String::isNotBlank),
            completedAtEpochMs = json.getLong("completedAt"),
        )
    }.getOrNull()

    private fun read(): JSONObject = runCatching {
        JSONObject(preferences.getString(KEY_OUTBOX, "{}") ?: "{}")
    }.getOrDefault(JSONObject())

    private fun write(outbox: JSONObject) {
        preferences.edit().putString(KEY_OUTBOX, outbox.toString()).apply()
    }

    private fun trim(outbox: JSONObject): JSONObject {
        if (outbox.length() <= MAX_RESULTS) return outbox
        outbox.keys().asSequence().take(outbox.length() - MAX_RESULTS).toList()
            .forEach(outbox::remove)
        return outbox
    }

    private companion object {
        const val PREFERENCES = "float_shell_reality_result_outbox"
        const val KEY_OUTBOX = "pending_results_v1"
        const val MAX_RESULTS = 128
    }
}
