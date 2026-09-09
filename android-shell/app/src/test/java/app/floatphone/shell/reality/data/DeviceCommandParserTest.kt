package app.floatphone.shell.reality.data

import app.floatphone.shell.reality.data.network.DeviceCommandParser
import app.floatphone.shell.reality.domain.model.BridgeAction
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class DeviceCommandParserTest {
    private val parser = DeviceCommandParser()

    @Test
    fun `parses postgres change with ISO timestamp`() {
        val command = parser.parse(
            """
            {"event":"postgres_changes","payload":{"data":{"record":{
              "id":"cmd-42","device_id":"device-1","action":"open_map",
              "payload":{"destination":"咖啡店"},"require_confirm":false,
              "ttl_seconds":60,"created_at":"2026-09-09T00:00:00Z"
            }}}}
            """.trimIndent(),
        )

        assertNotNull(command)
        assertEquals("cmd-42", command.id)
        assertEquals(BridgeAction.OPEN_MAP, command.action)
        assertEquals("咖啡店", command.payload["destination"])
    }

    @Test
    fun `parses broadcast compatibility fields and notification alias`() {
        val command = parser.parse(
            """
            {"event":"broadcast","payload":{"payload":{
              "id":"cmd-43","deviceId":"device-1","action":"notification_test",
              "payload":{"title":"Float","body":"ok"},"requireConfirm":true,
              "ttl":30,"createdAt":1757400000000
            }}}
            """.trimIndent(),
        )

        assertNotNull(command)
        assertEquals(BridgeAction.SHOW_NOTIFICATION, command.action)
        assertEquals(true, command.requireConfirmation)
        assertEquals(30, command.ttlSeconds)
    }

    @Test
    fun `ignores non-command events and malformed messages`() {
        assertNull(parser.parse("{\"event\":\"phx_reply\",\"payload\":{}}"))
        assertNull(parser.parse("not-json"))
    }
}
