package app.floatphone.shell.reality.data.network

import app.floatphone.shell.reality.domain.model.DeviceCredentials
import app.floatphone.shell.reality.domain.model.DeviceHeartbeat
import app.floatphone.shell.reality.domain.model.DeviceResult
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.time.Instant

class SupabaseRestClient(
    private val httpClient: OkHttpClient,
) {
    fun reportResult(credentials: DeviceCredentials, result: DeviceResult): Result<Unit> = runCatching {
        val body = JSONObject()
            .put("command_id", result.commandId)
            .put("device_id", result.deviceId)
            .put("status", result.status.wireName)
            .put("result", result.result.toJson())
            .put("completed_at", Instant.ofEpochMilli(result.completedAtEpochMs).toString())
        result.errorCode?.let { body.put("error_code", it) }
        result.errorMessage?.let { body.put("error_message", it) }
        val request = authorizedRequest(credentials, "device_results")
            .header("Prefer", "resolution=merge-duplicates,return=minimal")
            .post(body.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()
        execute(request)
    }

    fun reportHeartbeat(credentials: DeviceCredentials, heartbeat: DeviceHeartbeat): Result<Unit> = runCatching {
        val body = JSONObject()
            .put("device_id", heartbeat.deviceId)
            .put("battery_percent", heartbeat.batteryPercent)
            .put("network", heartbeat.network)
            .put("android_version", heartbeat.androidVersion)
            .put("online", heartbeat.online)
            .put("last_seen", Instant.ofEpochMilli(heartbeat.sentAtEpochMs).toString())
        val request = authorizedRequest(
            credentials,
            "device_registry",
            "device_id" to "eq.${heartbeat.deviceId}",
        )
            .patch(body.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()
        execute(request)
    }

    private fun authorizedRequest(
        credentials: DeviceCredentials,
        table: String,
        vararg queryParameters: Pair<String, String>,
    ): Request.Builder {
        val urlBuilder = credentials.supabaseUrl.toHttpUrl().newBuilder()
            .addPathSegments("rest/v1/$table")
        queryParameters.forEach { (name, value) -> urlBuilder.addQueryParameter(name, value) }
        return Request.Builder()
            .url(urlBuilder.build())
            .header("apikey", credentials.anonKey)
            .header("Authorization", "Bearer ${credentials.deviceToken}")
            .header("Accept", "application/json")
    }

    private fun execute(request: Request) {
        httpClient.newCall(request).execute().use { response ->
            check(response.isSuccessful) { "Supabase request failed (${response.code})" }
        }
    }

    private companion object {
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
    }
}
