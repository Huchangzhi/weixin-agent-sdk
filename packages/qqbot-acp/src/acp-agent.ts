import fs from "node:fs/promises";
import type { Agent, ChatRequest, ChatResponse } from "weixin-agent-sdk";
import type { SessionId } from "@agentclientprotocol/sdk";

import type { AcpAgentOptions } from "./types.js";
import { AcpConnection } from "./acp-connection.js";
import { ResponseCollector } from "./response-collector.js";
import { logger } from "./util/logger.js";

/** Track conversations that should be stopped */
const stoppedConversations = new Map<string, boolean>();

/**
 * Agent adapter that bridges ACP (Agent Client Protocol) agents
 * to the weixin-agent-sdk Agent interface.
 */
export class AcpAgent implements Agent {
  private connection: AcpConnection;
  private sessions = new Map<string, SessionId>();
  /** Track the current chat promise for each conversation to allow interruption */
  private currentChatAbort = new Map<string, AbortController>();

  constructor(options: AcpAgentOptions) {
    this.connection = new AcpConnection(options, () => {
      logger.info("[acp] subprocess exited, clearing session cache");
      this.sessions.clear();
      this.currentChatAbort.clear();
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const conversationId = request.conversationId;

    // Check if this conversation was stopped before we even started
    if (stoppedConversations.get(conversationId)) {
      logger.info(`[acp] conversation ${conversationId} was stopped (pre-check), aborting`);
      throw new Error('stopped');
    }

    const conn = await this.connection.ensureReady();

    // Create abort controller for this chat
    const abortController = new AbortController();
    this.currentChatAbort.set(conversationId, abortController);

    // Get or create an ACP session for this conversation
    const sessionId = await this.getOrCreateSession(conversationId, conn);

    // Check again after session creation
    if (stoppedConversations.get(conversationId)) {
      logger.info(`[acp] conversation ${conversationId} was stopped (post-session), aborting`);
      this.currentChatAbort.delete(conversationId);
      throw new Error('stopped');
    }

    // Build content blocks from the request
    const blocks = await buildContentBlocks(request);
    if (blocks.length === 0) {
      this.currentChatAbort.delete(conversationId);
      return { text: "" };
    }

    // Register a collector, send the prompt, then gather the response
    const preview = request.text?.slice(0, 50) || (request.media ? `[${request.media.type}]` : "");
    logger.info(`[acp] prompt: "${preview}" (session=${sessionId})`);

    const collector = new ResponseCollector();
    this.connection.registerCollector(sessionId, collector);

    try {
      logger.info(`[acp] calling conn.prompt() for conversation=${conversationId}`);

      // Create a promise that rejects when the abort signal is triggered
      const abortPromise = new Promise<never>((_, reject) => {
        abortController.signal.addEventListener('abort', () => {
          logger.info(`[acp] abort signal triggered for conversation=${conversationId}`);
          reject(new Error('stopped'));
        }, { once: true });
      });

      // Race between prompt completion and abort signal
      await Promise.race([
        conn.prompt({ sessionId, prompt: blocks }),
        abortPromise,
      ]);

      logger.info(`[acp] conn.prompt() completed for conversation=${conversationId}`);
    } catch (err) {
      logger.info(`[acp] conn.prompt() was interrupted: ${String(err)}`);
      throw new Error('stopped');
    } finally {
      this.connection.unregisterCollector(sessionId);
      this.currentChatAbort.delete(conversationId);
    }

    const response = await collector.toResponse();
    logger.info(`[acp] response: ${response.text?.slice(0, 80) ?? "[no text]"}${response.media ? " +media" : ""}`);
    return response;
  }

  private async getOrCreateSession(
    conversationId: string,
    conn: Awaited<ReturnType<AcpConnection["ensureReady"]>>,
  ): Promise<SessionId> {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;

    logger.info(`[acp] creating new session for conversation=${conversationId}`);
    const res = await conn.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    logger.info(`[acp] session created: ${res.sessionId}`);
    this.sessions.set(conversationId, res.sessionId);
    return res.sessionId;
  }

  /**
   * Clear/reset the session for a given conversation.
   */
  clearSession(conversationId: string): void {
    const sessionId = this.sessions.get(conversationId);
    if (sessionId) {
      logger.info(`[acp] clearing session for conversation=${conversationId} (session=${sessionId})`);
      this.connection.unregisterCollector(sessionId);
      this.sessions.delete(conversationId);
    }
  }

  /**
   * Stop the current ongoing response for a given conversation.
   */
  stop(conversationId: string): void {
    logger.info(`[acp] stop called for conversation=${conversationId}`);

    // Mark as stopped
    stoppedConversations.set(conversationId, true);

    // Abort the current chat promise
    const abortController = this.currentChatAbort.get(conversationId);
    if (abortController) {
      logger.info(`[acp] aborting current chat for conversation=${conversationId}`);
      abortController.abort();
    }

    // Kill the entire subprocess
    logger.info(`[acp] killing subprocess for conversation=${conversationId}`);
    this.connection.killProcess();

    // Clear sessions to force restart
    this.sessions.clear();
    this.currentChatAbort.clear();

    // Clear the stop flag after a delay
    setTimeout(() => {
      stoppedConversations.delete(conversationId);
      logger.info(`[acp] cleared stop flag for conversation=${conversationId}`);
    }, 3000);
  }

  /**
   * Kill the ACP subprocess and clean up all sessions.
   */
  dispose(): void {
    this.sessions.clear();
    this.currentChatAbort.clear();
    this.connection.dispose();
  }
}

/**
 * Build ACP ContentBlock[] from a ChatRequest.
 * Reads local media files and converts to base64.
 */
async function buildContentBlocks(request: ChatRequest): Promise<Array<
  { type: "text"; text: string } |
  { type: "image"; data: string; mimeType: string } |
  { type: "resource"; resource: { uri: string; blob: string; mimeType: string } }
>> {
  const blocks: Array<any> = [];

  if (request.text) {
    blocks.push({ type: "text", text: request.text });
  }

  if (request.media) {
    try {
      const data = await fs.readFile(request.media.filePath);
      const base64 = data.toString("base64");
      const mimeType = request.media.mimeType;

      switch (request.media.type) {
        case "image":
          blocks.push({ type: "image", data: base64, mimeType });
          break;

        case "audio":
        case "video":
        case "file": {
          const uri = `file://${request.media.filePath}`;
          blocks.push({
            type: "resource",
            resource: { uri, blob: base64, mimeType },
          });
          break;
        }
      }
    } catch (err) {
      logger.error(`[acp] failed to read media file: ${request.media.filePath} — ${err}`);
      // Still include text description as fallback
      blocks.push({ type: "text", text: `[${request.media.type}: ${request.media.filePath}]` });
    }
  }

  return blocks;
}
