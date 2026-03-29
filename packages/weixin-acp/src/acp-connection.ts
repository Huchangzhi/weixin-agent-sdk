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

function log(msg: string) {
  console.log(`[acp] ${msg}`);
}

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
    log(`registerCollector: session=${sessionId}`);
    this.collectors.set(sessionId, collector);
  }

  unregisterCollector(sessionId: SessionId): void {
    log(`unregisterCollector: session=${sessionId}`);
    this.collectors.delete(sessionId);
    this.ongoingPrompts.delete(sessionId);
  }

  registerOngoingPrompt(sessionId: SessionId, abortController: AbortController): void {
    const entry = { abortController };
    this.ongoingPrompts.set(sessionId, entry);
    
    // Listen for abort signal to reject the prompt
    abortController.signal.addEventListener('abort', () => {
      log(`abort signal received for session=${sessionId}`);
      entry.reject?.(new Error('stopped'));
    }, { once: true });
  }

  unregisterOngoingPrompt(sessionId: SessionId): void {
    this.ongoingPrompts.delete(sessionId);
  }

  /**
   * Kill the subprocess - exposed for external stop command
   * This kills the entire process tree to ensure complete stop
   */
  killProcess(): void {
    if (this.process) {
      log("killProcess: killing subprocess and all children");
      
      // On Windows, use taskkill to kill the entire process tree
      if (process.platform === 'win32') {
        try {
          const pid = this.process.pid;
          if (pid) {
            execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' });
            log(`killProcess: killed process tree for pid=${pid}`);
          }
        } catch (err) {
          log(`killProcess: taskkill failed, trying kill(): ${String(err)}`);
          this.process.kill();
        }
      } else {
        // On Unix, send SIGTERM to the process group
        try {
          process.kill(-this.process.pid!, 'SIGTERM');
          log(`killProcess: killed process group for pid=${this.process.pid}`);
        } catch {
          this.process.kill();
        }
      }
      
      this.process = null;
    }
    this.ready = false;
    this.connection = null;
    
    // Clear all state so next ensureReady() will restart fresh
    this.ongoingPrompts.clear();
    this.collectors.clear();
    
    // Trigger onExit callback
    this.onExit?.();
  }

  /**
   * Cancel an ongoing prompt for a session (used by /stop command)
   */
  cancelPrompt(sessionId: SessionId): boolean {
    log(`cancelPrompt called: session=${sessionId}`);
    
    const ongoing = this.ongoingPrompts.get(sessionId);
    if (!ongoing) {
      log(`cancelPrompt: no ongoing prompt found for session=${sessionId}`);
      return false;
    }
    
    log(`cancelPrompt: aborting prompt for session=${sessionId}`);
    ongoing.abortController.abort();
    // Don't delete - let the abort handler clean up

    // Kill and restart the subprocess to ensure clean state
    log(`cancelPrompt: killing subprocess for session=${sessionId}`);
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
    log(`spawning: ${this.options.command} ${args.join(" ")}`);

    const proc = spawn(this.options.command, args, {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, ...this.options.env },
      cwd: this.options.cwd,
    });
    this.process = proc;

    proc.on("exit", (code) => {
      log(`subprocess exited (code=${code})`);
      this.ready = false;
      this.connection = null;
      this.process = null;
      
      // Reject all ongoing prompts
      for (const [sessionId, ongoing] of this.ongoingPrompts) {
        log(`rejecting ongoing prompt for session=${sessionId} due to subprocess exit`);
        ongoing.reject?.(new Error(`subprocess exited (code=${code})`));
      }
      this.ongoingPrompts.clear();
      
      // Clear all collectors to stop receiving updates
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
            log(`tool_call: ${describeToolCall(update)} (${update.status ?? "started"})`);
            break;
          case "tool_call_update":
            if (update.status) {
              log(`tool_call_update: ${describeToolCall(update)} → ${update.status}`);
            }
            break;
          case "agent_thought_chunk":
            if (update.content.type === "text") {
              log(`thinking: ${update.content.text.slice(0, 100)}`);
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
        log(
          `permission: auto-approved "${firstOption?.name ?? "allow"}" (${firstOption?.optionId ?? "unknown"})`,
        );
        return {
          outcome: {
            outcome: "selected" as const,
            optionId: firstOption?.optionId ?? "allow",
          },
        };
      },
    }), stream);

    log("initializing connection...");
    await conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "weixin-agent-sdk", version: "0.1.0" },
      clientCapabilities: {},
    });
    log("connection initialized");

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
