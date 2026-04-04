// QQ Bot API - Token management

const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";
const API_BASE = "https://api.sgroup.qq.com";

// Token cache per appId
const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Get access token (with caching).
 */
export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  const cached = tokenCache.get(appId);
  if (cached && Date.now() < cached.expiresAt - 60000) { // Refresh 1 min early
    return cached.token;
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appId, clientSecret }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`Failed to get access token: HTTP ${response.status} ${body}`);
  }

  const data = await response.json();
  if (!data.access_token) {
    throw new Error(`Access token not found in response: ${JSON.stringify(data)}`);
  }

  const expiresIn = (data.expires_in || 7200) * 1000; // Default 2 hours
  tokenCache.set(appId, {
    token: data.access_token,
    expiresAt: Date.now() + expiresIn,
  });

  return data.access_token;
}

/**
 * Force refresh access token (clear cache and re-fetch).
 */
export async function forceRefreshToken(appId: string, clientSecret: string): Promise<string> {
  tokenCache.delete(appId);
  return getAccessToken(appId, clientSecret);
}

/**
 * Send text message to QQ user/group.
 * On any failure, refresh token and retry, up to 3 attempts total.
 */
export async function sendQQTextMessage(params: {
  appId: string;
  clientSecret: string;
  to: string;
  targetType: "c2c" | "group" | "dm" | "channel";
  text: string;
  msgId?: string;
}): Promise<void> {
  const { appId, clientSecret, to, targetType, text, msgId } = params;
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const accessToken = await getAccessToken(appId, clientSecret);
    try {
      await doSendMessage(accessToken, to, targetType, text, msgId);
      return; // success
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Refresh token before next retry
      if (attempt < maxRetries - 1) {
        await forceRefreshToken(appId, clientSecret);
      }
    }
  }

  throw lastError!;
}

/**
 * Internal: actually send the message with a given access token.
 */
async function doSendMessage(
  accessToken: string,
  to: string,
  targetType: "c2c" | "group" | "dm" | "channel",
  text: string,
  msgId?: string,
): Promise<void> {
  let path: string;
  let body: any;

  switch (targetType) {
    case "c2c":
      path = `/v2/users/${to}/messages`;
      body = {
        content: text,
        msg_type: 0,
        ...(msgId ? { msg_id: msgId } : {}),
      };
      break;

    case "group":
      path = `/v2/groups/${to}/messages`;
      body = {
        content: text,
        msg_type: 0,
        ...(msgId ? { msg_id: msgId } : {}),
      };
      break;

    case "dm":
      path = `/dms/${to}/messages`;
      body = {
        content: text,
        ...(msgId ? { msg_id: msgId } : {}),
      };
      break;

    case "channel":
      path = `/channels/${to}/messages`;
      body = {
        content: text,
        ...(msgId ? { msg_id: msgId } : {}),
      };
      break;

    default:
      throw new Error(`Unknown target type: ${targetType}`);
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `QQBot ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const respBody = await response.text().catch(() => "(unreadable)");
    throw new Error(`Failed to send message: HTTP ${response.status} ${respBody}`);
  }
}
