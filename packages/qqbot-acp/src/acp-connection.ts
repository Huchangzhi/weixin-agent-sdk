import type { ChildProcess } from "node:child_process";
import { execSync } from "node:child_process";
import spawn from "cross-spawn";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk";
import type { SessionId } from "@agentclientprotocol/sdk";

import type { AcpAgentOptions } from "./types.js";
import { ResponseCollector } from "./response-collector.js";
import { logger } from "./util/logger.js";

function describeToolCall(update: {
  title?: string | null;
  kind?: string | null;
  toolCallId?: string;
}): string {
  return update.title ?? update.kind ?? update.toolCallId ?? "tool";
}

/**
 * Manages the ACP agent subprocess and ClientSideConnection lifecycle.
 */
export class AcpConnection {
  private process: ChildProcess | null = null;
  private connection: ClientSideConnection | null = null;
  private ready = false;
  private collectors = new Map<SessionId, ResponseCollector>();
  /** Track ongoing prompts per session for cancellation */
  private ongoingPrompts = new Map<SessionId, { abortController: AbortController; reject?: (err: Error) => void }>();

  private onExit?: () => void;

  constructor(private options: AcpAgentOptions, onExit?: () => void) {
    this.onExit = onExit;
  }

  registerCollector(sessionId: SessionId, collector: ResponseCollector): void {
    logger.info(`[acp] registerCollector: session=${sessionId}`);
    this.collectors.set(sessionId, collector);
  }

  unregisterCollector(sessionId: SessionId): void {
    logger.info(`[acp] unregisterCollector: session=${sessionId}`);
    this.collectors.delete(sessionId);
    this.ongoingPrompts.delete(sessionId);
  }

  registerOngoingPrompt(sessionId: SessionId, abortController: AbortController): void {
    const entry = { abortController };
    this.ongoingPrompts.set(sessionId, entry);

    abortController.signal.addEventListener('abort', () => {
      logger.info(`[acp] abort signal received for session=${sessionId}`);
      entry.reject?.(new Error('stopped'));
    }, { once: true });
  }

  unregisterOngoingPrompt(sessionId: SessionId): void {
    this.ongoingPrompts.delete(sessionId);
  }

  /**
   * Kill the subprocess - exposed for external stop command
   */
  killProcess(): void {
    if (this.process) {
      logger.info("[acp] killProcess: killing subprocess and all children");

      if (process.platform === 'win32') {
        try {
          const pid = this.process.pid;
          if (pid) {
            execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
            logger.info(`[acp] killProcess: killed process tree for pid=${pid}`);
          }
        } catch (err) {
          logger.info(`[acp] killProcess: taskkill failed, trying kill(): ${String(err)}`);
          this.process.kill();
        }
      } else {
        try {
          process.kill(-this.process.pid!, 'SIGTERM');
          logger.info(`[acp] killProcess: killed process group for pid=${this.process.pid}`);
        } catch {
          this.process.kill();
        }
      }

      this.process = null;
    }
    this.ready = false;
    this.connection = null;

    this.ongoingPrompts.clear();
    this.collectors.clear();

    this.onExit?.();
  }

  /**
   * Cancel an ongoing prompt for a session
   */
  cancelPrompt(sessionId: SessionId): boolean {
    logger.info(`[acp] cancelPrompt called: session=${sessionId}`);

    const ongoing = this.ongoingPrompts.get(sessionId);
    if (!ongoing) {
      logger.info(`[acp] cancelPrompt: no ongoing prompt found for session=${sessionId}`);
      return false;
    }

    logger.info(`[acp] cancelPrompt: aborting prompt for session=${sessionId}`);
    ongoing.abortController.abort();

    // Kill and restart the subprocess to ensure clean state
    logger.info(`[acp] cancelPrompt: killing subprocess for session=${sessionId}`);
    this.killProcess();
    return true;
  }

  /**
   * Ensure the subprocess is running and the connection is initialized.
   */
  async ensureReady(): Promise<ClientSideConnection> {
    if (this.ready && this.connection) {
      return this.connection;
    }

    const args = this.options.args ?? [];
    logger.info(`[acp] spawning: ${this.options.command} ${args.join(" ")}`);

    const proc = spawn(this.options.command, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...this.options.env },
      cwd: this.options.cwd,
    });
    this.process = proc;

    proc.on("exit", (code) => {
      logger.info(`[acp] subprocess exited (code=${code})`);
      this.ready = false;
      this.connection = null;
      this.process = null;

      for (const [sessionId, ongoing] of this.ongoingPrompts) {
        logger.info(`[acp] rejecting ongoing prompt for session=${sessionId} due to subprocess exit`);
        ongoing.reject?.(new Error(`subprocess exited (code=${code})`));
      }
      this.ongoingPrompts.clear();
      this.collectors.clear();

      this.onExit?.();
    });

    const writable = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;
    const readable = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
    const stream = ndJsonStream(writable, readable);

    const conn = new ClientSideConnection((_agent) => ({
      sessionUpdate: async (params) => {
        const update = params.update;
        switch (update.sessionUpdate) {
          case "tool_call":
            logger.info(`[acp] tool_call: ${describeToolCall(update)} (${update.status ?? "started"})`);
            break;
          case "tool_call_update":
            if (update.status) {
              logger.info(`[acp] tool_call_update: ${describeToolCall(update)} → ${update.status}`);
            }
            break;
          case "agent_thought_chunk":
            if (update.content.type === "text") {
              logger.info(`[acp] thinking: ${update.content.text.slice(0, 100)}`);
            }
            break;
        }
        const collector = this.collectors.get(params.sessionId);
        if (collector) {
          collector.handleUpdate(params);
        }
      },
      requestPermission: async (params) => {
        const firstOption = params.options[0];
        logger.info(
          `[acp] permission: auto-approved "${firstOption?.name ?? "allow"}" (${firstOption?.optionId ?? "unknown"})`,
        );
        return {
          outcome: {
            outcome: "selected" as const,
            optionId: firstOption?.optionId ?? "allow",
          },
        };
      },
    }), stream);

    logger.info("[acp] initializing connection...");
    await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "qqbot-acp", version: "0.1.0" },
      clientCapabilities: {},
    });
    logger.info("[acp] connection initialized");

    this.connection = conn;
    this.ready = true;
    return conn;
  }

  /**
   * Kill the subprocess and clean up.
   */
  dispose(): void {
    this.ready = false;
    this.collectors.clear();
    this.ongoingPrompts.clear();
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.connection = null;
  }
}
