package app.floatphone.shell.reality.domain.validation

import app.floatphone.shell.reality.domain.model.BridgeAction
import app.floatphone.shell.reality.domain.model.DeviceCommand
import java.net.URI

sealed interface CommandValidation {
    data object Valid : CommandValidation

    data class Invalid(
        val code: String,
        val message: String,
    ) : CommandValidation
}

/** Defense-in-depth validator. Every command is checked again inside the Android runtime. */
class CommandValidator(
    private val maxClockSkewMs: Long = 5 * 60 * 1000L,
    private val maxTtlSeconds: Int = 60 * 60,
) {
    fun validate(command: DeviceCommand, expectedDeviceId: String, nowEpochMs: Long): CommandValidation {
        if (command.id.length !in 1..128 || !command.id.matches(ID_PATTERN)) {
            return invalid("invalid_command_id", "command id has an unsafe format")
        }
        if (command.deviceId != expectedDeviceId) {
            return invalid("wrong_device", "command targets another device")
        }
        if (command.ttlSeconds !in 1..maxTtlSeconds) {
            return invalid("invalid_ttl", "command ttl is outside the allowed range")
        }
        if (command.createdAtEpochMs > nowEpochMs + maxClockSkewMs) {
            return invalid("future_command", "command timestamp is too far in the future")
        }
        val expiresAt = command.createdAtEpochMs + command.ttlSeconds * 1000L
        if (expiresAt <= nowEpochMs) {
            return invalid("expired_command", "command ttl has elapsed")
        }

        return when (command.action) {
            BridgeAction.OPEN_APP -> validatePackage(command.payload["package"])
            BridgeAction.OPEN_URL -> validateUrl(command.payload["url"])
            BridgeAction.OPEN_MAP -> validateText(command.payload["destination"], "destination", 200)
            BridgeAction.DIAL_PHONE -> validatePhone(command.payload["phone"])
            BridgeAction.SHARE_TEXT -> validateText(command.payload["text"], "text", 4_000)
            BridgeAction.SHOW_NOTIFICATION -> validateNotification(command.payload)
        }
    }

    private fun validatePackage(value: String?): CommandValidation {
        if (value.isNullOrBlank() || value.length > 255 || !value.matches(PACKAGE_PATTERN)) {
            return invalid("invalid_package", "package name is not safe")
        }
        return CommandValidation.Valid
    }

    private fun validateUrl(value: String?): CommandValidation {
        if (value.isNullOrBlank() || value.length > 2_048) {
            return invalid("invalid_url", "url is empty or too long")
        }
        val uri = runCatching { URI(value) }.getOrNull()
        if (uri == null || !uri.scheme.equals("https", ignoreCase = true) || uri.host.isNullOrBlank() || uri.userInfo != null) {
            return invalid("invalid_url", "only HTTPS URLs without credentials are allowed")
        }
        return CommandValidation.Valid
    }

    private fun validatePhone(value: String?): CommandValidation {
        if (value.isNullOrBlank() || !value.matches(PHONE_PATTERN)) {
            return invalid("invalid_phone", "phone number is not safe for a dial intent")
        }
        val digits = value.count(Char::isDigit)
        if (digits !in 3..24) return invalid("invalid_phone", "phone number length is invalid")
        return CommandValidation.Valid
    }

    private fun validateNotification(payload: Map<String, String>): CommandValidation {
        val title = validateText(payload["title"], "title", 120)
        if (title !is CommandValidation.Valid) return title
        return validateText(payload["body"], "body", 4_000)
    }

    private fun validateText(value: String?, field: String, maxLength: Int): CommandValidation {
        if (value.isNullOrBlank() || value.length > maxLength || value.contains('\u0000')) {
            return invalid("invalid_$field", "$field is empty, too long, or contains a control character")
        }
        return CommandValidation.Valid
    }

    private fun invalid(code: String, message: String) = CommandValidation.Invalid(code, message)

    private companion object {
        val ID_PATTERN = Regex("[A-Za-z0-9_-]+")
        val PACKAGE_PATTERN = Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+")
        val PHONE_PATTERN = Regex("\\+?[0-9][0-9 ()-]{2,31}")
    }
}
