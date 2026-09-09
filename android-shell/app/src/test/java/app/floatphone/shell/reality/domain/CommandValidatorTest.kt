package app.floatphone.shell.reality.domain

import app.floatphone.shell.reality.domain.model.BridgeAction
import app.floatphone.shell.reality.domain.model.DeviceCommand
import app.floatphone.shell.reality.domain.validation.CommandValidation
import app.floatphone.shell.reality.domain.validation.CommandValidator
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CommandValidatorTest {
    private val validator = CommandValidator()
    private val now = 1_757_400_000_000L

    @Test
    fun `accepts all six safe actions`() {
        val commands = listOf(
            command(BridgeAction.OPEN_APP, mapOf("package" to "com.google.android.apps.maps")),
            command(BridgeAction.OPEN_URL, mapOf("url" to "https://example.com/path")),
            command(BridgeAction.OPEN_MAP, mapOf("destination" to "Shanghai Hongqiao Airport")),
            command(BridgeAction.DIAL_PHONE, mapOf("phone" to "+8613800138000")),
            command(BridgeAction.SHARE_TEXT, mapOf("text" to "Hello from Float")),
            command(BridgeAction.SHOW_NOTIFICATION, mapOf("title" to "Float", "body" to "Bridge online")),
        )

        commands.forEach { assertEquals(CommandValidation.Valid, validator.validate(it, "device-1", now)) }
    }

    @Test
    fun `rejects wrong device expired and future commands`() {
        val wrongDevice = command(BridgeAction.OPEN_URL, mapOf("url" to "https://example.com"), deviceId = "device-2")
        val expired = command(BridgeAction.OPEN_URL, mapOf("url" to "https://example.com"), createdAt = now - 61_000)
        val future = command(BridgeAction.OPEN_URL, mapOf("url" to "https://example.com"), createdAt = now + 5 * 60 * 1000L + 1)

        assertTrue(validator.validate(wrongDevice, "device-1", now) is CommandValidation.Invalid)
        assertTrue(validator.validate(expired, "device-1", now) is CommandValidation.Invalid)
        assertTrue(validator.validate(future, "device-1", now) is CommandValidation.Invalid)
    }

    @Test
    fun `rejects unsafe payloads and invalid ttl`() {
        val http = command(BridgeAction.OPEN_URL, mapOf("url" to "http://example.com"))
        val unsafePackage = command(BridgeAction.OPEN_APP, mapOf("package" to "com.example;rm"))
        val malformedPhone = command(BridgeAction.DIAL_PHONE, mapOf("phone" to "tel:+123"))
        val invalidTtl = command(BridgeAction.OPEN_MAP, mapOf("destination" to "park"), ttlSeconds = 0)

        assertTrue(validator.validate(http, "device-1", now) is CommandValidation.Invalid)
        assertTrue(validator.validate(unsafePackage, "device-1", now) is CommandValidation.Invalid)
        assertTrue(validator.validate(malformedPhone, "device-1", now) is CommandValidation.Invalid)
        assertTrue(validator.validate(invalidTtl, "device-1", now) is CommandValidation.Invalid)
    }

    private fun command(
        action: BridgeAction,
        payload: Map<String, String>,
        deviceId: String = "device-1",
        createdAt: Long = now,
        ttlSeconds: Int = 60,
    ) = DeviceCommand(
        id = "cmd-${action.wireName}",
        deviceId = deviceId,
        action = action,
        payload = payload,
        requireConfirmation = false,
        ttlSeconds = ttlSeconds,
        createdAtEpochMs = createdAt,
    )
}
