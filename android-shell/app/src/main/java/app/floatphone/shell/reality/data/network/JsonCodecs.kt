package app.floatphone.shell.reality.data.network

import org.json.JSONArray
import org.json.JSONObject

fun Map<String, String>.toJson(): JSONObject = JSONObject().also { json ->
    forEach { (key, value) -> json.put(key, value) }
}

fun JSONObject.toStringMap(): Map<String, String> {
    val values = linkedMapOf<String, String>()
    keys().forEach { key ->
        val value = opt(key)
        if (value != null && value !== JSONObject.NULL && value !is JSONObject && value !is JSONArray) {
            values[key] = value.toString()
        }
    }
    return values
}
