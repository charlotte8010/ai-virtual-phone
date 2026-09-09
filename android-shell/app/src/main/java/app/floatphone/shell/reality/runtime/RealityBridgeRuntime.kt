package app.floatphone.shell.reality.runtime

import android.content.Context
import android.os.BatteryManager
import android.os.Build
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import app.floatphone.shell.reality.actions.AndroidActionExecutor
import app.floatphone.shell.reality.data.local.KeystoreCredentialStore
import app.floatphone.shell.reality.data.local.RealityIdentityStore
import app.floatphone.shell.reality.data.local.SharedPreferencesCommandReceiptStore
import app.floatphone.shell.reality.data.local.SharedPreferencesResultOutboxStore
import app.floatphone.shell.reality.data.network.SupabaseRealtimeClient
import app.floatphone.shell.reality.data.network.SupabaseRestClient
import app.floatphone.shell.reality.domain.model.BridgeAction
import app.floatphone.shell.reality.domain.model.DeviceCommand
import app.floatphone.shell.reality.domain.model.DeviceCredentials
import app.floatphone.shell.reality.domain.model.DeviceHeartbeat
import app.floatphone.shell.reality.domain.model.DeviceResult
import app.floatphone.shell.reality.domain.processing.CommandProcessor
import okhttp3.OkHttpClient
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Runtime shared by the controlled WebMessage channel and PushService.
 * It owns one command processor and one receipt journal for both local and
 * Realtime deliveries; PushService remains the only foreground service.
 */
class RealityBridgeRuntime(
    context: Context,
    private val httpClient: OkHttpClient = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build(),
) {
    private val appContext = context.applicationContext
    private val identityStore = RealityIdentityStore(appContext)
    private val credentialStore = KeystoreCredentialStore(appContext)
    private val receiptStore = SharedPreferencesCommandReceiptStore(appContext)
    private val resultOutbox = SharedPreferencesResultOutboxStore(appContext)
    // Keep the long-lived WebSocket client separate from REST calls. A WebSocket
    // client intentionally has no read timeout; using it for REST would let a
    // stalled heartbeat or result upload block the maintenance loop forever.
    private val restClient = SupabaseRestClient(OkHttpClient())
    private val executor = AndroidActionExecutor(appContext)
    private val processor = CommandProcessor(
        expectedDeviceId = identityStore.deviceId(),
        receiptStore = receiptStore,
        executor = executor,
    )
    private val worker = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "float-reality-command").apply { isDaemon = true }
    }
    private var scheduler: ScheduledExecutorService? = null
    private var realtimeClient: SupabaseRealtimeClient? = null
    private var credentials: DeviceCredentials? = null
    @Volatile private var cloudConnected = false
    @Volatile private var serviceStarted = false

    @Synchronized
    fun start() {
        if (serviceStarted) return
        serviceStarted = true
        credentials = loadBoundCredentials()
        scheduler = Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "float-reality-maintenance").apply { isDaemon = true }
        }.also { maintenance ->
            maintenance.scheduleAtFixedRate(::maintenanceTick, 0, HEARTBEAT_SECONDS, TimeUnit.SECONDS)
        }
        startRealtime(credentials)
    }

    @Synchronized
    fun stop() {
        if (!serviceStarted) return
        serviceStarted = false
        realtimeClient?.stop()
        realtimeClient = null
        cloudConnected = false
        scheduler?.shutdownNow()
        scheduler = null
    }

    @Synchronized
    fun restartCloud() {
        credentials = loadBoundCredentials()
        if (serviceStarted) startRealtime(credentials)
    }

    /** Executes a command received through the top-level Native channel. */
    fun executeLocal(command: DeviceCommand): DeviceResult? = processor.process(command)

    /** Called only for commands received from the cloud Realtime subscription. */
    private fun processCloud(command: DeviceCommand) {
        val result = processor.process(command) ?: return
        deliverResult(result)
    }

    private fun startRealtime(nextCredentials: DeviceCredentials?) {
        realtimeClient?.stop()
        realtimeClient = null
        cloudConnected = false
        val loaded = nextCredentials ?: return
        realtimeClient = SupabaseRealtimeClient(
            credentials = loaded,
            httpClient = httpClient,
            listener = object : app.floatphone.shell.reality.data.network.RealtimeCommandListener {
                override fun onCommand(command: DeviceCommand) {
                    worker.execute { processCloud(command) }
                }

                override fun onConnectionStateChanged(connected: Boolean) {
                    cloudConnected = connected
                }
            },
        ).also { it.start() }
    }

    private fun loadBoundCredentials(): DeviceCredentials? = credentialStore.load()
        ?.takeIf { it.deviceId == identityStore.deviceId() }

    private fun deliverResult(result: DeviceResult) {
        val loaded = credentials ?: return resultOutbox.enqueue(result)
        if (restClient.reportResult(loaded, result).isFailure) resultOutbox.enqueue(result)
    }

    private fun flushResults() {
        val loaded = credentials ?: return
        resultOutbox.pending().forEach { result ->
            if (restClient.reportResult(loaded, result).isSuccess) resultOutbox.acknowledge(result.commandId)
        }
    }

    private fun maintenanceTick() {
        val loaded = credentials ?: return
        flushResults()
        val battery = appContext.getSystemService(BatteryManager::class.java)
            ?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
            ?.takeIf { it in 0..100 }
        val connectivity = appContext.getSystemService(ConnectivityManager::class.java)
        val networkCapabilities = connectivity?.getNetworkCapabilities(connectivity.activeNetwork)
        val network = when {
            networkCapabilities?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true -> "wifi"
            networkCapabilities?.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) == true -> "cellular"
            networkCapabilities?.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) == true -> "ethernet"
            else -> "offline"
        }
        restClient.reportHeartbeat(
            loaded,
            DeviceHeartbeat(
                deviceId = loaded.deviceId,
                batteryPercent = battery,
                network = network,
                androidVersion = Build.VERSION.RELEASE.orEmpty(),
                online = cloudConnected && network != "offline",
                sentAtEpochMs = System.currentTimeMillis(),
            ),
        )
    }

    companion object {
        const val HEARTBEAT_SECONDS = 30L
        val LOCAL_ACTIONS: List<BridgeAction> = BridgeAction.entries.toList()
    }
}

object RealityBridgeRuntimeProvider {
    @Volatile private var instance: RealityBridgeRuntime? = null

    fun get(context: Context): RealityBridgeRuntime {
        instance?.let { return it }
        return synchronized(this) {
            instance ?: RealityBridgeRuntime(context.applicationContext).also { instance = it }
        }
    }
}
