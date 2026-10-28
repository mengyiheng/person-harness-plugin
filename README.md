# 智枢 Person Harness

> 把电脑里的 Agent，带进手机。

智枢连接本机 Agent、HarmonyOS / Android App 与 MCP 数据总线。工作区和文件留在电脑，手机接续对话、停止生成并处理工具审批；经过标准桥的文件检索和读取按授权执行，并留下本机台账。

[产品主页](http://8.137.177.62:9400/) · [功能详解](http://8.137.177.62:9400/features) · [多 Agent](http://8.137.177.62:9400/agents)

## 有什么

- **PC 插件 0.5.0**：设备配对、端到端加密隧道、工作区与会话、文件工具、MCP 数据总线。
- **两款手机 App**：HarmonyOS 与 Android 共享配对和加密协议，可切换工作区、恢复会话并使用远程工具。
- **8 家独立 Agent 配置**：Kimi Code、Claude Code、Codex、OpenCode、Pi、Qwen Code、Cursor CLI、Copilot CLI。
- **MCP 数据总线**：提供 `search_local_files` 与 `read_local_file` 两个标准工具，按宿主和文件策略授权并留痕。
- **本机工具箱**：文件与整文件夹互传、资源检索与预览、剪贴板同步、电脑截图、窗口实况与点击回传。

Agent 和文件始终运行、保存在自己的电脑上，无需把项目迁移到另一个平台。

## 快速开始：独立 Agent

独立 Agent 不依赖 dsh。每家使用自己的配置、身份、端口、工作区和会话，共享同一套配对与加密基础设施。

环境要求：Node.js ≥ 18、pnpm，以及待接入 Agent 自己的 CLI / SDK 和有效登录。

```bash
git clone https://github.com/mengyiheng/person-harness-plugin.git
cd person-harness-plugin
pnpm install
```

从 `agent-templates/` 复制一份配置，按本机路径修改 `command`、`cwd`、`home` 等字段。每份配置必须使用独立的 `name`、`port` 和 `home`。

| Agent | 驱动方式 | 配置模板 |
| --- | --- | --- |
| Kimi Code | ACP | `kimi-code.json` |
| Claude Code | Claude Agent SDK | `claude-code.json` |
| Codex | app-server / JSON-RPC | `codex.json` |
| OpenCode | HTTP / SSE | `opencode.json` |
| Pi | RPC | `pi.json` |
| Qwen Code | ACP | `qwen-code.json` |
| Cursor CLI | print / stream-json | `cursor-cli.json` |
| Copilot CLI | print / CLI | `copilot-cli.json` |

```bash
# 首次启动并生成该 Agent 自己的配对二维码
npm run agent:pair -- --config "D:\\path\\to\\my-agent.json"

# 已配对后日常启动
npm run agent -- --config "D:\\path\\to\\my-agent.json"

# 查看该配置的独立身份与状态
npm run agent:status -- --config "D:\\path\\to\\my-agent.json"
```

命令行的 `--name`、`--label`、`--port`、`--cwd`、`--home`、`--reg`、`--server` 可覆盖配置；重复传入 `--workspace "名称=目录"` 可配置多个工作区。`--no-tunnel` 仅用于本机测试，不能用于手机配对。

**当前真机状态：Kimi Code 已完成双端真机验证，其他 Agent 按登录和上游服务情况逐步开放。**

### Kimi Code 简写命令

```bash
npm run kimi:pair -- --cwd "D:\\path\\to\\workspace"
npm run kimi -- --cwd "D:\\path\\to\\workspace"
npm run kimi:status
```

Kimi 独立身份与会话默认保存在 `~/.ph/kimi-code/`。可执行文件不在 PATH 时追加 `--command "C:\\path\\to\\kimi.exe"`；也可用 `--kimi-home`、`--server`、`--port` 覆盖默认值。

## 手机 App 源码与构建

- HarmonyOS：见 `harmony-tunnel/README.md`。
- Android：见 `android-app/README.md`。

两个手机工程都包含在本仓库中。本机 SDK 路径、签名证书、密钥、构建缓存和安装包不进入源码仓库；正式发布时，签名后的 APK／HAP 与 SHA-256 校验值应附在 GitHub Release 中。
## 安装 dsh 插件：资源工具与 MCP 总线

只有使用 dsh 插件链路、资源工具或 MCP 数据总线时才需要本节。开始前请安装 dsh CLI / 桌面版、Node.js ≥ 18 与 pnpm。

```bash
# 1. 装进正在使用的 profile（web 或 desktop）
cd ~/.dsh/profiles/web
pnpm add github:mengyiheng/person-harness-plugin
```

编辑该 profile 的 `package.json`，在 `dsh.profile.bundles` 数组中追加：

```json
"person-harness-plugin"
```

在该 profile 的 `cordis.patch.yml` 末尾追加协调服务配置：

```yaml
- id: person-harness-relay
  config:
    server: http://8.137.177.62:9400
```

彻底重启对应实例，在 dsh 对话框执行 `/ph pair`，再用手机扫码或输入配对码。`/ph status` 可检查身份和隧道状态。

> 协调服务当前使用 `http://8.137.177.62:9400`。不要改用未备案域名的 HTTPS 地址；业务内容由端到端加密保护。

### 常用插件命令

| 命令 | 用途 |
| --- | --- |
| `/ph pair` | 生成一次性配对码与二维码 |
| `/ph data` | 打开资源索引、文件策略、审计与 MCP 监测台 |
| `/ph mcp` | 获取 MCP 标准桥接入配置 |
| `/ph devices` | 查看已配对设备 |
| `/ph revoke <pairId>` | 解除设备配对并撤回权限 |
| `/ph history` | 查看本机连接历史 |
| `/ph status` | 检查身份与隧道状态 |
| `/ph clean` | 只读分析 C 盘空间，不自动删除文件 |

## MCP 数据总线

标准桥向兼容 MCP 宿主提供两个本机文件工具：

- `search_local_files`：按关键词检索本机索引，结果按策略过滤。
- `read_local_file`：按授权读取文件，并记录允许、拒绝或错误结果。

文件分为公开、内部、敏感、禁碰四级。插件所在宿主必需接入，其他宿主由用户明确选择允许接入或不接入，可随时调整。

监测台的“MCP 接入”页可生成包含真实 Node、桥接脚本和数据目录的 `mcpServers` JSON。已知宿主可自动发现；未知宿主可登记现有 JSON 配置路径，授权后写入并保留 `.ph-backup`。仅生成或登记配置不会修改宿主文件，“配置已写入”也不等于“已收到标准桥握手”。

只使用 WorkBuddy 等 MCP 宿主时，不需要安装其他独立 Agent，但插件与总线仍由 dsh 安装和运行。WorkBuddy、OpenClaw、Clawdbot 等按 MCP 宿主管理，不等同于已有手机驱动的独立 Agent，具体版本兼容性需实机验证。

**监测边界：**台账只覆盖经过智枢标准桥的握手、检索、读取、拒绝和错误；桥外直接访问、其他旁路 MCP Server 与单纯安装行为不在监测范围内。

## 连接与安全

- Ed25519 验证设备身份，X25519 协商临时密钥，AES-256-GCM 保护会话和工具数据。
- 中继服务只转发端到端密文；无需手机号、邮箱或真实姓名。
- 适合的网络下可建立 UDP 业务直连，失败时回落 E2E 中继；实际能力取决于 NAT、运营商与当前网络环境。
- 索引、资源策略、MCP 台账和连接历史保存在本机；设备配对与 MCP 接入授权可以撤回。

## 目录

- `lib/index.js`：dsh 插件入口、身份与隧道、`/ph` 命令和配对页面。
- `lib/tunnel.mjs`：出站隧道客户端。
- `lib/adapter.mjs`：手机协议与 dsh 之间的适配。
- `lib/e2e.mjs`：端到端加密实现。
- `lib/identity.mjs`：设备身份与配对码。
- `lib/p4/agent.mjs`：配置驱动的独立 Agent 入口。
- `lib/p4/independent-agent.mjs`：独立轻壳、工作区、会话、审批和配对隧道。
- `agent-templates/`：8 家 Agent 与通用 ACP 配置模板。
- `lib/data-bus.mjs`、`lib/mcp-server.mjs`：本机资源策略与 MCP 标准桥。
- `lib/databus-ui.mjs`：数据总线监测台。
- `harmony-tunnel/`、`android-app/`：两款手机 App 工程。

dsh 多实例按 profile 分配身份，web / desktop 可同时运行且互不顶替。编程接入其他内核时，可通过 `startIndependentAgent({ driver, ... })` 复用独立 Agent 启动层。

## 致谢与灵感来源（Acknowledgments）

- [BleachBit](https://www.bleachbit.org/)（GPL-3.0）—— 磁盘清理模块的**声明式规则注册表**设计思路（含运行中进程保护、后果警告标注）启发自该项目。本项目的 `cleaners.json` 及全部规则为独立编写，未复制其任何代码或数据文件
- [WizTree](https://wiztreefree.com/) / [PatchCleaner](https://github.com/NullSlot/patchcleaner) 等工具的思路在 roadmap 中（NTFS MFT 快扫、孤儿补丁检测），尚未引用其代码
- 本项目许可与上述项目互相独立

## 使用条款与免责声明（Disclaimer）

**请仅在合法授权的范围内使用本软件：**

1. **授权使用**：本软件仅限用于你本人拥有所有权，或已获得设备所有人**明确书面授权**的电脑。使用远程控制功能前，请确认你已获设备所有人的许可。
2. **合法使用**：严禁将本软件用于任何违法违规用途，包括但不限于窃取、窥探、泄露他人的账号、隐私、商业秘密或其他受法律保护的信息与数据。
3. **责任归属**：你通过本软件在其配对设备上进行的一切操作，由操作者本人负责。因违反本条款或相关法律法规造成的任何后果，由使用者自行承担。
4. **数据边界**：本项目不存储、不接触你的会话明文——云端仅转发端到端密文（Ed25519 + X25519 + AES-256-GCM），直连模式下数据不经过服务器。本项目无能力也无法为任何用户的违规行为提供便利或背书。
5. **条款生效**：下载、编译、安装、配对或使用本软件任一功能，即视为你已阅读并同意本条款。若你不同意，请停止使用并删除本软件。

*正式开源发布时可补充英文对照版本；涉及法律效力的场景，以届时律师审阅的正式版本为准。*
