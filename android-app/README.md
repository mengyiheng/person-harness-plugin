# 智枢 Android App

Android 手机端使用 Kotlin + WebView，通过配对凭证和端到端加密隧道连接电脑。它既支持独立 Agent 轻量壳，也可按电脑端配置接入 dsh 界面和远程工具。

## 当前能力

- 扫码或输入配对码，管理已配对设备与独立 Agent。
- 工作区、会话、新建会话、停止与工具审批。
- Ed25519、X25519、HKDF-SHA256 与 AES-256-GCM。
- 适合网络下的 UDP 业务直连，失败时回落加密中继。
- 文件互传、剪贴板、截图与远程授权深链。

UDP 是否可用取决于 NAT、运营商和当前网络环境。窗口实况与资料检索等高级工具以当前 App 页面和电脑端版本为准。

## 构建环境

- JDK 17。
- Android SDK 34、Build Tools 36.0.0。
- Gradle 8.7（工程提供 Wrapper 配置）。
- Android 8.0／API 26 或更高版本的手机。

## 构建 DEBUG 包

用 Android Studio 打开本目录并完成 Sync，或在工程目录执行：

```bash
# macOS / Linux
./gradlew assembleDebug

# Windows
gradlew.bat assembleDebug
```

输出位于 `app/build/outputs/apk/debug/app-debug.apk`。`local.properties` 由 Android Studio 根据本机 SDK 位置生成，不进入仓库。

DEBUG 包仅用于开发和真机验收，不应作为正式发布包。

## 构建发布包

1. 准备发布者自己的 Keystore，并离线备份；后续版本必须使用同一证书签名。
2. 通过环境变量提供签名信息，不要把密码写入工程文件：

   ```bash
   export PH_ANDROID_STORE_FILE=/absolute/path/to/person-harness-release.jks
   export PH_ANDROID_STORE_PASSWORD=<Keystore 密码>
   export PH_ANDROID_KEY_ALIAS=<密钥别名>
   export PH_ANDROID_KEY_PASSWORD=<密钥密码>
   ./gradlew assembleRelease
   ```

   也可以在 Android Studio 中选择 **Build → Generate Signed App Bundle / APK** 完成签名。

3. 签名后的 APK 位于 `app/build/outputs/apk/release/app-release.apk`。
4. 在真实设备上完成安装、配对、对话与审批冒烟测试。
5. 将安装包及 SHA-256 校验值上传到 GitHub Release，不要提交到源码仓库。

Keystore、密码、`local.properties` 和所有构建输出均不得提交。

## 配对与使用

1. 在电脑项目根目录启动独立 Agent；首次使用生成配对码，例如：

   ```bash
   npm run kimi:pair -- --cwd "/path/to/workspace"
   ```

2. 在 Android App 中扫码或输入一次性配对码。
3. 选择 Agent 和工作区后开始对话。

手动配对码未携带服务器信息时，App 使用项目当前默认协调服务器；扫码配对以二维码中的服务器信息为准。

## 真机回归

确保 DEBUG App 已配对并停留在独立 Kimi 对话页，手机已开启 USB 调试，然后在项目根目录执行：

```bash
# 完整回归：UDP、连续对话、审批恢复与中继回落
npm run test:android-agent

# 多设备时指定 ADB 序列号
npm run test:android-agent -- --serial <设备序列号>

# 只验证中继连续对话
npm run test:android-agent -- --relay-only
```

ADB 可通过 `PATH`、`ANDROID_SDK_ROOT`／`ANDROID_HOME` 或 `--adb` 指定。报告写入本机 `diagnostics/`，不会进入仓库。

## 安全与兼容说明

- 中继只转发端到端密文；业务内容不依赖中继服务器解密。
- 当前版本使用 SharedPreferences 保存部分设备凭证，正式发布前宜迁移到 Android Keystore 加密存储。
- `applicationId` 与部分内部包名保留 `happyharness` 历史标识，用于兼容既有安装和配对数据。

## 目录

| 路径 | 说明 |
| --- | --- |
| `app/src/main/AndroidManifest.xml` | 权限、深链与前台服务 |
| `app/src/main/java/com/happyharness/app/MainActivity.kt` | 主界面与状态机 |
| `app/src/main/java/com/happyharness/app/relay/` | E2E、中继、UDP 与本地代理 |
| `app/src/main/java/com/happyharness/app/pair/` | v2 配对 |
| `app/src/main/java/com/happyharness/app/store/` | 本地设备与凭证存储 |
| `app/src/main/java/com/happyharness/app/service/` | 前台保活服务 |
