package app.floatphone.shell.reality.data.local

import android.content.Context
import app.floatphone.shell.reality.domain.processing.CommandReceiptStore
import app.floatphone.shell.reality.domain.processing.ReceiptClaim
import org.json.JSONObject

/** Bounded receipt journal. A completed command is never executed twice after redelivery. */
class SharedPreferencesCommandReceiptStore(context: Context) : CommandReceiptStore {
    private val preferences = context.applicationContext
        .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val lock = Any()

    override fun tryClaim(commandId: String, nowEpochMs: Long): ReceiptClaim = synchronized(lock) {
        val receipts = read()
        val current = receipts.optJSONObject(commandId)
        if (current == null) {
            receipts.put(commandId, JSONObject().put("state", "processing").put("updatedAt", nowEpochMs))
            write(trim(receipts))
            return@synchronized ReceiptClaim.CLAIMED
        }
        if (current.optString("state") == "complete") return@synchronized ReceiptClaim.COMPLETED
        if (nowEpochMs - current.optLong("updatedAt") > STALE_AFTER_MS) {
            receipts.put(commandId, JSONObject().put("state", "processing").put("updatedAt", nowEpochMs))
            write(trim(receipts))
            ReceiptClaim.CLAIMED
        } else {
            ReceiptClaim.IN_FLIGHT
        }
    }

    override fun markCompleted(commandId: String, nowEpochMs: Long) = synchronized(lock) {
        val receipts = read()
        receipts.put(commandId, JSONObject().put("state", "complete").put("updatedAt", nowEpochMs))
        write(trim(receipts))
    }

    override fun release(commandId: String) = synchronized(lock) {
        val receipts = read()
        receipts.remove(commandId)
        write(receipts)
    }

    private fun read(): JSONObject = runCatching {
        JSONObject(preferences.getString(KEY_RECEIPTS, "{}") ?: "{}")
    }.getOrDefault(JSONObject())

    private fun write(receipts: JSONObject) {
        preferences.edit().putString(KEY_RECEIPTS, receipts.toString()).apply()
    }

    private fun trim(receipts: JSONObject): JSONObject {
        if (receipts.length() <= MAX_RECEIPTS) return receipts
        val keys = receipts.keys().asSequence().toList()
        keys.sortedBy { receipts.optJSONObject(it)?.optLong("updatedAt") ?: Long.MIN_VALUE }
            .take(receipts.length() - MAX_RECEIPTS)
            .forEach(receipts::remove)
        return receipts
    }

    private companion object {
        const val PREFERENCES = "float_shell_reality_receipts"
        const val KEY_RECEIPTS = "command_receipts_v1"
        const val MAX_RECEIPTS = 256
        const val STALE_AFTER_MS = 5 * 60 * 1000L
    }
}
