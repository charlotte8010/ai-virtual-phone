package app.floatphone.shell.reality.actions

import android.content.ActivityNotFoundException
import app.floatphone.shell.reality.domain.processing.ActionExecution

/** Explicit, non-bypass semantics for Activity-based Reality actions. */
object ActivityLaunchPolicy {
    const val BACKGROUND_ACTIVITY_START_DENIED = "background_activity_start_denied"
    const val ACTIVITY_UNAVAILABLE = "activity_unavailable"
    const val ACTIVITY_START_FAILED = "activity_start_failed"

    fun rejectWhenBackground(isVisible: Boolean): ActionExecution.Failure? =
        if (isVisible) null else ActionExecution.Failure(
            BACKGROUND_ACTIVITY_START_DENIED,
            "Android only allows this action while the Float window is visible",
        )

    fun failureFor(error: Throwable): ActionExecution.Failure = when (error) {
        is ActivityNotFoundException -> ActionExecution.Failure(
            ACTIVITY_UNAVAILABLE,
            error.message?.take(240) ?: "no Activity can handle this action",
        )

        is SecurityException -> ActionExecution.Failure(
            BACKGROUND_ACTIVITY_START_DENIED,
            "Android blocked the Activity launch from the current app state",
        )

        else -> ActionExecution.Failure(
            ACTIVITY_START_FAILED,
            error.message?.take(240) ?: "Activity launch failed",
        )
    }
}
