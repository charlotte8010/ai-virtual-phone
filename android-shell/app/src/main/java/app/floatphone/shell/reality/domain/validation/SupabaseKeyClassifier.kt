package app.floatphone.shell.reality.domain.validation

import org.json.JSONObject
import java.nio.charset.StandardCharsets
import java.util.Base64
import java.util.Locale

/** Recognizes both legacy JWT service_role keys and current sb_secret_ keys. */
object SupabaseKeyClassifier {
    fun isElevatedKey(value: String): Boolean {
        val normalized = value.trim()
        if (normalized.lowercase(Locale.ROOT).startsWith("sb_secret_")) return true
        val parts = normalized.split('.')
        if (parts.size != 3) return false
        val payload = runCatching {
            val encoded = parts[1]
                .replace('-', '+')
                .replace('_', '/')
                .padEnd(((parts[1].length + 3) / 4) * 4, '=')
            Base64.getDecoder().decode(encoded)
        }.getOrNull() ?: return false
        return runCatching {
            JSONObject(String(payload, StandardCharsets.UTF_8)).optString("role") == "service_role"
        }.getOrDefault(false)
    }
}
