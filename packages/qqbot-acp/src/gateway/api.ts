// QQ Bot API - Token management
import fs from "node:fs";
import path from "node:path";

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

/**
 * Send image message to QQ user/group.
 * Uploads the local image file and sends it with optional text.
 */
export async function sendQQImageMessage(params: {
  appId: string;
  clientSecret: string;
  to: string;
  targetType: "c2c" | "group" | "dm" | "channel";
  imagePath: string;
  text?: string;
  msgId?: string;
}): Promise<void> {
  const { appId, clientSecret, to, targetType, imagePath, text, msgId } = params;
  const maxRetries = 3;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const accessToken = await getAccessToken(appId, clientSecret);
    try {
      console.log(`[qqbot] sendQQImageMessage attempt ${attempt + 1}/${maxRetries}`);
      await doSendImageMessage(accessToken, to, targetType, imagePath, text, msgId);
      console.log(`[qqbot] sendQQImageMessage success`);
      return; // success
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.error(`[qqbot] sendQQImageMessage attempt ${attempt + 1} failed: ${lastError.message}`);
      // Refresh token before next retry
      if (attempt < maxRetries - 1) {
        await forceRefreshToken(appId, clientSecret);
      }
    }
  }

  console.error(`[qqbot] sendQQImageMessage all attempts failed: ${lastError?.message}`);
  throw lastError!;
}

/**
 * Internal: upload image file and send media message.
 */
async function doSendImageMessage(
  accessToken: string,
  to: string,
  targetType: "c2c" | "group" | "dm" | "channel",
  imagePath: string,
  text?: string,
  msgId?: string,
): Promise<void> {
  // Step 1: Upload the image file to get file_info
  const fileInfo = await uploadImageFile(accessToken, to, targetType, imagePath);

  // Step 2: Send the media message with file_info
  // msg_type: 7 = media message, use media.file_info structure
  let apiPath: string;
  let body: any;

  switch (targetType) {
    case "c2c":
      apiPath = `/v2/users/${to}/messages`;
      body = {
        msg_type: 7, // 7 = media message
        media: {
          file_info: fileInfo,
        },
        ...(text ? { content: text } : {}),
        ...(msgId ? { msg_id: msgId } : {}),
      };
      break;

    case "group":
      apiPath = `/v2/groups/${to}/messages`;
      body = {
        msg_type: 7,
        media: {
          file_info: fileInfo,
        },
        ...(text ? { content: text } : {}),
        ...(msgId ? { msg_id: msgId } : {}),
      };
      break;

    case "dm":
      apiPath = `/dms/${to}/messages`;
      body = {
        msg_type: 7,
        media: {
          file_info: fileInfo,
        },
        ...(text ? { content: text } : {}),
        ...(msgId ? { msg_id: msgId } : {}),
      };
      break;

    case "channel":
      apiPath = `/channels/${to}/messages`;
      body = {
        msg_type: 7,
        media: {
          file_info: fileInfo,
        },
        ...(text ? { content: text } : {}),
        ...(msgId ? { msg_id: msgId } : {}),
      };
      break;

    default:
      throw new Error(`Unknown target type: ${targetType}`);
  }

  const response = await fetch(`${API_BASE}${apiPath}`, {
    method: "POST",
    headers: {
      Authorization: `QQBot ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  console.log(`[qqbot] send image message response: HTTP ${response.status}`);
  if (!response.ok) {
    const respBody = await response.text().catch(() => "(unreadable)");
    console.error(`[qqbot] send image message failed response: ${respBody}`);
    throw new Error(`Failed to send image message: HTTP ${response.status} ${respBody}`);
  }
}

/**
 * Upload image file to QQ media server using official API.
 * Flow:
 * 1. POST /v2/users/{openid}/files or /v2/groups/{group_openid}/files with file_data (base64)
 * 2. Get file_info from response
 * 3. Use file_info when sending message
 */
async function uploadImageFile(
  accessToken: string,
  to: string,
  targetType: "c2c" | "group" | "dm" | "channel",
  imagePath: string,
): Promise<any> {
  const fileData = fs.readFileSync(imagePath);
  const fileBase64 = fileData.toString("base64");

  // Determine API path based on target type
  let uploadPath: string;
  switch (targetType) {
    case "c2c":
      uploadPath = `/v2/users/${to}/files`;
      break;
    case "group":
      uploadPath = `/v2/groups/${to}/files`;
      break;
    case "dm":
      // DM uses C2C endpoint
      uploadPath = `/v2/users/${to}/files`;
      break;
    case "channel":
      uploadPath = `/channels/${to}/files`;
      break;
    default:
      throw new Error(`Unknown target type: ${targetType}`);
  }

  // Upload file using official API with file_data (base64)
  const response = await fetch(`${API_BASE}${uploadPath}`, {
    method: "POST",
    headers: {
      Authorization: `QQBot ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      file_type: 1, // 1 = image
      file_data: fileBase64,
      srv_send_msg: false,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "(unreadable)");
    throw new Error(`Failed to upload image: HTTP ${response.status} ${body}`);
  }

  const data = await response.json();
  if (!data.file_info) {
    throw new Error(`Upload response missing file_info: ${JSON.stringify(data)}`);
  }

  return data.file_info;
}

