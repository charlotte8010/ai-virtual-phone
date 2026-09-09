package app.floatphone.shell.reality.actions

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class ActivityLaunchPolicyTest {
    @Test
    fun `activity actions are rejected before dispatch while backgrounded`() {
        val failure = ActivityLaunchPolicy.rejectWhenBackground(false)

        assertEquals(ActivityLaunchPolicy.BACKGROUND_ACTIVITY_START_DENIED, failure?.code)
        assertNull(ActivityLaunchPolicy.rejectWhenBackground(true))
    }

    @Test
    fun `system and intent failures have explicit result semantics`() {
        assertEquals(
            ActivityLaunchPolicy.BACKGROUND_ACTIVITY_START_DENIED,
            ActivityLaunchPolicy.failureFor(SecurityException()).code,
        )
        assertEquals(
            ActivityLaunchPolicy.ACTIVITY_START_FAILED,
            ActivityLaunchPolicy.failureFor(IllegalStateException()).code,
        )
    }
}
