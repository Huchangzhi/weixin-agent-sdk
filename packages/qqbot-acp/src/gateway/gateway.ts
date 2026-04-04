import type { Agent } from "weixin-agent-sdk";
import { getAccessToken } from "./api.js";
import { processQQMessage } from "./process-message.js";
import { logger } from "../util/logger.js";

// QQ Bot intents
const INTENTS = {
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
  INTERACTION: 1 << 26,
};

const FULL_INTENTS = INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C | INTENTS.INTERACTION;

// Reconnect config
const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000, 60000];
const MAX_RECONNECT_ATTEMPTS = 100;

// Message deduplication: track processed message IDs to avoid duplicate processing
// Uses a Set for "currently processing" + a Map for "recently completed"
const processingMessages = new Set<string>();
const completedMessages = new Map<string, number>();
const MESSAGE_DEDUP_TTL_MS = 30_000; // 30 seconds

function tryAcquireMessage(messageId: string): boolean {
  const now = Date.now();

  // Clean up old completed entries
  for (const [id, timestamp] of completedMessages) {
    if (now - timestamp > MESSAGE_DEDUP_TTL_MS) {
      completedMessages.delete(id);
    }
  }

  // Check if already processing or recently completed
  if (processingMessages.has(messageId) || completedMessages.has(messageId)) {
    return false;
  }

  // Mark as processing
  processingMessages.add(messageId);
  return true;
}

function releaseMessage(messageId: string): void {
  processingMessages.delete(messageId);
  completedMessages.set(messageId, Date.now());
}

export interface QQBotGatewayOpts {
  appId: string;
  clientSecret: string;
  accountId: string;
  agent: Agent;
  abortSignal?: AbortSignal;
  log?: (msg: string) => void;
}

/**
 * Start QQ Bot Gateway WebSocket connection.
 * Long-polls for messages and dispatches to agent.
 */
export async function startQQBotGateway(opts: QQBotGatewayOpts): Promise<void> {
  const { appId, clientSecret, accountId, agent, abortSignal } = opts;
  const log = opts.log ?? console.log;

  if (!appId || !clientSecret) {
    throw new Error("QQ Bot not configured (missing appId or clientSecret)");
  }

  log(`[qqbot:${accountId}] Starting Gateway...`);

  // Dynamic import ws
  const { default: WebSocket } = await import("ws");

  let reconnectAttempts = 0;
  let isAborted = false;
  let currentWs: any = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let sessionId: string | null = null;
  let lastSeq: number | null = null;

  abortSignal?.addEventListener("abort", () => {
    isAborted = true;
    log(`[qqbot:${accountId}] Abort signal received, shutting down...`);
    if (currentWs) {
      currentWs.close();
    }
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
    }
  });

  async function connect(): Promise<void> {
    if (isAborted) return;

    try {
      log(`[qqbot:${accountId}] Connecting... (attempt ${reconnectAttempts + 1})`);

      // Get access token
      const accessToken = await getAccessToken(appId, clientSecret);
      log(`[qqbot:${accountId}] Access token obtained`);

      // Get gateway URL
      const gatewayUrl = await getGatewayUrl(accessToken);
      log(`[qqbot:${accountId}] Gateway URL: ${gatewayUrl}`);

      // Establish WebSocket
      const ws = new WebSocket(gatewayUrl);
      currentWs = ws;

      ws.on("open", () => {
        log(`[qqbot:${accountId}] WebSocket connected`);
        reconnectAttempts = 0;

        // Send identify
        const identifyPayload = {
          op: 2, // Identify
          d: {
            token: `QQBot ${accessToken}`,
            intents: FULL_INTENTS,
            shard: [0, 1],
          },
        };
        ws.send(JSON.stringify(identifyPayload));
        log(`[qqbot:${accountId}] Identify sent`);
      });

      ws.on("message", (data: any) => {
        try {
          const payload = JSON.parse(data.toString());
          handleGatewayPayload(payload, { ws, appId, clientSecret, accountId, agent, log });
        } catch (err) {
          logger.error(`[qqbot:${accountId}] Failed to parse message: ${err}`);
        }
      });

      ws.on("close", (code: number, reason: Buffer) => {
        log(`[qqbot:${accountId}] WebSocket closed: code=${code}, reason=${reason.toString()}`);
        currentWs = null;
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval);
          heartbeatInterval = null;
        }

        if (!isAborted) {
          scheduleReconnect();
        }
      });

      ws.on("error", (err: Error) => {
        logger.error(`[qqbot:${accountId}] WebSocket error: ${err.message}`);
      });

    } catch (err) {
      logger.error(`[qqbot:${accountId}] Connection failed: ${err}`);
      if (!isAborted) {
        scheduleReconnect();
      }
    }
  }

  function scheduleReconnect(): void {
    if (isAborted || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      log(`[qqbot:${accountId}] Max reconnect attempts reached, giving up`);
      return;
    }

    const delay = RECONNECT_DELAYS[Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1)];
    log(`[qqbot:${accountId}] Reconnecting in ${delay}ms... (${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS})`);

    setTimeout(() => {
      reconnectAttempts++;
      connect();
    }, delay);
  }

  await connect();

  // Block until aborted
  return new Promise((resolve) => {
    abortSignal?.addEventListener("abort", () => {
      resolve();
    });
  });
}

/**
 * Get gateway WebSocket URL from QQ API.
 */
async function getGatewayUrl(accessToken: string): Promise<string> {
  const API_BASE = "https://api.sgroup.qq.com";

  const response = await fetch(`${API_BASE}/gateway`, {
    headers: {
      Authorization: `QQBot ${accessToken}`,
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`Failed to get gateway URL: HTTP ${response.status} ${body}`);
  }

  const data = await response.json();
  if (!data.url) {
    throw new Error(`Gateway URL not found in response: ${JSON.stringify(data)}`);
  }

  return data.url;
}

/**
 * Handle gateway payload (messages from QQ).
 */
async function handleGatewayPayload(
  payload: any,
  ctx: {
    ws: any;
    appId: string;
    clientSecret: string;
    accountId: string;
    agent: Agent;
    log: (msg: string) => void;
  }
): Promise<void> {
  const { op, s, t, d } = payload;

  // Update sequence number
  if (s != null) {
    // seq can be used for session resume
  }

  switch (op) {
    case 10: // Hello
      // Start heartbeat
      const heartbeatInterval = d.heartbeat_interval;
      ctx.log(`[qqbot:${ctx.accountId}] Hello received, heartbeat interval: ${heartbeatInterval}ms`);
      startHeartbeat(ctx.ws, heartbeatInterval, ctx.log);
      break;

    case 11: // Heartbeat ACK
      break;

    case 0: // Dispatch
      if (t === "READY" || t === "RESUMED") {
        ctx.log(`[qqbot:${ctx.accountId}] ${t} event received, bot is ready`);
      }

      // Handle message events
      await handleMessageEvent(t, d, ctx);
      break;

    default:
      ctx.log(`[qqbot:${ctx.accountId}] Unknown opcode: ${op}`);
  }
}

/**
 * Start heartbeat to keep connection alive.
 */
function startHeartbeat(
  ws: any,
  interval: number,
  log: (msg: string) => void
): void {
  if (interval <= 0) return;

  const timer = setInterval(() => {
    if (ws.readyState === 1) { // WebSocket.OPEN
      ws.send(JSON.stringify({ op: 1, d: null }));
      log("[heartbeat] sent");
    }
  }, interval);

  // Store timer reference for cleanup
  (ws as any)._heartbeatTimer = timer;
}

/**
 * Handle message events from QQ.
 */
async function handleMessageEvent(
  eventType: string,
  event: any,
  ctx: {
    ws: any;
    appId: string;
    clientSecret: string;
    accountId: string;
    agent: Agent;
    log: (msg: string) => void;
  }
): Promise<void> {
  const { accountId, appId, clientSecret, agent, log } = ctx;

  switch (eventType) {
    case "C2C_MESSAGE_CREATE": {
      const msgId = event.id;
      if (!tryAcquireMessage(msgId)) {
        log(`[qqbot:${accountId}] SKIP duplicate C2C message: ${msgId}`);
        return;
      }
      log(`[qqbot:${accountId}] C2C message from: ${event.author?.user_openid}`);
      try {
        await processQQMessage({
          type: "c2c",
          senderId: event.author?.user_openid,
          content: event.content,
          messageId: event.id,
          timestamp: event.timestamp,
          attachments: event.attachments,
        }, { accountId, appId, clientSecret, agent, log });
      } finally {
        releaseMessage(msgId);
      }
      break;
    }

    case "GROUP_AT_MESSAGE_CREATE": {
      const msgId = event.id;
      if (!tryAcquireMessage(msgId)) {
        log(`[qqbot:${accountId}] SKIP duplicate GROUP message: ${msgId}`);
        return;
      }
      log(`[qqbot:${accountId}] Group @message from: ${event.author?.member_openid}, group: ${event.group_openid}`);
      try {
        await processQQMessage({
          type: "group",
          senderId: event.author?.member_openid,
          content: event.content,
          messageId: event.id,
          timestamp: event.timestamp,
          groupOpenid: event.group_openid,
          attachments: event.attachments,
          mentions: event.mentions,
        }, { accountId, appId, clientSecret, agent, log });
      } finally {
        releaseMessage(msgId);
      }
      break;
    }

    case "DIRECT_MESSAGE_CREATE": {
      const msgId = event.id;
      if (!tryAcquireMessage(msgId)) {
        log(`[qqbot:${accountId}] SKIP duplicate DM: ${msgId}`);
        return;
      }
      log(`[qqbot:${accountId}] Channel DM from: ${event.author?.user_openid}`);
      try {
        await processQQMessage({
          type: "dm",
          senderId: event.author?.user_openid,
          content: event.content,
          messageId: event.id,
          timestamp: event.timestamp,
          guildId: event.guild_id,
          attachments: event.attachments,
        }, { accountId, appId, clientSecret, agent, log });
      } finally {
        releaseMessage(msgId);
      }
      break;
    }

    case "AT_MESSAGE_CREATE": {
      const msgId = event.id;
      if (!tryAcquireMessage(msgId)) {
        log(`[qqbot:${accountId}] SKIP duplicate channel @message: ${msgId}`);
        return;
      }
      log(`[qqbot:${accountId}] Channel @message from: ${event.author?.user_openid}, channel: ${event.channel_id}`);
      try {
        await processQQMessage({
          type: "channel",
          senderId: event.author?.user_openid,
          content: event.content,
          messageId: event.id,
          timestamp: event.timestamp,
          channelId: event.channel_id,
          attachments: event.attachments,
          mentions: event.mentions,
        }, { accountId, appId, clientSecret, agent, log });
      } finally {
        releaseMessage(msgId);
      }
      break;
    }

    default:
      break;
  }
}
