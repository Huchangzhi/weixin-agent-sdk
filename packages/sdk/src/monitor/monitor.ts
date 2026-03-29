import type { Agent } from "../agent/interface.js";
import { getUpdates } from "../api/api.js";
import { WeixinConfigManager } from "../api/config-cache.js";
import { SESSION_EXPIRED_ERRCODE, pauseSession, getRemainingPauseMs } from "../api/session-guard.js";
import { processOneMessage } from "../messaging/process-message.js";
import { getSyncBufFilePath, loadGetUpdatesBuf, saveGetUpdatesBuf } from "../storage/sync-buf.js";
import { logger } from "../util/logger.js";
import { redactBody } from "../util/redact.js";
import { 
  registerOngoingRequest, 
  unregisterOngoingRequest, 
  stopOngoingRequest,
  hasOngoingRequest,
} from "../messaging/ongoing-requests.js";

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;

/** Track conversations where /stop was sent - cleared after the current request completes */
const stoppedConversations = new Set<string>();

export type MonitorWeixinOpts = {
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  accountId: string;
  agent: Agent;
  abortSignal?: AbortSignal;
  longPollTimeoutMs?: number;
  log?: (msg: string) => void;
};

/**
 * Check if a message is a /stop command
 */
function isStopCommand(full: { item_list?: Array<{ type: number; text_item?: { text?: string } }> }): boolean {
  const itemList = full.item_list;
  if (!itemList?.length) return false;
  
  for (const item of itemList) {
    if (item.type === 1 && item.text_item?.text) { // 1 = text type
      const text = String(item.text_item.text).trim();
      return text.toLowerCase() === "/stop";
    }
  }
  return false;
}

/**
 * Long-poll loop: getUpdates → process message → call agent → send reply.
 * Runs until aborted.
 */
export async function monitorWeixinProvider(opts: MonitorWeixinOpts): Promise<void> {
  const {
    baseUrl,
    cdnBaseUrl,
    token,
    accountId,
    agent,
    abortSignal,
    longPollTimeoutMs,
  } = opts;
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const errLog = (msg: string) => {
    log(msg);
    logger.error(msg);
  };
  const aLog = logger.withAccount(accountId);

  log(`[weixin] monitor started (${baseUrl}, account=${accountId})`);
  aLog.info(`Monitor started: baseUrl=${baseUrl}`);

  const syncFilePath = getSyncBufFilePath(accountId);
  const previousGetUpdatesBuf = loadGetUpdatesBuf(syncFilePath);
  let getUpdatesBuf = previousGetUpdatesBuf ?? "";

  if (previousGetUpdatesBuf) {
    log(`[weixin] resuming from previous sync buf (${getUpdatesBuf.length} bytes)`);
  } else {
    log(`[weixin] no previous sync buf, starting fresh`);
  }

  const configManager = new WeixinConfigManager({ baseUrl, token }, log);

  let nextTimeoutMs = longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  let consecutiveFailures = 0;

  // Track the currently processing message promise
  let currentProcessingPromise: Promise<void> | null = null;
  let currentProcessingConversationId: string | null = null;

  while (!abortSignal?.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: getUpdatesBuf,
        timeoutMs: nextTimeoutMs,
        abortSignal,
      });

      if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
        nextTimeoutMs = resp.longpolling_timeout_ms;
      }

      const isApiError =
        (resp.ret !== undefined && resp.ret !== 0) ||
        (resp.errcode !== undefined && resp.errcode !== 0);

      if (isApiError) {
        const isSessionExpired =
          resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;

        if (isSessionExpired) {
          pauseSession(accountId);
          const pauseMs = getRemainingPauseMs(accountId);
          errLog(
            `[weixin] session expired (errcode ${SESSION_EXPIRED_ERRCODE}), pausing for ${Math.ceil(pauseMs / 60_000)} min`,
          );
          consecutiveFailures = 0;
          await sleep(pauseMs, abortSignal);
          continue;
        }

        consecutiveFailures += 1;
        errLog(
          `[weixin] getUpdates failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ""} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          errLog(`[weixin] ${MAX_CONSECUTIVE_FAILURES} consecutive failures, backing off 30s`);
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, abortSignal);
        } else {
          await sleep(RETRY_DELAY_MS, abortSignal);
        }
        continue;
      }

      consecutiveFailures = 0;

      if (resp.get_updates_buf != null && resp.get_updates_buf !== "") {
        saveGetUpdatesBuf(syncFilePath, resp.get_updates_buf);
        getUpdatesBuf = resp.get_updates_buf;
      }

      const list = resp.msgs ?? [];
      
      // First pass: register ongoing requests for ALL messages first
      const messagesToProcess: Array<{ full: typeof list[0], cachedConfig: any }> = [];
      for (const full of list) {
        const fromUserId = full.from_user_id ?? "";
        const textBody = full.item_list?.find(i => i.type === 1)?.text_item?.text ?? "";
        
        // Skip if this conversation is already stopped
        if (stoppedConversations.has(fromUserId)) {
          log(`[monitor] SKIP (pre): conversation ${fromUserId} was stopped`);
          continue;
        }
        
        // Skip /stop commands from registration
        if (String(textBody).trim().toLowerCase() === "/stop") {
          continue;
        }
        
        // Register ongoing request
        const abortController = new AbortController();
        registerOngoingRequest(fromUserId, abortController);
        log(`[monitor] registered ongoing request for=${fromUserId}`);
        
        // Cache config for later
        const cachedConfig = await configManager.getForUser(fromUserId, full.context_token);
        messagesToProcess.push({ full, cachedConfig });
      }
      
      // Second pass: check for /stop commands and stop ongoing requests
      for (const full of list) {
        if (isStopCommand(full)) {
          const fromUserId = full.from_user_id ?? "";
          stoppedConversations.add(fromUserId);
          log(`[monitor] detected /stop from=${fromUserId}`);
          
          // Stop the ongoing request if exists
          if (hasOngoingRequest(fromUserId)) {
            log(`[monitor] stopping ongoing request for=${fromUserId}`);
            stopOngoingRequest(fromUserId);
            
            if (agent.stop) {
              log(`[monitor] calling agent.stop for=${fromUserId}`);
              agent.stop(fromUserId);
            }
          } else {
            log(`[monitor] no ongoing request to stop for=${fromUserId}`);
          }
        }
      }
      log(`[monitor] stoppedConversations=[${Array.from(stoppedConversations).join(", ")}]`);

      // Third pass: process messages
      for (const { full, cachedConfig } of messagesToProcess) {
        const fromUserId = full.from_user_id ?? "";
        const textBody = full.item_list?.find(i => i.type === 1)?.text_item?.text ?? "";
        log(`[monitor] processing: from=${fromUserId} text=${String(textBody).slice(0, 30)}`);
        
        // Double-check if this conversation was stopped
        if (stoppedConversations.has(fromUserId)) {
          log(`[monitor] SKIP: conversation ${fromUserId} was stopped, unregistering`);
          unregisterOngoingRequest(fromUserId);
          continue;
        }

        aLog.info(
          `inbound: from=${fromUserId} types=${full.item_list?.map((i) => i.type).join(",") ?? "none"}`,
        );

        currentProcessingConversationId = fromUserId;
        currentProcessingPromise = processOneMessage(full, {
          accountId,
          agent,
          baseUrl,
          cdnBaseUrl,
          token,
          typingTicket: cachedConfig.typingTicket,
          log,
          errLog,
        }).finally(() => {
          currentProcessingPromise = null;
          currentProcessingConversationId = null;
          unregisterOngoingRequest(fromUserId);
          stoppedConversations.delete(fromUserId);
          log(`[monitor] completed and cleared for ${fromUserId}`);
        });
      }
    } catch (err) {
      if (abortSignal?.aborted) {
        aLog.info(`Monitor stopped (aborted)`);
        return;
      }
      consecutiveFailures += 1;
      errLog(
        `[weixin] getUpdates error (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${String(err)}`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        consecutiveFailures = 0;
        await sleep(BACKOFF_DELAY_MS, abortSignal);
      } else {
        await sleep(RETRY_DELAY_MS, abortSignal);
      }
    }
  }
  aLog.info(`Monitor ended`);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
