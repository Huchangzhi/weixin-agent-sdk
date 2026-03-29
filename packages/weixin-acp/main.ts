#!/usr/bin/env node

/**
 * WeChat + ACP (Agent Client Protocol) adapter.
 *
 * Usage:
 *   npx weixin-acp login                          # QR-code login
 *   npx weixin-acp claude-code                     # Start with Claude Code
 *   npx weixin-acp codex                           # Start with Codex
 *   npx weixin-acp start -- <command> [args...]    # Start with custom agent
 *
 * Examples:
 *   npx weixin-acp start -- node ./my-agent.js
 */

import { isLoggedIn, login, logout, start } from "weixin-agent-sdk";

import { AcpAgent } from "./src/acp-agent.js";

const PKG_VERSION = "0.6.0-mod"; // 修改版，支持/stop 打断

/** Built-in agent shortcuts */
const BUILTIN_AGENTS: Record<string, { command: string }> = {
  "claude-code": { command: "claude-agent-acp" },
  codex: { command: "codex-acp" },
};

const command = process.argv[2];

async function ensureLoggedIn() {
  if (!isLoggedIn()) {
    console.log("未检测到登录信息，请先扫码登录微信\n");
    await login();
  }
}

async function startAgent(acpCommand: string, acpArgs: string[] = []) {
  await ensureLoggedIn();

  const agent = new AcpAgent({ command: acpCommand, args: acpArgs });

  const ac = new AbortController();
  process.on("SIGINT", () => {
    console.log("\n正在停止...");
    agent.dispose();
    ac.abort();
  });
  process.on("SIGTERM", () => {
    agent.dispose();
    ac.abort();
  });

  return start(agent, { abortSignal: ac.signal });
}

async function main() {
  if (command === "login") {
    await login();
    return;
  }

  if (command === "logout") {
    logout();
    return;
  }

  if (command === "start") {
    const ddIndex = process.argv.indexOf("--");
    if (ddIndex === -1 || ddIndex + 1 >= process.argv.length) {
      console.error("错误：请在 -- 后指定 ACP agent 启动命令");
      console.error("示例：npx weixin-acp start -- codex-acp");
      process.exit(1);
    }

    const [acpCommand, ...acpArgs] = process.argv.slice(ddIndex + 1);
    await startAgent(acpCommand, acpArgs);
    return;
  }

  if (command && command in BUILTIN_AGENTS) {
    const { command: acpCommand } = BUILTIN_AGENTS[command];
    await startAgent(acpCommand);
    return;
  }

  console.log(`weixin-acp — 微信 + ACP 适配器 [版本：${PKG_VERSION}]

用法:
  npx weixin-acp login                          扫码登录微信
  npx weixin-acp logout                         退出登录
  npx weixin-acp claude-code                    使用 Claude Code
  npx weixin-acp codex                          使用 Codex
  npx weixin-acp start -- <command> [args...]   使用自定义 agent

示例:
  npx weixin-acp start -- node ./my-agent.js

微信中可用的斜杠命令:
  /clear        清空当前对话历史，开始新的对话
  /help         显示此帮助信息
  /stop         停止 AI 当前的回复（打断输出）⭐
  /echo <msg>   直接回复消息（不经过 AI）
  /toggle-debug 开关 debug 模式

⭐ /stop 命令说明：
  当 AI 正在回复时发送 /stop，会立即中断 AI 的输出并杀死进程。
  已生成但未发送的内容会被丢弃。`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
