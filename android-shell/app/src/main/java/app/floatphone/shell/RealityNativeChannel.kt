package app.floatphone.shell

import android.content.Context
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Phase 1 protocol endpoint for the top-level Float page.
 *
 * This class deliberately exposes capability/permission state only. Native
 * action execution is wired in the next phase after the shared contract is
 * reviewed; an execute request is validated and returns NOT_READY.
 */
class RealityNativeChannel(context: Context) {

    companion object {
        const val JS_OBJECT_NAME = "FloatRealityChannel"
        private const val PROTOCOL_VERSION = 1
        private const val CHANNEL_ID = "float.reality"
        private const val MAX_MESSAGE_CHARS = 64_000
        private const val REQUEST_ID_MAX = 160
        private const val DEVICE_ID_KEY = "device_id"
        private const val USED_BINDING_NONCES_KEY = "used_binding_nonces"
        private const val MAX_USED_BINDING_NONCES = 32
        private const val PREFS = "float_shell_reality_identity"

        private val ACTIONS = setOf(
            "open_app",
            "open_url",
            "open_map",
            "dial_phone",
            "share_text",
            "show_notification",
        )
    }

    private val appContext = context.applicationContext
    private val identityPrefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun handle(rawMessage: String, isMainFrame: Boolean): String {
        if (!isMainFrame) return errorResponse("", "", "FRAME_NOT_ALLOWED", "Reality channel only accepts the top-level Float page")
        if (rawMessage.length > MAX_MESSAGE_CHARS) {
            return errorResponse("", "", "MESSAGE_TOO_LARGE", "Reality message is too large")
        }

        val request = runCatching { JSONObject(rawMessage) }.getOrNull()
            ?: return errorResponse("", "", "INVALID_JSON", "Reality message must be JSON")
        val requestId = request.optString("requestId", "")
        val operation = request.optString("operation", "")
        if (!validRequestId(requestId)) {
            return errorResponse(requestId, operation, "INVALID_REQUEST_ID", "Reality requestId is invalid")
        }
        if (request.optInt("protocolVersion", -1) != PROTOCOL_VERSION) {
            return errorResponse(requestId, operation, "INVALID_VERSION", "Reality protocol version is unsupported")
        }
        if (request.optString("channel", "") != CHANNEL_ID) {
            return errorResponse(requestId, operation, "INVALID_CHANNEL", "Reality channel is unsupported")
        }

        return when (operation) {
            "prepareBinding" -> prepareBinding(requestId, operation, request.optString("bindingNonce", ""))
            "getCapabilities" -> successResponse(requestId, operation, capabilities())
            "getPermissionState" -> successResponse(requestId, operation, permissionState())
            "execute" -> validateExecute(requestId, operation, request.optJSONObject("command"))
            else -> errorResponse(requestId, operation, "INVALID_OPERATION", "Reality operation is unsupported")
        }
    }

    private fun prepareBinding(requestId: String, operation: String, nonce: String): String {
        if (!nonce.matches(Regex("[A-Za-z0-9_-]{32,256}"))) {
            return errorResponse(requestId, operation, "INVALID_BINDING", "binding nonce is invalid")
        }
        val usedNonces = loadUsedBindingNonces()
        if (usedNonces.contains(nonce)) {
            return errorResponse(requestId, operation, "NONCE_REPLAY", "binding nonce has already been used")
        }
        saveUsedBindingNonces((usedNonces + nonce).takeLast(MAX_USED_BINDING_NONCES))
        return successResponse(
            requestId,
            operation,
            JSONObject()
                .put("protocolVersion", PROTOCOL_VERSION)
                .put("deviceId", stableDeviceId())
                .put("nonce", nonce)
                .put("publicKey", JSONObject.NULL),
        )
    }

    private fun validateExecute(requestId: String, operation: String, command: JSONObject?): String {
        if (command == null) return errorResponse(requestId, operation, "INVALID_COMMAND", "execute requires command")
        val commandId = command.optString("commandId", "")
        val deviceId = command.optString("deviceId", "")
        val action = command.optString("action", "")
        if (!validRequestId(commandId)) return errorResponse(requestId, operation, "INVALID_COMMAND_ID", "commandId is invalid")
        if (!deviceId.matches(Regex("[A-Za-z0-9_-]{1,128}"))) {
            return errorResponse(requestId, operation, "INVALID_DEVICE_ID", "deviceId is invalid")
        }
        if (!ACTIONS.contains(action)) return errorResponse(requestId, operation, "UNSUPPORTED_ACTION", "Reality action is unsupported")
        if (command.opt("payload") !is JSONObject) {
            return errorResponse(requestId, operation, "INVALID_PAYLOAD", "command payload is invalid")
        }
        val ttlSeconds = command.optInt("ttlSeconds", -1)
        if (ttlSeconds !in 1..900) return errorResponse(requestId, operation, "INVALID_TTL", "ttlSeconds is invalid")
        if (deviceId != stableDeviceId()) {
            return errorResponse(requestId, operation, "DEVICE_MISMATCH", "command device does not match this shell")
        }

        // The command schema is accepted, but action execution is intentionally
        // deferred until the post-review Reality runtime migration phase.
        return errorResponse(requestId, operation, "NOT_READY", "local Reality runtime is not enabled yet")
    }

    private fun capabilities(): JSONObject = JSONObject()
        .put("protocolVersion", PROTOCOL_VERSION)
        .put("transport", "local_native")
        .put("deviceId", stableDeviceId())
        .put("deviceName", Build.MODEL?.takeIf { it.isNotBlank() } ?: "Android device")
        .put("online", false)
        .put("actions", JSONArray())

    private fun permissionState(): JSONObject = JSONObject()
        .put("protocolVersion", PROTOCOL_VERSION)
        .put("transport", "local_native")
        .put("deviceId", stableDeviceId())
        .put("bound", false)
        .put("canExecute", false)
        .put("nativePermissions", JSONObject())

    private fun stableDeviceId(): String {
        identityPrefs.getString(DEVICE_ID_KEY, null)?.takeIf { it.isNotBlank() }?.let { return it }
        val created = "shell_${UUID.randomUUID().toString().replace("-", "")}".take(128)
        identityPrefs.edit().putString(DEVICE_ID_KEY, created).apply()
        return created
    }

    private fun loadUsedBindingNonces(): List<String> = runCatching {
        val raw = identityPrefs.getString(USED_BINDING_NONCES_KEY, null) ?: return emptyList()
        val values = JSONArray(raw)
        (0 until values.length()).mapNotNull { index -> values.optString(index).takeIf { it.isNotBlank() } }
    }.getOrDefault(emptyList())

    private fun saveUsedBindingNonces(nonces: List<String>) {
        val values = JSONArray()
        nonces.forEach(values::put)
        identityPrefs.edit().putString(USED_BINDING_NONCES_KEY, values.toString()).apply()
    }

    private fun validRequestId(value: String): Boolean =
        value.length in 1..REQUEST_ID_MAX && value.matches(Regex("[A-Za-z0-9_.:-]+"))

    private fun successResponse(requestId: String, operation: String, result: JSONObject): String =
        JSONObject()
            .put("protocolVersion", PROTOCOL_VERSION)
            .put("channel", CHANNEL_ID)
            .put("requestId", requestId)
            .put("operation", operation)
            .put("ok", true)
            .put("result", result)
            .toString()

    private fun errorResponse(requestId: String, operation: String, code: String, message: String): String =
        JSONObject()
            .put("protocolVersion", PROTOCOL_VERSION)
            .put("channel", CHANNEL_ID)
            .put("requestId", requestId.take(REQUEST_ID_MAX))
            .put("operation", operation.take(80))
            .put("ok", false)
            .put("error", JSONObject().put("code", code).put("message", message))
            .toString()
}
