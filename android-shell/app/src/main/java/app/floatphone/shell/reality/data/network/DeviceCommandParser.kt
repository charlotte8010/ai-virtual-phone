package app.floatphone.shell.reality.data.network

import app.floatphone.shell.reality.domain.model.BridgeAction
import app.floatphone.shell.reality.domain.model.DeviceCommand
import org.json.JSONObject
import java.time.Instant

/** Converts Supabase Realtime postgres changes and broadcast envelopes to one command model. */
class DeviceCommandParser {
    fun parse(raw: String): DeviceCommand? = runCatching {
        val root = JSONObject(raw)
        val payload = root.optJSONObject("payload") ?: return null
        val record = when (root.optString("event")) {
            "postgres_changes" -> payload.optJSONObject("data")?.optJSONObject("record")
                ?: payload.optJSONObject("record")
            "broadcast" -> payload.optJSONObject("payload")
                ?: payload.optJSONObject("data")
            else -> null
        } ?: return null
        parseRecord(record)
    }.getOrNull()

    private fun parseRecord(record: JSONObject): DeviceCommand? {
        val id = firstString(record, "id", "command_id") ?: return null
        val deviceId = firstString(record, "device_id", "deviceId") ?: return null
        val action = BridgeAction.fromWire(firstString(record, "action") ?: return null) ?: return null
        val payload = record.optJSONObject("payload")?.toStringMap() ?: emptyMap()
        val ttl = firstLong(record, "ttl_seconds", "ttl", "ttlSeconds")?.toInt() ?: return null
        val createdAt = firstLong(record, "created_at", "createdAt", "created_at_epoch_ms") ?: return null
        val requireConfirmation = firstBoolean(record, "require_confirm", "requireConfirmation", "requireConfirm")
        return DeviceCommand(
            id = id,
            deviceId = deviceId,
            action = action,
            payload = payload,
            requireConfirmation = requireConfirmation,
            ttlSeconds = ttl,
            createdAtEpochMs = createdAt,
        )
    }

    private fun firstString(json: JSONObject, vararg names: String): String? = names
        .asSequence()
        .mapNotNull { name -> json.optString(name).takeIf { it.isNotBlank() } }
        .firstOrNull()

    private fun firstLong(json: JSONObject, vararg names: String): Long? = names
        .asSequence()
        .mapNotNull { name -> json.opt(name)?.let(::parseEpochMs) }
        .firstOrNull()

    private fun firstBoolean(json: JSONObject, vararg names: String): Boolean = names
        .asSequence()
        .mapNotNull { name -> json.opt(name)?.let { value ->
            when (value) {
                is Boolean -> value
                is String -> value.toBooleanStrictOrNull()
                else -> null
            }
        } }
        .firstOrNull() ?: false

    private fun parseEpochMs(value: Any): Long? = when (value) {
        is Number -> value.toLong()
        is String -> value.toLongOrNull() ?: runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
        else -> null
    }
}
