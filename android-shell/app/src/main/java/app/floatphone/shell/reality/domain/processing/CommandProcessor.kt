package app.floatphone.shell.reality.domain.processing

import app.floatphone.shell.reality.domain.model.DeviceCommand
import app.floatphone.shell.reality.domain.model.DeviceResult
import app.floatphone.shell.reality.domain.model.DeviceResultStatus
import app.floatphone.shell.reality.domain.validation.CommandValidation
import app.floatphone.shell.reality.domain.validation.CommandValidator

sealed interface ActionExecution {
    data class Success(val result: Map<String, String> = emptyMap()) : ActionExecution

    data class Failure(
        val code: String,
        val message: String,
    ) : ActionExecution
}

enum class ReceiptClaim {
    CLAIMED,
    IN_FLIGHT,
    COMPLETED,
}

interface CommandReceiptStore {
    fun tryClaim(commandId: String, nowEpochMs: Long): ReceiptClaim
    fun markCompleted(commandId: String, nowEpochMs: Long)
    fun release(commandId: String)
}

class InMemoryCommandReceiptStore(
    private val staleAfterMs: Long = 5 * 60 * 1000L,
) : CommandReceiptStore {
    private data class Receipt(val completed: Boolean, val updatedAtEpochMs: Long)

    private val receipts = mutableMapOf<String, Receipt>()

    @Synchronized
    override fun tryClaim(commandId: String, nowEpochMs: Long): ReceiptClaim {
        val current = receipts[commandId]
        return when {
            current == null -> {
                receipts[commandId] = Receipt(completed = false, updatedAtEpochMs = nowEpochMs)
                ReceiptClaim.CLAIMED
            }

            current.completed -> ReceiptClaim.COMPLETED
            nowEpochMs - current.updatedAtEpochMs > staleAfterMs -> {
                receipts[commandId] = Receipt(completed = false, updatedAtEpochMs = nowEpochMs)
                ReceiptClaim.CLAIMED
            }

            else -> ReceiptClaim.IN_FLIGHT
        }
    }

    @Synchronized
    override fun markCompleted(commandId: String, nowEpochMs: Long) {
        receipts[commandId] = Receipt(completed = true, updatedAtEpochMs = nowEpochMs)
    }

    @Synchronized
    override fun release(commandId: String) {
        receipts.remove(commandId)
    }
}

class CommandProcessor(
    private val expectedDeviceId: String,
    private val receiptStore: CommandReceiptStore,
    private val executor: (DeviceCommand) -> ActionExecution,
    private val clock: () -> Long = System::currentTimeMillis,
    private val validator: CommandValidator = CommandValidator(),
) {
    fun process(command: DeviceCommand): DeviceResult? {
        val now = clock()
        when (val validation = validator.validate(command, expectedDeviceId, now)) {
            CommandValidation.Valid -> Unit
            is CommandValidation.Invalid -> return DeviceResult(
                commandId = command.id,
                deviceId = command.deviceId,
                status = DeviceResultStatus.REJECTED,
                errorCode = validation.code,
                errorMessage = validation.message,
                completedAtEpochMs = now,
            )
        }
        if (command.requireConfirmation) {
            return DeviceResult(
                commandId = command.id,
                deviceId = command.deviceId,
                status = DeviceResultStatus.REJECTED,
                errorCode = "confirmation_required",
                errorMessage = "local confirmation is required before this action",
                completedAtEpochMs = now,
            )
        }

        when (receiptStore.tryClaim(command.id, now)) {
            ReceiptClaim.CLAIMED -> Unit
            ReceiptClaim.IN_FLIGHT, ReceiptClaim.COMPLETED -> return null
        }

        return try {
            when (val execution = executor(command)) {
                is ActionExecution.Success -> {
                    receiptStore.markCompleted(command.id, now)
                    DeviceResult(
                        commandId = command.id,
                        deviceId = command.deviceId,
                        status = DeviceResultStatus.SUCCESS,
                        result = execution.result,
                        completedAtEpochMs = clock(),
                    )
                }

                is ActionExecution.Failure -> {
                    receiptStore.release(command.id)
                    DeviceResult(
                        commandId = command.id,
                        deviceId = command.deviceId,
                        status = DeviceResultStatus.FAILED,
                        errorCode = execution.code,
                        errorMessage = execution.message,
                        completedAtEpochMs = clock(),
                    )
                }
            }
        } catch (error: Throwable) {
            receiptStore.release(command.id)
            DeviceResult(
                commandId = command.id,
                deviceId = command.deviceId,
                status = DeviceResultStatus.FAILED,
                errorCode = "executor_exception",
                errorMessage = error.message?.take(240) ?: "action executor failed",
                completedAtEpochMs = clock(),
            )
        }
    }
}
