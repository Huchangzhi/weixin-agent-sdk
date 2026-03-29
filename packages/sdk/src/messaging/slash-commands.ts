/**
 * Weixin 斜杠指令处理模块
 *
 * 支持的指令：
 * - /echo <message>         直接回复消息（不经过 AI），并附带通道耗时统计
 * - /toggle-debug           开关 debug 模式，启用后每条 AI 回复追加全链路耗时
 * - /clear                  清除当前会话，重新开始对话
 * - /help                   显示帮助信息
 * - /stop                   停止 AI 当前的回复（打断输出）
 */
import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";

import { toggleDebugMode, isDebugMode } from "./debug-mode.js";
import { sendMessageWeixin } from "./send.js";
import { stopOngoingRequest, hasOngoingRequest } from "./ongoing-requests.js";

export interface SlashCommandResult {
  /** 是否是斜杠指令（true 表示已处理，不需要继续走 AI） */
  handled: boolean;
  /** 是否应该跳过 agent.chat() 调用 */
  skipAgentCall?: boolean;
}

export interface SlashCommandContext {
  to: string;
  contextToken?: string;
  baseUrl: string;
  token?: string;
  accountId: string;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
  /** Called when /clear is invoked to reset the agent session. */
  onClear?: () => void;
}

/** 发送回复消息 */
async function sendReply(ctx: SlashCommandContext, text: string): Promise<void> {
  const opts: WeixinApiOptions & { contextToken?: string } = {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    contextToken: ctx.contextToken,
  };
  await sendMessageWeixin({ to: ctx.to, text, opts });
}

/** 处理 /echo 指令 */
async function handleEcho(
  ctx: SlashCommandContext,
  args: string,
  receivedAt: number,
  eventTimestamp?: number,
): Promise<void> {
  const message = args.trim();
  if (message) {
    await sendReply(ctx, message);
  }
  const eventTs = eventTimestamp ?? 0;
  const platformDelay = eventTs > 0 ? `${receivedAt - eventTs}ms` : "N/A";
  const timing = [
    "⏱ 通道耗时",
    `├ 事件时间：${eventTs > 0 ? new Date(eventTs).toISOString() : "N/A"}`,
    `├ 平台→插件：${platformDelay}`,
    `└ 插件处理：${Date.now() - receivedAt}ms`,
  ].join("\n");
  await sendReply(ctx, timing);
}

/** 发送帮助信息 */
const HELP_TEXT = `🤖 微信 AI 助手 - 可用命令 [版本：0.6.0-mod]

/clear        清空当前对话历史，开始新的对话
/help         显示此帮助信息
/stop         停止 AI 当前的回复（打断输出）⭐
/echo <msg>   直接回复消息（不经过 AI）
/toggle-debug 开关 debug 模式

直接发送消息即可与 AI 对话。

⭐ /stop 命令说明：
   当 AI 正在回复时发送 /stop，会立即中断 AI 的输出。
   必须在 AI 回复期间发送才有效。`;

async function handleHelp(ctx: SlashCommandContext): Promise<void> {
  await sendReply(ctx, HELP_TEXT);
}

/** 处理 /stop 指令 - 立即停止正在进行的 AI 请求 */
async function handleStop(ctx: SlashCommandContext): Promise<void> {
  const conversationId = ctx.to;
  
  logger.info(`[slash-command] /stop called for conversation=${conversationId}`);
  
  // 检查是否有正在进行的请求
  const hasOngoing = hasOngoingRequest(conversationId);
  logger.info(`[slash-command] hasOngoingRequest=${hasOngoing}`);
  
  if (hasOngoing) {
    const stopped = stopOngoingRequest(conversationId);
    logger.info(`[slash-command] stopOngoingRequest returned=${stopped}`);
    
    if (stopped) {
      await sendReply(ctx, "⏹️ 已停止 AI 回复。");
    } else {
      await sendReply(ctx, "⚠️ 停止失败，请再试一次。");
    }
  } else {
    await sendReply(ctx, "⚠️ 当前没有正在进行的 AI 回复。");
  }
}

/**
 * 尝试处理斜杠指令
 *
 * @returns handled=true 表示该消息已作为指令处理，不需要继续走 AI 管道
 */
export async function handleSlashCommand(
  content: string,
  ctx: SlashCommandContext,
  receivedAt: number,
  eventTimestamp?: number,
): Promise<SlashCommandResult> {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) {
    return { handled: false, skipAgentCall: false };
  }

  const spaceIdx = trimmed.indexOf(" ");
  const command = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  logger.info(`[weixin] Slash command: ${command}, args: ${args.slice(0, 50)}`);

  try {
    switch (command) {
      case "/echo":
        await handleEcho(ctx, args, receivedAt, eventTimestamp);
        return { handled: true, skipAgentCall: true };
      case "/toggle-debug": {
        const enabled = toggleDebugMode(ctx.accountId);
        await sendReply(
          ctx,
          enabled
            ? "Debug 模式已开启"
            : "Debug 模式已关闭",
        );
        return { handled: true, skipAgentCall: true };
      }
      case "/clear": {
        ctx.onClear?.();
        await sendReply(ctx, "✅ 会话已清除，重新开始对话");
        return { handled: true, skipAgentCall: true };
      }
      case "/help": {
        await handleHelp(ctx);
        return { handled: true, skipAgentCall: true };
      }
      case "/stop": {
        await handleStop(ctx);
        // /stop 命令需要跳过当前消息的 agent 调用，但不停止其他消息的处理
        return { handled: true, skipAgentCall: true };
      }
      default:
        return { handled: false, skipAgentCall: false };
    }
  } catch (err) {
    logger.error(`[weixin] Slash command error: ${String(err)}`);
    try {
      await sendReply(ctx, `❌ 指令执行失败：${String(err).slice(0, 200)}`);
    } catch {
      // 发送错误消息也失败了，只能记日志
    }
    return { handled: true, skipAgentCall: true };
  }
}
