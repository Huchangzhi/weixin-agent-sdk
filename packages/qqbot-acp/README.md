# qqbot-acp

QQ Bot + ACP (Agent Client Protocol) 适配器 — 将任意 ACP agent 连接到 QQ。

## 功能

- 🔐 **Token 登录** — 使用 QQ 开放平台的 `appId:clientSecret` 一键登录
- 📨 **消息收发** — 支持 C2C 私聊、群聊 @机器人、频道私信、频道 @消息
- 🤖 **ACP 集成** — 兼容 Claude Code、Codex 等任意 ACP agent
- ⚡ **斜杠命令** — `/clear`、`/stop`、`/echo`、`/help`
- 🔄 **自动重连** — Gateway WebSocket 断线自动重连
- 💾 **凭证持久化** — 登录信息保存到本地，重启无需重新登录

## 快速开始

### 1. 安装

```bash
cd weixin-agent-sdk
pnpm install
```

### 2. 获取 QQ Bot Token

1. 前往 [QQ 开放平台](https://q.qq.com) 注册机器人
2. 在机器人设置中获取 `AppID` 和 `AppSecret`
3. Token 格式为：`appId:clientSecret`

### 3. 登录

```bash
npx qqbot-acp loginqq --token "1234567:ABCDE"
```

登录成功后，凭证会保存到 `~/.openclaw/openclaw-qqbot/accounts/`。

### 4. 启动

使用默认 agent（Claude Code）：

```bash
npx qqbot-acp startqq
```

使用自定义 agent：

```bash
npx qqbot-acp startqq -- node ./my-agent.js
```

## 命令参考

### `loginqq`

使用 Token 登录 QQ Bot。

```bash
npx qqbot-acp loginqq --token "<appId>:<clientSecret>"
```

**示例：**
```bash
npx qqbot-acp loginqq --token "1234567:ABCDE"
```

### `startqq`

启动 QQ Bot Gateway，连接 AI agent。

```bash
# 使用默认 agent
npx qqbot-acp startqq

# 使用指定 agent
npx qqbot-acp startqq -- claude-agent-acp
npx qqbot-acp startqq -- codex-acp
npx qqbot-acp startqq -- node ./my-agent.js
```

### `logout`

退出登录，清除所有凭证。

```bash
npx qqbot-acp logout
```

### 内置 agent 快捷命令

```bash
npx qqbot-acp claude-code    # 使用 Claude Code
npx qqbot-acp codex          # 使用 Codex
```

## QQ 中可用的斜杠命令

| 命令 | 说明 |
|------|------|
| `/clear` | 清空当前对话历史，开始新的对话 |
| `/stop` | 停止 AI 当前的回复（打断输出） |
| `/echo <msg>` | 直接回复消息（不经过 AI） |
| `/help` | 显示帮助信息 |

## 支持的消息类型

| 场景 | 事件 | 说明 |
|------|------|------|
| C2C 私聊 | `C2C_MESSAGE_CREATE` | 用户直接给机器人发私聊消息 |
| 群聊 @机器人 | `GROUP_AT_MESSAGE_CREATE` | 群内 @机器人 触发 |
| 频道私信 | `DIRECT_MESSAGE_CREATE` | 频道内私信机器人 |
| 频道 @消息 | `AT_MESSAGE_CREATE` | 频道内 @机器人 触发 |

## 架构

```
QQ 用户
  │
  ▼
[QQ 开放平台 WebSocket Gateway]
  │
  ▼
[qqbot-acp Gateway] ── 长连接接收消息
  │
  ▼
[消息处理器] ── 斜杠命令检测 → 媒体下载 → 构建 ChatRequest
  │
  ▼
[ACP Agent] ── Claude Code / Codex / 自定义 agent
  │
  ▼
[消息发送器] ── 文本回复 → QQ API → 返回给用户
```

## 凭证存储

登录后的凭证存储在：

```
~/.openclaw/openclaw-qqbot/
├── accounts.json              # 账号索引
└── accounts/
    └── <accountId>.json       # 单个账号的 appId 和 clientSecret
```

## 开发

```bash
# 类型检查
pnpm run typecheck

# 构建
pnpm run build

# 本地测试
pnpm run login -- --token "your:token"
pnpm run start
```

## 与 weixin-acp 的对比

| 特性 | weixin-acp | qqbot-acp |
|------|-----------|-----------|
| 登录方式 | 扫码登录 | Token 登录 |
| 消息接收 | HTTP 长轮询 | WebSocket Gateway |
| 连接协议 | 微信 ilink | QQ Bot Gateway |
| 斜杠命令 | ✅ | ✅ |
| ACP 集成 | ✅ | ✅ |

## License

MIT
