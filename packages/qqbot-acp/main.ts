#!/usr/bin/env node

/**
 * QQ Bot + ACP (Agent Client Protocol) adapter.
 *
 * Usage:
 *   npx qqbot-acp loginqq --token "appId:clientSecret"     # Login with token
 *   npx qqbot-acp startqq                                  # Start with default agent
 *   npx qqbot-acp startqq -- <command> [args...]           # Start with custom agent
 *
 * Examples:
 *   npx qqbot-acp loginqq --token "1234567:ABCDE"
 *   npx qqbot-acp startqq
 *   npx qqbot-acp startqq -- claude-agent-acp
 */

import { AcpAgent } from "./src/acp-agent.js";
import { loginQQBot, logoutQQBot, isQQBotLoggedIn } from "./src/auth/login.js";
import { listQQBotAccountIds, resolveQQBotAccount } from "./src/auth/accounts.js";
import { startQQBotGateway } from "./src/gateway/gateway.js";
import { getAccessToken } from "./src/gateway/api.js";

const PKG_VERSION = "0.1.0";

/** Built-in agent shortcuts */
const BUILTIN_AGENTS: Record<string, { command: string }> = {
  "claude-code": { command: "claude-agent-acp" },
  codex: { command: "codex-acp" },
};

const command = process.argv[2];

async function ensureLoggedIn() {
  if (!isQQBotLoggedIn()) {
    console.log("未检测到 QQ Bot 配置，请先运行 loginqq\n");
    console.log("用法: npx qqbot-acp loginqq --token \"appId:clientSecret\"");
    console.log("示例: npx qqbot-acp loginqq --token \"1234567:ABCDE\"\n");
    process.exit(1);
  }
}

async function startAgent(acpCommand: string, acpArgs: string[] = []) {
  await ensureLoggedIn();

  // Resolve account
  const ids = listQQBotAccountIds();
  if (ids.length === 0) {
    throw new Error("没有已配置的 QQ Bot 账号，请先运行 loginqq");
  }

  const accountId = ids[0];
  const account = resolveQQBotAccount(accountId);

  if (!account.configured) {
    throw new Error(`账号 ${accountId} 未配置 (缺少 appId 或 clientSecret)`);
  }

  console.log(`[qqbot] 启动 bot, account=${account.accountId}`);

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

  return startQQBotGateway({
    appId: account.appId,
    clientSecret: account.clientSecret,
    accountId: account.accountId,
    agent,
    abortSignal: ac.signal,
  });
}

async function main() {
  // loginqq command
  if (command === "loginqq") {
    const tokenIndex = process.argv.indexOf("--token");
    if (tokenIndex === -1 || tokenIndex + 1 >= process.argv.length) {
      console.error("错误：请提供 --token 参数");
      console.error("示例: npx qqbot-acp loginqq --token \"appId:clientSecret\"");
      process.exit(1);
    }

    const token = process.argv[tokenIndex + 1];
    const result = await loginQQBot({ token });
    
    if (!result.connected) {
      console.error(`\n❌ 登录失败：${result.message}`);
      process.exit(1);
    }
    return;
  }

  // logout command
  if (command === "logout") {
    logoutQQBot();
    return;
  }

  // startqq command
  if (command === "startqq") {
    const ddIndex = process.argv.indexOf("--");
    if (ddIndex !== -1 && ddIndex + 1 < process.argv.length) {
      // Custom agent
      const [acpCommand, ...acpArgs] = process.argv.slice(ddIndex + 1);
      await startAgent(acpCommand, acpArgs);
    } else {
      // Use first builtin agent
      const [acpCommand] = Object.values(BUILTIN_AGENTS)[0].command.split(" ");
      await startAgent(acpCommand);
    }
    return;
  }

  // Builtin agents
  if (command && command in BUILTIN_AGENTS) {
    const { command: acpCommand } = BUILTIN_AGENTS[command];
    await startAgent(acpCommand);
    return;
  }

  // Help
  console.log(`qqbot-acp — QQ Bot + ACP 适配器 [版本：${PKG_VERSION}]

用法:
  npx qqbot-acp loginqq --token <token>        使用 Token 登录 QQ Bot
  npx qqbot-acp logout                         退出登录
  npx qqbot-acp startqq                        使用默认 agent 启动
  npx qqbot-acp claude-code                    使用 Claude Code
  npx qqbot-acp codex                          使用 Codex
  npx qqbot-acp startqq -- <command> [args...] 使用自定义 agent

示例:
  npx qqbot-acp loginqq --token "1234567:ABCDE"
  npx qqbot-acp startqq
  npx qqbot-acp startqq -- node ./my-agent.js

QQ 中可用的斜杠命令:
  /clear        清空当前对话历史，开始新的对话
  /help         显示此帮助信息
  /stop         停止 AI 当前的回复（打断输出）
  /echo <msg>   直接回复消息（不经过 AI）

Token 说明:
  Token 格式为 "appId:clientSecret"
  可从 QQ 开放平台 (https://q.qq.com) 获取`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
