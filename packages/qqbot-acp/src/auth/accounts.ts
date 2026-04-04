import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const DEFAULT_QQ_API_BASE = "https://bots.qq.com";

/** Normalize an account ID to a filesystem-safe string. */
export function normalizeQQAccountId(raw: string): string {
  return raw.trim().toLowerCase().replace(/[@.]/g, "-");
}

// ---------------------------------------------------------------------------
// Account index (persistent list of registered account IDs)
// ---------------------------------------------------------------------------

function resolveQQStateDir(): string {
  return path.join(
    process.env.OPENCLAW_STATE_DIR?.trim() ||
    process.env.CLAWDBOT_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".openclaw"),
    "openclaw-qqbot"
  );
}

function resolveAccountIndexPath(): string {
  return path.join(resolveQQStateDir(), "accounts.json");
}

/** Returns all accountIds registered via token login. */
export function listIndexedQQAccountIds(): string[] {
  const filePath = resolveAccountIndexPath();
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.trim() !== "");
  } catch {
    return [];
  }
}

/** Register accountId as the sole account in the persistent index. */
export function registerQQBotAccountId(accountId: string): void {
  const dir = resolveQQStateDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify([accountId], null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Account store (per-account credential files)
// ---------------------------------------------------------------------------

export type QQBotAccountData = {
  appId?: string;
  clientSecret?: string;
  savedAt?: string;
};

function resolveAccountsDir(): string {
  return path.join(resolveQQStateDir(), "accounts");
}

function resolveAccountPath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.json`);
}

/** Load account data by ID. */
export function loadQQBotAccount(accountId: string): QQBotAccountData | null {
  const filePath = resolveAccountPath(accountId);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as QQBotAccountData;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Persist account data after token login.
 */
export function saveQQBotAccount(
  accountId: string,
  update: { appId: string; clientSecret: string },
): void {
  const dir = resolveAccountsDir();
  fs.mkdirSync(dir, { recursive: true });

  const data: QQBotAccountData = {
    appId: update.appId,
    clientSecret: update.clientSecret,
    savedAt: new Date().toISOString(),
  };

  const filePath = resolveAccountPath(accountId);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

/** Remove account data file. */
export function clearQQBotAccount(accountId: string): void {
  try {
    fs.unlinkSync(resolveAccountPath(accountId));
  } catch {
    // ignore if not found
  }
}

/** Remove all account data files and clear the account index. */
export function clearAllQQBotAccounts(): void {
  const ids = listIndexedQQAccountIds();
  for (const id of ids) {
    clearQQBotAccount(id);
  }
  try {
    fs.writeFileSync(resolveAccountIndexPath(), "[]", "utf-8");
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

export type ResolvedQQBotAccount = {
  accountId: string;
  appId: string;
  clientSecret: string;
  configured: boolean;
};

/** List accountIds from the index file. */
export function listQQBotAccountIds(): string[] {
  return listIndexedQQAccountIds();
}

/** Resolve a QQ bot account by ID, reading stored credentials. */
export function resolveQQBotAccount(accountId?: string | null): ResolvedQQBotAccount {
  const raw = accountId?.trim();
  if (!raw) {
    throw new Error("qqbot: accountId is required");
  }
  const id = normalizeQQAccountId(raw);

  const accountData = loadQQBotAccount(id);
  const appId = accountData?.appId?.trim() || "";
  const clientSecret = accountData?.clientSecret?.trim() || "";

  return {
    accountId: id,
    appId,
    clientSecret,
    configured: Boolean(appId && clientSecret),
  };
}
