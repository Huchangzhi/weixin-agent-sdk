import type { Agent, ChatRequest, ChatResponse } from "weixin-agent-sdk";
import { sendQQTextMessage } from "./api.js";
import { extractMediaFromEvent } from "./media-download.js";
import { logger } from "../util/logger.js";

// Slash command state
const stoppedConversations = new Set<string>();
const debugMode = new Set<string>();

export interface QQMessage {
  type: "c2c" | "group" | "dm" | "channel";
  senderId: string;
  content: string;
  messageId: string;
  timestamp: string | number;
  groupOpenid?: string;
  channelId?: string;
  guildId?: string;
  attachments?: Array<{
    content_type?: string;
    filename?: string;
    height?: number;
    width?: number;
    size?: number;
    url?: string;
  }>;
  mentions?: Array<{
    id?: string;
    username?: string;
    bot?: boolean;
  }>;
}

export interface ProcessMessageCtx {
  accountId: string;
  appId: string;
  clientSecret: string;
  agent: Agent;
  log: (msg: string) => void;
}

/**
 * Process a QQ message: slash command check → call agent → send reply.
 */
export async function processQQMessage(
  message: QQMessage,
  ctx: ProcessMessageCtx
): Promise<void> {
  const { accountId, appId, clientSecret, agent, log } = ctx;
  const { senderId, content, messageId, type, groupOpenid, channelId, guildId } = message;

  // Determine conversation ID
  let conversationId: string;
  let sendTarget: string;
  let sendTargetType: "c2c" | "group" | "dm" | "channel";

  switch (type) {
    case "c2c":
      conversationId = `c2c:${senderId}`;
      sendTarget = senderId;
      sendTargetType = "c2c";
      break;

    case "group":
      conversationId = `group:${groupOpenid}:${senderId}`;
      sendTarget = groupOpenid!;
      sendTargetType = "group";
      break;

    case "dm":
      conversationId = `dm:${guildId}:${senderId}`;
      sendTarget = guildId!;
      sendTargetType = "dm";
      break;

    case "channel":
      conversationId = `channel:${channelId}:${senderId}`;
      sendTarget = channelId!;
      sendTargetType = "channel";
      break;

    default:
      log(`[qqbot:${accountId}] Unknown message type: ${type}`);
      return;
  }

  // Check if stopped
  if (stoppedConversations.has(conversationId)) {
    log(`[qqbot:${accountId}] Conversation ${conversationId} is stopped, skipping`);
    return;
  }

  // Handle slash/hash commands
  if (content.startsWith("/") || content.startsWith("#")) {
    const handled = await handleSlashCommand(content, {
      appId,
      clientSecret,
      conversationId,
      sendTarget,
      sendTargetType,
      log,
      accountId,
      onClear: () => agent.clearSession?.(conversationId),
      onStop: () => {
        stoppedConversations.add(conversationId);
        if (agent.stop) {
          agent.stop(conversationId);
        }
      },
    });

    if (handled) {
      return;
    }
  }

  // Build chat request (with media if available)
  const media = await extractMediaFromEvent(
    message.attachments,
    `[qqbot:${accountId}]`,
  );

  const request: ChatRequest = {
    conversationId,
    text: content,
    media,
  };

  // Call agent
  try {
    log(`[qqbot:${accountId}] Calling agent.chat() for ${conversationId}`);
    const response = await agent.chat(request);

    // Send reply
    if (response.text) {
      log(`[qqbot:${accountId}] Sending response to ${conversationId}`);
      await sendQQTextMessage({
        appId,
        clientSecret,
        to: sendTarget,
        targetType: sendTargetType,
        text: response.text,
        msgId: messageId,
      });
    }
  } catch (err) {
    if (err instanceof Error && err.message === "stopped") {
      log(`[qqbot:${accountId}] Request was stopped for ${conversationId}`);
      return;
    }

    logger.error(`[qqbot:${accountId}] Agent error: ${err}`);
    try {
      await sendQQTextMessage({
        appId,
        clientSecret,
        to: sendTarget,
        targetType: sendTargetType,
        text: `⚠️ 处理消息失败：${err instanceof Error ? err.message : "未知错误"}`,
        msgId: messageId,
      });
    } catch (sendErr) {
      logger.error(`[qqbot:${accountId}] Error notice send failed: ${sendErr}`);
    }
  } finally {
    // Clear stopped state after processing
    stoppedConversations.delete(conversationId);
  }
}

/**
 * Handle slash commands.
 * Returns true if command was handled.
 */
async function handleSlashCommand(
  content: string,
  ctx: {
    appId: string;
    clientSecret: string;
    conversationId: string;
    sendTarget: string;
    sendTargetType: "c2c" | "group" | "dm" | "channel";
    log: (msg: string) => void;
    accountId: string;
    onClear?: () => void;
    onStop?: () => void;
  }
): Promise<boolean> {
  const { content: rawContent } = { content };
  const trimmed = rawContent.trim();
  const [command, ...args] = trimmed.slice(1).split(" ");
  const cmd = command.toLowerCase();

  switch (cmd) {
    case "help":
      await sendQQTextMessage({
        appId: ctx.appId,
        clientSecret: ctx.clientSecret,
        to: ctx.sendTarget,
        targetType: ctx.sendTargetType,
        text: `QQ Bot 可用命令：
/clear 或 #clear - 清空当前对话历史
/stop 或 #stop - 停止 AI 当前回复
/echo 或 #echo <msg> - 直接回复消息（不经过 AI）
/help 或 #help - 显示此帮助信息`,
      });
      return true;

    case "clear":
      ctx.onClear?.();
      await sendQQTextMessage({
        appId: ctx.appId,
        clientSecret: ctx.clientSecret,
        to: ctx.sendTarget,
        targetType: ctx.sendTargetType,
        text: "✅ 已清空当前对话历史",
      });
      return true;

    case "stop":
      ctx.onStop?.();
      await sendQQTextMessage({
        appId: ctx.appId,
        clientSecret: ctx.clientSecret,
        to: ctx.sendTarget,
        targetType: ctx.sendTargetType,
        text: "⏹️ 已停止 AI 当前回复",
      });
      return true;

    case "echo":
      const echoText = args.join(" ");
      if (echoText) {
        await sendQQTextMessage({
          appId: ctx.appId,
          clientSecret: ctx.clientSecret,
          to: ctx.sendTarget,
          targetType: ctx.sendTargetType,
          text: echoText,
        });
      }
      return true;

    default:
      // Not a recognized command
      return false;
  }
}
