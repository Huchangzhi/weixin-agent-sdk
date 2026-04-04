import { normalizeQQAccountId, registerQQBotAccountId, saveQQBotAccount, clearAllQQBotAccounts, listQQBotAccountIds, resolveQQBotAccount } from "./accounts.js";

export type QQBotLoginResult = {
  connected: boolean;
  appId: string;
  accountId: string;
  message: string;
};

/**
 * Login with QQ bot token.
 * Token format: "appId:clientSecret"
 */
export async function loginQQBot(opts: {
  token: string;
  accountId?: string;
  log?: (msg: string) => void;
}): Promise<QQBotLoginResult> {
  const log = opts.log ?? console.log;

  // Parse token
  const tokenParts = opts.token.split(":");
  if (tokenParts.length !== 2) {
    return {
      connected: false,
      appId: "",
      accountId: "",
      message: "Token 格式错误，应为 'appId:clientSecret'",
    };
  }

  const [appId, clientSecret] = tokenParts;

  if (!appId || !clientSecret) {
    return {
      connected: false,
      appId: "",
      accountId: "",
      message: "Token 格式错误：appId 或 clientSecret 为空",
    };
  }

  // Validate token length (basic check)
  if (appId.length < 5 || clientSecret.length < 10) {
    return {
      connected: false,
      appId: "",
      accountId: "",
      message: "Token 长度异常，请检查",
    };
  }

  // Test token by fetching access token
  log("正在验证 Token...");
  try {
    const accessToken = await testQQBotToken(appId, clientSecret);
    log(`✅ Token 验证成功！Access Token: ${accessToken.slice(0, 10)}...`);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      connected: false,
      appId: "",
      accountId: "",
      message: `Token 验证失败：${errorMsg}`,
    };
  }

  // Save account
  const accountId = normalizeQQAccountId(opts.accountId || appId);
  saveQQBotAccount(accountId, { appId, clientSecret });
  registerQQBotAccountId(accountId);

  log(`\n✅ 与 QQ Bot 连接成功！`);
  log(`账号 ID: ${accountId}`);
  log(`App ID: ${appId}`);

  return {
    connected: true,
    appId,
    accountId,
    message: "✅ 与 QQ Bot 连接成功！",
  };
}

/**
 * Test QQ bot token by fetching access token.
 */
async function testQQBotToken(appId: string, clientSecret: string): Promise<string> {
  const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, clientSecret }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`HTTP ${response.status}: ${body}`);
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error(`未获取到 access_token: ${JSON.stringify(data)}`);
  }

  return data.access_token;
}

/**
 * Logout QQ bot (remove all accounts).
 */
export function logoutQQBot(opts?: { log?: (msg: string) => void }): void {
  const log = opts?.log ?? console.log;
  const ids = listQQBotAccountIds();
  if (ids.length === 0) {
    log("当前没有已登录的 QQ Bot 账号");
    return;
  }
  clearAllQQBotAccounts();
  log("✅ 已退出 QQ Bot 登录");
}

/**
 * Check if at least one QQ bot account is configured.
 */
export function isQQBotLoggedIn(): boolean {
  const ids = listQQBotAccountIds();
  if (ids.length === 0) return false;
  const account = resolveQQBotAccount(ids[0]);
  return account.configured;
}
