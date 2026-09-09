package app.floatphone.shell.reality.data.network

import app.floatphone.shell.reality.domain.model.DeviceCommand
import app.floatphone.shell.reality.domain.model.DeviceCredentials
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

interface RealtimeCommandListener {
    fun onCommand(command: DeviceCommand)
    fun onConnectionStateChanged(connected: Boolean)
}

/** Minimal Phoenix client for the private device_commands INSERT feed. */
class SupabaseRealtimeClient(
    private val credentials: DeviceCredentials,
    private val listener: RealtimeCommandListener,
    private val commandParser: DeviceCommandParser = DeviceCommandParser(),
    private val httpClient: OkHttpClient,
) {
    private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    private val stopped = AtomicBoolean(false)
    private val reference = AtomicInteger(1)
    private var reconnectFuture: ScheduledFuture<*>? = null
    private var heartbeatFuture: ScheduledFuture<*>? = null
    private var socket: WebSocket? = null
    private var reconnectDelaySeconds = 5L

    fun start() {
        if (stopped.get()) return
        connect()
    }

    fun stop() {
        if (!stopped.compareAndSet(false, true)) return
        reconnectFuture?.cancel(false)
        heartbeatFuture?.cancel(false)
        socket?.cancel()
        scheduler.shutdownNow()
        listener.onConnectionStateChanged(false)
    }

    private fun connect() {
        if (stopped.get()) return
        val request = Request.Builder()
            .url(webSocketUrl())
            .header("apikey", credentials.anonKey)
            .header("Authorization", "Bearer ${credentials.deviceToken}")
            .build()
        socket = httpClient.newWebSocket(request, socketListener())
    }

    private fun socketListener() = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            reconnectDelaySeconds = 5L
            listener.onConnectionStateChanged(true)
            webSocket.send(joinMessage())
            heartbeatFuture?.cancel(false)
            heartbeatFuture = scheduler.scheduleAtFixedRate(
                { sendHeartbeat(webSocket) },
                25,
                25,
                TimeUnit.SECONDS,
            )
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            commandParser.parse(text)?.let(listener::onCommand)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            listener.onConnectionStateChanged(false)
            scheduleReconnect()
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            listener.onConnectionStateChanged(false)
            scheduleReconnect()
        }
    }

    private fun sendHeartbeat(webSocket: WebSocket) {
        if (stopped.get()) return
        webSocket.send(
            JSONObject()
                .put("topic", "phoenix")
                .put("event", "heartbeat")
                .put("payload", JSONObject())
                .put("ref", nextReference())
                .toString(),
        )
    }

    private fun scheduleReconnect() {
        if (stopped.get() || reconnectFuture?.isDone == false) return
        heartbeatFuture?.cancel(false)
        val delay = reconnectDelaySeconds
        reconnectDelaySeconds = (reconnectDelaySeconds * 2).coerceAtMost(120L)
        reconnectFuture = scheduler.schedule({ connect() }, delay, TimeUnit.SECONDS)
    }

    private fun webSocketUrl(): String {
        val base = credentials.supabaseUrl.toHttpUrl()
        return base.newBuilder()
            .scheme(if (base.scheme == "https") "wss" else "ws")
            .addPathSegments("realtime/v1/websocket")
            .addQueryParameter("apikey", credentials.anonKey)
            .addQueryParameter("vsn", "1.0.0")
            .build()
            .toString()
    }

    private fun joinMessage(): String = JSONObject()
        .put("topic", topic())
        .put("event", "phx_join")
        .put("ref", nextReference())
        .put(
            "payload",
            JSONObject()
                .put("access_token", credentials.deviceToken)
                .put(
                    "config",
                    JSONObject()
                        .put("broadcast", JSONObject().put("self", false))
                        .put("presence", JSONObject().put("key", ""))
                        .put("private", true)
                        .put(
                            "postgres_changes",
                            JSONArray().put(
                                JSONObject()
                                    .put("event", "INSERT")
                                    .put("schema", "public")
                                    .put("table", "device_commands")
                                    .put("filter", "device_id=eq.${credentials.deviceId}"),
                            ),
                        ),
                ),
        )
        .toString()

    private fun topic() = "realtime:device-commands:${credentials.deviceId}"

    private fun nextReference() = reference.getAndIncrement().toString()
}
