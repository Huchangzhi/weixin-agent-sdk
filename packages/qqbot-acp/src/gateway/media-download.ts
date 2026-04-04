import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { ChatRequest } from "weixin-agent-sdk";
import { logger } from "../util/logger.js";

const MEDIA_TEMP_DIR = "/tmp/qqbot-acp/media";

/** Download a remote image to a local temp file. */
export async function downloadRemoteImage(
  url: string,
  label: string,
): Promise<{ filePath: string; mimeType: string } | null> {
  try {
    logger.info(`[${label}] downloading image: ${url.slice(0, 100)}`);

    const response = await fetch(url);
    if (!response.ok) {
      logger.error(`[${label}] download failed: HTTP ${response.status}`);
      return null;
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    const buf = Buffer.from(await response.arrayBuffer());

    const ext = contentType.includes("png") ? ".png"
      : contentType.includes("gif") ? ".gif"
      : contentType.includes("webp") ? ".webp"
      : ".jpg";

    const dir = path.join(MEDIA_TEMP_DIR, "inbound");
    await fs.mkdir(dir, { recursive: true });

    const filename = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, buf);

    logger.info(`[${label}] saved to: ${filePath} (${buf.length} bytes)`);
    return { filePath, mimeType: contentType };
  } catch (err) {
    logger.error(`[${label}] download error: ${err}`);
    return null;
  }
}

/**
 * Find and download media attachments from a QQ message event.
 * Returns a ChatRequest.media object if found.
 */
export async function extractMediaFromEvent(
  attachments?: Array<{
    content_type?: string;
    filename?: string;
    height?: number;
    width?: number;
    size?: number;
    url?: string;
  }>,
  label = "qqbot",
): Promise<ChatRequest["media"]> {
  if (!attachments?.length) return undefined;

  for (const att of attachments) {
    const ct = (att.content_type || "").toLowerCase();
    const url = att.url;
    if (!url) continue;

    // Image
    if (ct.startsWith("image/")) {
      const downloaded = await downloadRemoteImage(url, `${label} image`);
      if (downloaded) {
        return {
          type: "image",
          filePath: downloaded.filePath,
          mimeType: downloaded.mimeType,
        };
      }
    }

    // Audio/Voice
    if (ct.startsWith("audio/")) {
      const downloaded = await downloadRemoteImage(url, `${label} audio`);
      if (downloaded) {
        return {
          type: "audio",
          filePath: downloaded.filePath,
          mimeType: downloaded.mimeType,
        };
      }
    }

    // Video
    if (ct.startsWith("video/")) {
      const downloaded = await downloadRemoteImage(url, `${label} video`);
      if (downloaded) {
        return {
          type: "video",
          filePath: downloaded.filePath,
          mimeType: downloaded.mimeType,
        };
      }
    }

    // File
    if (ct.startsWith("application/") || ct === "text/plain" || ct === "text/html") {
      const downloaded = await downloadRemoteImage(url, `${label} file`);
      if (downloaded) {
        return {
          type: "file",
          filePath: downloaded.filePath,
          mimeType: ct || "application/octet-stream",
          fileName: att.filename,
        };
      }
    }
  }

  return undefined;
}
