package app.floatphone.shell.reality.actions

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import app.floatphone.shell.R
import app.floatphone.shell.reality.domain.model.BridgeAction
import app.floatphone.shell.reality.domain.model.DeviceCommand
import app.floatphone.shell.reality.domain.processing.ActionExecution

/** Executes only the six explicit, non-Accessibility MVP actions. */
class AndroidActionExecutor(context: Context) : (DeviceCommand) -> ActionExecution {
    private val appContext = context.applicationContext
    private val packageManager = appContext.packageManager

    override fun invoke(command: DeviceCommand): ActionExecution = when (command.action) {
        BridgeAction.OPEN_APP -> openApp(command.payload["package"])
        BridgeAction.OPEN_URL -> openUrl(command.payload["url"])
        BridgeAction.OPEN_MAP -> openMap(command.payload["destination"])
        BridgeAction.DIAL_PHONE -> dialPhone(command.payload["phone"])
        BridgeAction.SHARE_TEXT -> shareText(command.payload["text"])
        BridgeAction.SHOW_NOTIFICATION -> showNotification(command.payload["title"], command.payload["body"])
    }

    private fun openApp(packageName: String?): ActionExecution = safeStart {
        val launchIntent = packageName?.let(packageManager::getLaunchIntentForPackage)
            ?: return@safeStart ActionExecution.Failure("app_not_found", "requested app is not installed")
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        appContext.startActivity(launchIntent)
        ActionExecution.Success(mapOf("package" to packageName, "started" to "true"))
    }

    private fun openUrl(url: String?): ActionExecution = safeStart {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        appContext.startActivity(intent)
        ActionExecution.Success(mapOf("url" to url.orEmpty(), "started" to "true"))
    }

    private fun openMap(destination: String?): ActionExecution = safeStart {
        val uri = Uri.parse("geo:0,0?q=${Uri.encode(destination.orEmpty())}")
        appContext.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        ActionExecution.Success(mapOf("destination" to destination.orEmpty(), "started" to "true"))
    }

    private fun dialPhone(phone: String?): ActionExecution = safeStart {
        val uri = Uri.parse("tel:${Uri.encode(phone.orEmpty())}")
        appContext.startActivity(Intent(Intent.ACTION_DIAL, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        ActionExecution.Success(mapOf("phone" to phone.orEmpty(), "started" to "true"))
    }

    private fun shareText(text: String?): ActionExecution = safeStart {
        val send = Intent(Intent.ACTION_SEND)
            .setType("text/plain")
            .putExtra(Intent.EXTRA_TEXT, text.orEmpty())
        appContext.startActivity(Intent.createChooser(send, "Share from Float").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        ActionExecution.Success(mapOf("shared" to "true"))
    }

    private fun showNotification(title: String?, body: String?): ActionExecution {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(
                appContext,
                Manifest.permission.POST_NOTIFICATIONS,
            ) != PackageManager.PERMISSION_GRANTED
        ) {
            return ActionExecution.Failure("notification_permission_required", "notification permission is not granted")
        }
        return safeStart {
            val manager = appContext.getSystemService(NotificationManager::class.java)
            if (Build.VERSION.SDK_INT >= 26) {
                manager.createNotificationChannel(
                    NotificationChannel(
                        CHANNEL_ID,
                        "Float Reality actions",
                        NotificationManager.IMPORTANCE_DEFAULT,
                    ),
                )
            }
            manager.notify(
                NOTIFICATION_ID,
                NotificationCompat.Builder(appContext, CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_stat)
                    .setContentTitle(title.orEmpty())
                    .setContentText(body.orEmpty())
                    .setStyle(NotificationCompat.BigTextStyle().bigText(body.orEmpty()))
                    .setAutoCancel(true)
                    .build(),
            )
            ActionExecution.Success(mapOf("notification" to "shown"))
        }
    }

    private fun safeStart(action: () -> ActionExecution): ActionExecution = runCatching { action() }
        .getOrElse { error ->
            ActionExecution.Failure("intent_failed", error.message?.take(240) ?: "native action failed")
        }

    private companion object {
        const val CHANNEL_ID = "shell_reality_actions"
        const val NOTIFICATION_ID = 42_710
    }
}
