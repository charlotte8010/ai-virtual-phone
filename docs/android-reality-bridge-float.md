# Float 侧 Android Reality Bridge

Float 的 Android Bridge 接入复用现有个人云，不替换 iOS 现实桥，也不引入新的人格或记忆系统。

## 部署前提

1. 在「设置 → 云服务部署」重新部署最新版个人云。部署脚本会创建 `bridge_pairing_tokens`、`device_registry`、`device_commands` 和 `device_results`，并开启设备端所需的 RLS/Realtime 权限。
2. 在同一个 Supabase 项目部署 `float-android-bridge` 仓库提供的 `bridge-pair` Edge Function，并按该仓库文档配置 `SUPABASE_SERVICE_ROLE_KEY` 与能被 Supabase JWT 校验接受的 `BRIDGE_JWT_SECRET`。
3. 在 Reality Bridge → Android Bridge 填写该个人云项目的 anon/publishable key。二维码只包含这个公开 key、短期一次性 pairing token 和 Supabase URL；service role key 不会进入二维码。

## 使用闭环

Float 生成 `floatbridge://pair?payload=...` 深链和二维码 → Android Companion 完成一次性配对 → Float 刷新设备列表和心跳状态 → 下发六个显式安全动作之一 → Android 写入幂等 `device_results` → Float 轮询并展示结果。

当前六个动作是 `open_app`、`open_url`、`open_map`、`dial_phone`、`share_text`、`show_notification`。本阶段不实现 Accessibility、通知读取、屏幕控制、`device.query` 或 extension zip。
