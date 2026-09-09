package app.floatphone.shell.reality.actions

/** Tracks whether any shell Activity has a visible started window. */
object RealityActivityVisibility {
    private val lock = Any()
    private var startedActivityCount = 0

    fun onActivityStarted() = synchronized(lock) {
        startedActivityCount += 1
    }

    fun onActivityStopped() = synchronized(lock) {
        startedActivityCount = (startedActivityCount - 1).coerceAtLeast(0)
    }

    fun isVisible(): Boolean = synchronized(lock) { startedActivityCount > 0 }
}
