# 智枢 HarmonyOS App

智枢手机端采用 ArkUI + ArkWeb。App 通过配对凭证连接协调／中继服务，完成端到端加密握手后，由本地代理把电脑上的独立 Agent 轻量壳加载到 WebView。手机可切换 Agent 和工作区，接续会话、停止生成并处理工具审批；电脑端不需要运行 dsh。

## 当前能力

- v2 配对、设备选择与独立 Agent 切换。
- 工作区、会话、新建会话、停止与审批。
- Ed25519 设备身份、X25519 密钥协商、AES-256-GCM 业务加密。
- 适合网络下的 UDP 业务直连；失败或断线时回落端到端加密中继。
- 文件互传、剪贴板、截图、窗口实况与资料检索等 dsh 插件工具。

UDP 是否可用取决于 NAT、运营商和当前网络环境；中继可用不代表直连已经建立。

## 构建环境

- DevEco Studio 5.x。
- HarmonyOS API 26 SDK；`compatibleSdkVersion` 与 `targetSdkVersion` 均为 `26.0.0`。
- 一台用于真机调试的 HarmonyOS 手机；发布安装包需要开发者自己的签名证书和 Profile。

当前主链路不需要 Rust、WireGuard 或额外 NDK 构建。

## 构建与安装

1. 用 DevEco Studio 打开本目录，等待 Sync 完成。
2. 在 **File → Project Structure → Signing Configs** 中配置本机调试签名。
3. 连接手机并运行 `entry`，或选择 **Build → Build Hap(s)/APP(s)** 构建 HAP。
4. 发布 Release 包时使用自己的正式发布签名，不要提交证书、私钥、Profile 或密码。

`build-profile.json5` 只保留无签名的公开模板。本机签名配置、构建输出和 IDE 缓存均已加入 `.gitignore`。

## 配对与使用

1. 在电脑项目根目录启动需要使用的独立 Agent；首次使用执行配对命令，例如：

   ```bash
   npm run kimi:pair -- --cwd "/path/to/workspace"
   ```

2. 用手机扫码或输入一次性配对码。
3. 在 Agent 页选择对应服务和工作区，然后开始对话。

日常启动已配对服务可使用 `npm run kimi -- --cwd "/path/to/workspace"`。

## 真机回归

确保 DEBUG App 已配对并停留在独立 Kimi 对话页，电脑端服务正常运行，然后在项目根目录执行：

```bash
# 完整回归：UDP、连续对话、审批恢复与中继回落
npm run test:harmony-agent

# 多设备时指定 HDC 设备号
npm run test:harmony-agent -- --target <设备号>

# 只验证中继链路，不宣称 UDP 通过
npm run test:harmony-agent -- --relay-only --skip-approval
```

脚本会操作真实手机并产生 `diagnostics/` 报告，该目录不会进入仓库。HDC 可通过 `PATH`、`OHOS_SDK_HOME`／`DEVECO_SDK_HOME`、`HARMONY_HDC` 或 `--hdc` 指定。

## 目录

| 路径 | 说明 |
| --- | --- |
| `AppScope/app.json5` | 应用标识与版本 |
| `entry/src/main/module.json5` | Ability、后台模式和权限声明 |
| `entry/src/main/ets/pages/Index.ets` | 主界面与交互 |
| `entry/src/main/ets/chat/` | 配对、E2E、中继、UDP、代理与本地存储 |
| `entry/src/main/resources/` | 应用资源 |

包名 `com.happyharness.tunnel` 是为兼容既有配对和安装数据保留的历史标识，不代表当前品牌名称。
