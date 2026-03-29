import type { Agent, ChatRequest, ChatResponse } from "weixin-agent-sdk";
import type { SessionId } from "@agentclientprotocol/sdk";

import type { AcpAgentOptions } from "./types.js";
import { AcpConnection } from "./acp-connection.js";
import { convertRequestToContentBlocks } from "./content-converter.js";
import { ResponseCollector } from "./response-collector.js";

function log(msg: string) {
  console.log(`[acp] ${msg}`);
}

/** Track conversations that should be stopped */
const stoppedConversations = new Map<string, boolean>();

/**
 * Agent adapter that bridges ACP (Agent Client Protocol) agents
 * to the weixin-agent-sdk Agent interface.
 */
export class AcpAgent implements Agent {
  private connection: AcpConnection;
  private sessions = new Map<string, SessionId>();
  private options: AcpAgentOptions;
  /** Track the current chat promise for each conversation to allow interruption */
  private currentChatAbort = new Map<string, AbortController>();

  constructor(options: AcpAgentOptions) {
    this.options = options;
    this.connection = new AcpConnection(options, () => {
      log("subprocess exited, clearing session cache");
      this.sessions.clear();
      this.currentChatAbort.clear();
    });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const conversationId = request.conversationId;
    
    // Check if this conversation was stopped before we even started
    if (stoppedConversations.get(conversationId)) {
      log(`[chat] conversation ${conversationId} was stopped (pre-check), aborting`);
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
      log(`[chat] conversation ${conversationId} was stopped (post-session), aborting`);
      this.currentChatAbort.delete(conversationId);
      throw new Error('stopped');
    }

    // Convert the ChatRequest to ACP ContentBlock[]
    const blocks = await convertRequestToContentBlocks(request);
    if (blocks.length === 0) {
      this.currentChatAbort.delete(conversationId);
      return { text: "" };
    }

    // Register a collector, send the prompt, then gather the response
    const preview = request.text?.slice(0, 50) || (request.media ? `[${request.media.type}]` : "");
    log(`prompt: "${preview}" (session=${sessionId})`);

    const collector = new ResponseCollector();
    this.connection.registerCollector(sessionId, collector);
    
    try {
      log(`[chat] calling conn.prompt() for conversation=${conversationId}`);
      
      // Create a promise that rejects when the abort signal is triggered
      const abortPromise = new Promise<never>((_, reject) => {
        abortController.signal.addEventListener('abort', () => {
          log(`[chat] abort signal triggered for conversation=${conversationId}`);
          reject(new Error('stopped'));
        }, { once: true });
      });
      
      // Race between prompt completion and abort signal
      await Promise.race([
        conn.prompt({ sessionId, prompt: blocks }),
        abortPromise,
      ]);
      
      log(`[chat] conn.prompt() completed for conversation=${conversationId}`);
    } catch (err) {
      log(`[chat] conn.prompt() was interrupted: ${String(err)}`);
      throw new Error('stopped');
    } finally {
      this.connection.unregisterCollector(sessionId);
      this.currentChatAbort.delete(conversationId);
    }

    const response = await collector.toResponse();
    log(`response: ${response.text?.slice(0, 80) ?? "[no text]"}${response.media ? " +media" : ""}`);
    return response;
  }

  private async getOrCreateSession(
    conversationId: string,
    conn: Awaited<ReturnType<AcpConnection["ensureReady"]>>,
  ): Promise<SessionId> {
    const existing = this.sessions.get(conversationId);
    if (existing) return existing;

    log(`creating new session for conversation=${conversationId}`);
    const res = await conn.newSession({
      cwd: this.options.cwd ?? process.cwd(),
      mcpServers: [],
    });
    log(`session created: ${res.sessionId}`);
    this.sessions.set(conversationId, res.sessionId);
    return res.sessionId;
  }

  /**
   * Clear/reset the session for a given conversation.
   * The next message will automatically create a fresh session.
   */
  clearSession(conversationId: string): void {
    const sessionId = this.sessions.get(conversationId);
    if (sessionId) {
      log(`clearing session for conversation=${conversationId} (session=${sessionId})`);
      this.connection.unregisterCollector(sessionId);
      this.sessions.delete(conversationId);
    }
  }

  /**
   * Stop the current ongoing response for a given conversation.
   * This kills the entire ACP subprocess and clears all state.
   */
  stop(conversationId: string): void {
    log(`[stop] called for conversation=${conversationId}`);
    
    // Mark as stopped - this will be checked by chat()
    stoppedConversations.set(conversationId, true);
    
    // Abort the current chat promise
    const abortController = this.currentChatAbort.get(conversationId);
    if (abortController) {
      log(`[stop] aborting current chat for conversation=${conversationId}`);
      abortController.abort();
    }
    
    // Kill the entire subprocess - this is the most reliable way to stop
    log(`[stop] killing entire subprocess for conversation=${conversationId}`);
    this.connection.killProcess();
    
    // Clear sessions to force restart
    this.sessions.clear();
    this.currentChatAbort.clear();
    
    // Clear the stop flag after a delay to allow the interrupted request to complete cleanup
    setTimeout(() => {
      stoppedConversations.delete(conversationId);
      log(`[stop] cleared stop flag for conversation=${conversationId}`);
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
