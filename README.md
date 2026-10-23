# happy-harness-plugin

DeepSeek Harness 插件：让手机 App（Happy Harness / 鸿蒙）通过公网中继访问本机 dsh 实例。

- 设备身份（Ed25519）+ 云端注册 + 出站隧道（手机 attach / E2E / 协议适配全部进程内完成）
- E2E 加密：Ed25519 身份 + X25519 临时密钥 + AES-256-GCM，中继只见密文
- `/happy pair` 一键配对：本机浏览器自动弹二维码，手机扫码即连
- `/happy devices` / `/happy revoke <id>` / `/happy status` 设备管理
- 凭证：browserAuth.secret 自签 v1 owner Cookie（进程内现铸，无状态）

## 安装（目标电脑）

```bash
# 1. 装进你在用的 profile（dsh plugin 是 pnpm 封装）
dsh plugin --profile <你的profile> add github:<你的用户名>/happy-harness-plugin

# 2. 注册为 bundle：编辑 ~/.dsh/profiles/<profile>/package.json
#    dsh.profile.bundles 数组追加 "happy-harness-plugin"

# 3. 配置服务器：该 profile 的 cordis.patch.yml 追加
#    - id: happy-harness-relay
#      config:
#        server: http://<云端IP>:9400

# 4. 重启该 profile 的 dsh 实例，对话里输入 /happy pair
```

> 🔴 server 不要写 https://happy-harness.cn:9443：域名未备案，大陆机房会按 ClientHello
> 指纹剥离/阻断 SNI（手机端、Node 原生 TLS 均中招）。明文 9400 + E2E 是当前稳妥方案。

## 目录

- `lib/index.js` — 入口：身份/隧道启动、/happy 命令、v1 Cookie 铸造、二维码页
- `lib/tunnel.mjs` — 出站隧道客户端（ws → 云端 → 手机 attach）
- `lib/adapter.mjs` — 手机协议适配（HTTP/WS 流 ↔ dsh，24KB 分块 + 8ms 节流防 ArkWS 丢帧）
- `lib/e2e.mjs` — E2E 密码学（与手机端 RelayE2E.ets 逐字对齐）
- `lib/identity.mjs` — 设备身份与配对码（存 ~/.dsh/happy-harness/<profile>/）

## 多实例

按 profile 分身份（web/desktop 互不顶替）：桌面版与命令行版同时运行时各自独立隧道；
配对码天然绑定签发它的实例。
