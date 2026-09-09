package app.floatphone.shell.reality.domain

import app.floatphone.shell.reality.domain.model.BridgeAction
import app.floatphone.shell.reality.domain.model.DeviceCommand
import app.floatphone.shell.reality.domain.model.DeviceResultStatus
import app.floatphone.shell.reality.domain.processing.ActionExecution
import app.floatphone.shell.reality.domain.processing.CommandProcessor
import app.floatphone.shell.reality.domain.processing.InMemoryCommandReceiptStore
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class CommandProcessorTest {
    @Test
    fun `executes a command once and ignores duplicate delivery`() {
        val executor = RecordingExecutor()
        val processor = processor(executor)
        val command = command()

        assertEquals(DeviceResultStatus.SUCCESS, processor.process(command)?.status)
        assertNull(processor.process(command))
        assertEquals(1, executor.calls)
    }

    @Test
    fun `confirmation is rejected before executor`() {
        val executor = RecordingExecutor()
        val result = processor(executor).process(command(requireConfirmation = true))

        assertEquals(DeviceResultStatus.REJECTED, result?.status)
        assertEquals("confirmation_required", result?.errorCode)
        assertEquals(0, executor.calls)
    }

    @Test
    fun `failed execution releases receipt for retry`() {
        val executor = RecordingExecutor(failFirst = true)
        val processor = processor(executor)

        assertEquals(DeviceResultStatus.FAILED, processor.process(command())?.status)
        assertEquals(DeviceResultStatus.SUCCESS, processor.process(command())?.status)
        assertEquals(2, executor.calls)
    }

    private fun processor(executor: RecordingExecutor) = CommandProcessor(
        expectedDeviceId = "device-1",
        receiptStore = InMemoryCommandReceiptStore(),
        executor = executor,
        clock = { NOW },
    )

    private fun command(requireConfirmation: Boolean = false) = DeviceCommand(
        id = "cmd-1",
        deviceId = "device-1",
        action = BridgeAction.OPEN_URL,
        payload = mapOf("url" to "https://example.com"),
        requireConfirmation = requireConfirmation,
        ttlSeconds = 60,
        createdAtEpochMs = NOW,
    )

    private class RecordingExecutor(private val failFirst: Boolean = false) : (DeviceCommand) -> ActionExecution {
        var calls = 0

        override fun invoke(command: DeviceCommand): ActionExecution {
            calls += 1
            return if (failFirst && calls == 1) {
                ActionExecution.Failure("temporary_failure", "test failure")
            } else {
                ActionExecution.Success(mapOf("accepted" to "true"))
            }
        }
    }

    private companion object {
        const val NOW = 1_757_400_000_000L
    }
}
