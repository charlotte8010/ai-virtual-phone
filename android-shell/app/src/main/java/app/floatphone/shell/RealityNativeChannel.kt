package app.floatphone.shell

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import app.floatphone.shell.reality.data.local.DeviceCredentialStore
import app.floatphone.shell.reality.data.local.KeystoreCredentialStore
import app.floatphone.shell.reality.data.local.RealityIdentityStore
import app.floatphone.shell.reality.data.network.DeviceCommandParser
import app.floatphone.shell.reality.data.network.toJson
import app.floatphone.shell.reality.domain.model.BridgeAction
import app.floatphone.shell.reality.domain.model.DeviceCapabilities
import app.floatphone.shell.reality.domain.model.DeviceCredentials
import app.floatphone.shell.reality.domain.validation.SupabaseKeyClassifier
import app.floatphone.shell.reality.runtime.RealityBridgeRuntime
import app.floatphone.shell.reality.runtime.RealityBridgeRuntimeProvider
import java.net.URI
import org.json.JSONArray
import org.json.JSONObject

/**
 * Top-level Float protocol endpoint. It validates and executes commands through
 * the shared runtime; custom-app iframes never receive this object directly.
 */
class RealityNativeChannel(context: Context) {

    companion object {
        const val JS_OBJECT_NAME = "FloatRealityChannel"
        private const val PROTOCOL_VERSION = 1
        private const val CHANNEL_ID = "float.reality"
        private const val MAX_MESSAGE_CHARS = 64_000
        private const val REQUEST_ID_MAX = 160
        private const val USED_BINDING_NONCES_KEY = "used_binding_nonces"
        private const val MAX_USED_BINDING_NONCES = 32
        private const val PREFS = "float_shell_reality_identity"

        private val ACTIONS = BridgeAction.entries.toSet()
    }

    private val appContext = context.applicationContext
    private val identityStore = RealityIdentityStore(appContext)
    private val credentialStore: DeviceCredentialStore = KeystoreCredentialStore(appContext)
    private val commandParser = DeviceCommandParser()
    private val runtime: RealityBridgeRuntime
        get() = RealityBridgeRuntimeProvider.get(appContext)
    private val identityPrefs = appContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val bindingLock = Any()

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
            "completeBinding" -> completeBinding(requestId, operation, request.optJSONObject("credentials"))
            "getCapabilities" -> successResponse(requestId, operation, capabilities())
            "getPermissionState" -> successResponse(requestId, operation, permissionState())
            "execute" -> execute(requestId, operation, request.optJSONObject("command"))
            else -> errorResponse(requestId, operation, "INVALID_OPERATION", "Reality operation is unsupported")
        }
    }

    private fun prepareBinding(requestId: String, operation: String, nonce: String): String = synchronized(bindingLock) {
        if (!nonce.matches(Regex("[A-Za-z0-9_-]{32,256}"))) {
            return@synchronized errorResponse(requestId, operation, "INVALID_BINDING", "binding nonce is invalid")
        }
        val usedNonces = loadUsedBindingNonces()
        if (usedNonces.contains(nonce)) {
            return@synchronized errorResponse(requestId, operation, "NONCE_REPLAY", "binding nonce has already been used")
        }
        saveUsedBindingNonces((usedNonces + nonce).takeLast(MAX_USED_BINDING_NONCES))
        successResponse(
            requestId,
            operation,
            JSONObject()
                .put("protocolVersion", PROTOCOL_VERSION)
                .put("deviceId", identityStore.deviceId())
                .put("nonce", nonce)
                .put("publicKey", identityStore.publicKeyBase64()),
        )
    }

    private fun completeBinding(requestId: String, operation: String, raw: JSONObject?): String {
        val credentials = runCatching { parseCredentials(raw) }.getOrElse { error ->
            return errorResponse(requestId, operation, "INVALID_BINDING", error.message ?: "binding credentials are invalid")
        }
        if (credentials.deviceId != identityStore.deviceId()) {
            return errorResponse(requestId, operation, "DEVICE_MISMATCH", "binding credentials target another device")
        }
        runCatching { credentialStore.save(credentials) }.getOrElse { error ->
            return errorResponse(
                requestId,
                operation,
                "BINDING_STORAGE_FAILED",
                error.message ?: "binding credentials could not be stored",
            )
        }
        PushService.requestRealityReconnect(appContext)
        return successResponse(
            requestId,
            operation,
            JSONObject()
                .put("deviceId", credentials.deviceId)
                .put("deviceName", credentials.deviceName)
                .put("bound", true)
                .put("actions", JSONArray(credentials.capabilities.toWireNames())),
        )
    }

    private fun parseCredentials(raw: JSONObject?): DeviceCredentials {
        require(raw != null) { "binding credentials are required" }
        val deviceId = text(raw.optString("deviceId", ""), 128, "deviceId")
        require(deviceId.matches(Regex("[A-Za-z0-9_-]{1,128}"))) { "deviceId is invalid" }
        val deviceName = text(raw.optString("deviceName", ""), 120, "deviceName")
        val supabaseUrl = text(raw.optString("supabaseUrl", "").trimEnd('/'), 4096, "supabaseUrl")
        val uri = runCatching { URI(supabaseUrl) }.getOrNull()
        require(uri != null && uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrBlank()) {
            "supabaseUrl must use HTTPS"
        }
        val anonKey = text(raw.optString("anonKey", ""), 4096, "anonKey")
        val deviceToken = text(raw.optString("deviceToken", ""), 4096, "deviceToken")
        require(!SupabaseKeyClassifier.isElevatedKey(anonKey)) { "service role credentials are not accepted" }
        require(!SupabaseKeyClassifier.isElevatedKey(deviceToken)) { "service role credentials are not accepted" }
        val capabilities = raw.optJSONArray("capabilities")?.let(::parseCapabilities)
            ?: throw IllegalArgumentException("capabilities are required")
        return DeviceCredentials(
            deviceId = deviceId,
            deviceName = deviceName,
            supabaseUrl = supabaseUrl,
            anonKey = anonKey,
            deviceToken = deviceToken,
            capabilities = DeviceCapabilities(capabilities),
        )
    }

    private fun parseCapabilities(raw: JSONArray): List<BridgeAction> {
        require(raw.length() in 1..ACTIONS.size) { "capabilities are invalid" }
        val parsed = (0 until raw.length()).map { index ->
            BridgeAction.fromWire(raw.optString(index)) ?: throw IllegalArgumentException("capability is invalid")
        }
        require(parsed.toSet().size == parsed.size) { "capabilities contain duplicates" }
        return parsed
    }

    private fun execute(requestId: String, operation: String, raw: JSONObject?): String {
        if (raw == null) return errorResponse(requestId, operation, "INVALID_COMMAND", "execute requires command")
        val commandEnvelope = JSONObject()
            .put("event", "broadcast")
            .put("payload", JSONObject().put("payload", raw))
        val command = commandParser.parse(commandEnvelope.toString())
            ?: return errorResponse(requestId, operation, "INVALID_COMMAND", "command fields are invalid")
        val result = runtime.executeLocal(command)
            ?: return errorResponse(requestId, operation, "DUPLICATE_COMMAND", "command has already been completed or is in flight")
        val resultJson = JSONObject()
            .put("commandId", result.commandId)
            .put("deviceId", result.deviceId)
            .put("status", result.status.wireName)
            .put("result", result.result.toJson())
            .put("completedAt", java.time.Instant.ofEpochMilli(result.completedAtEpochMs).toString())
        result.errorCode?.let { resultJson.put("errorCode", it) }
        result.errorMessage?.let { resultJson.put("errorMessage", it) }
        return successResponse(requestId, operation, resultJson)
    }

    private fun capabilities(): JSONObject = JSONObject()
        .put("protocolVersion", PROTOCOL_VERSION)
        .put("transport", "local_native")
        .put("deviceId", identityStore.deviceId())
        .put("deviceName", Build.MODEL?.takeIf(String::isNotBlank) ?: "Android device")
        .put("online", true)
        .put("actions", JSONArray(RealityBridgeRuntime.LOCAL_ACTIONS.map(BridgeAction::wireName)))

    private fun permissionState(): JSONObject {
        val notificationStatus = if (Build.VERSION.SDK_INT < 33) {
            "unavailable"
        } else if (appContext.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
            "granted"
        } else {
            "denied"
        }
        return JSONObject()
            .put("protocolVersion", PROTOCOL_VERSION)
            .put("transport", "local_native")
            .put("deviceId", identityStore.deviceId())
            .put("bound", credentialStore.load()?.deviceId == identityStore.deviceId())
            .put("canExecute", true)
            .put("nativePermissions", JSONObject().put(Manifest.permission.POST_NOTIFICATIONS, notificationStatus))
    }

    private fun text(value: String, maxLength: Int, field: String): String {
        require(value.isNotBlank() && value.length <= maxLength && value.all { it.code >= 0x20 && it != '\u007f' }) {
            "$field is invalid"
        }
        return value
    }

    private fun loadUsedBindingNonces(): List<String> = runCatching {
        val raw = identityPrefs.getString(USED_BINDING_NONCES_KEY, null) ?: return emptyList()
        val values = JSONArray(raw)
        (0 until values.length()).mapNotNull { index -> values.optString(index).takeIf(String::isNotBlank) }
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
