package app.floatphone.shell.reality.domain.model

enum class BridgeAction(val wireName: String) {
    OPEN_APP("open_app"),
    OPEN_URL("open_url"),
    OPEN_MAP("open_map"),
    DIAL_PHONE("dial_phone"),
    SHARE_TEXT("share_text"),
    SHOW_NOTIFICATION("show_notification");

    companion object {
        fun fromWire(value: String): BridgeAction? = entries.firstOrNull { it.wireName == value }
            ?: SHOW_NOTIFICATION.takeIf { value == "notification_test" }
    }
}

enum class DeviceResultStatus(val wireName: String) {
    SUCCESS("success"),
    FAILED("failed"),
    REJECTED("rejected"),
}

data class DeviceCommand(
    val id: String,
    val deviceId: String,
    val action: BridgeAction,
    val payload: Map<String, String>,
    val requireConfirmation: Boolean,
    val ttlSeconds: Int,
    val createdAtEpochMs: Long,
)

data class DeviceResult(
    val commandId: String,
    val deviceId: String,
    val status: DeviceResultStatus,
    val result: Map<String, String> = emptyMap(),
    val errorCode: String? = null,
    val errorMessage: String? = null,
    val completedAtEpochMs: Long,
)

data class DeviceHeartbeat(
    val deviceId: String,
    val batteryPercent: Int?,
    val network: String,
    val androidVersion: String,
    val online: Boolean,
    val sentAtEpochMs: Long,
)

data class DeviceCapabilities(
    val actions: List<BridgeAction> = BridgeAction.entries.toList(),
) {
    fun toWireNames(): List<String> = actions.map { it.wireName }
}

data class DeviceCredentials(
    val deviceId: String,
    val deviceName: String,
    val supabaseUrl: String,
    val anonKey: String,
    val deviceToken: String,
    val capabilities: DeviceCapabilities = DeviceCapabilities(),
)
