/**
 * 后台保活前台服务 —— 对齐 HarmonyOS KeepAlive（DATA_TRANSFER 长时任务）。
 * 退后台时启动，回前台停止（MainActivity onPause/onResume 控制）。
 * Android 14+ 需要 FOREGROUND_SERVICE_DATA_SYNC 权限与通知授权。
 */
package com.happyharness.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.util.Log

class TunnelService : Service() {
    companion object {
        private const val TAG = "HHKeepAlive"
        private const val CHANNEL_ID = "hh_tunnel"
        private const val NOTIFICATION_ID = 1

        fun start(ctx: Context) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(Intent(ctx, TunnelService::class.java))
            } else {
                ctx.startService(Intent(ctx, TunnelService::class.java))
            }
        }

        fun stop(ctx: Context) {
            ctx.stopService(Intent(ctx, TunnelService::class.java))
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "隧道保活", NotificationManager.IMPORTANCE_MIN)
            )
        }
        val notification: Notification =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(this, CHANNEL_ID)
                    .setContentTitle("Happy Harness")
                    .setContentText("保持与电脑的连接")
                    .setSmallIcon(android.R.drawable.ic_menu_compass)
                    .build()
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(this)
                    .setContentTitle("Happy Harness")
                    .setContentText("保持与电脑的连接")
                    .setSmallIcon(android.R.drawable.ic_menu_compass)
                    .build()
            }
        startForeground(NOTIFICATION_ID, notification)
        Log.i(TAG, "foreground service started (dataSync)")
    }
}
