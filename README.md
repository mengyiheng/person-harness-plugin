# person-harness-plugin

DeepSeek Harness 插件：让手机 App（Person Harness / 鸿蒙）通过公网中继访问本机 dsh 实例。

- 设备身份（Ed25519）+ 云端注册 + 出站隧道（手机 attach / E2E / 协议适配全部进程内完成）
- E2E 加密：Ed25519 身份 + X25519 临时密钥 + AES-256-GCM，中继只见密文
- `/ph pair` 一键配对：本机浏览器自动弹二维码，手机扫码即连
- `/ph devices` / `/ph revoke <id>` / `/ph status` 设备管理
- 凭证：browserAuth.secret 自签 v1 owner Cookie（进程内现铸，无状态）

## 安装（目标电脑）

```bash
# 1. 装进你在用的 profile（dsh plugin 是 pnpm 封装）
dsh plugin --profile <你的profile> add github:<你的用户名>/person-harness-plugin

# 2. 注册为 bundle：编辑 ~/.dsh/profiles/<profile>/package.json
#    dsh.profile.bundles 数组追加 "person-harness-plugin"

# 3. 配置服务器：该 profile 的 cordis.patch.yml 追加
#    - id: person-harness-relay
#      config:
#        server: http://<云端IP>:9400

# 4. 重启该 profile 的 dsh 实例，对话里输入 /ph pair
```

> 🔴 server 不要写 https://happy-harness.cn:9443：域名未备案，大陆机房会按 ClientHello
> 指纹剥离/阻断 SNI（手机端、Node 原生 TLS 均中招）。明文 9400 + E2E 是当前稳妥方案。

## 目录

- `lib/index.js` — 入口：身份/隧道启动、/ph 命令、v1 Cookie 铸造、二维码页
- `lib/tunnel.mjs` — 出站隧道客户端（ws → 云端 → 手机 attach）
- `lib/adapter.mjs` — 手机协议适配（HTTP/WS 流 ↔ dsh，24KB 分块 + 8ms 节流防 ArkWS 丢帧）
- `lib/e2e.mjs` — E2E 密码学（与手机端 RelayE2E.ets 逐字对齐）
- `lib/identity.mjs` — 设备身份与配对码（存 ~/.dsh/person-harness/<profile>/）

## 多实例

按 profile 分身份（web/desktop 互不顶替）：桌面版与命令行版同时运行时各自独立隧道；
配对码天然绑定签发它的实例。

## 功能（数据总线 + 磁盘清理）

- `/ph data` —— 资源管理器：本机文件全量索引、四级分级（公开/内部/敏感/禁碰）、每-agent 访问策略、访问台账与危险行为提醒。索引只存本机，检索结果按策略过滤
- `/ph mcp` —— MCP 标准桥：Claude Code / OpenCode 等任何 MCP 宿主接入本机检索，全部访问留痕
- `/ph clean` —— C 盘空间分析（只读）：可清理目标 / 目录大头 / 大而旧文件。**永不自动删除**，微信/QQ 等含个人数据的目录只报告不列入

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

