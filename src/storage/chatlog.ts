import fs from "node:fs";
import path from "node:path";

import { logger } from "../util/logger.js";
import { resolveStateDir } from "./state-dir.js";

/**
 * 聊天记录归档：每个用户一个 JSONL 文件。
 * 目录：<stateDir>/openclaw-weixin/chatlogs/{safeKey}.jsonl
 * safeKey 优先用联系人显示名，未命名时用 userId（路径特殊字符已 sanitize）。
 *
 * 追加方式：gateway 单进程顺序处理消息，直接 appendFileSync 即可避免撕裂；
 * 文件持续增长，暂不做轮转，后续可按需加（按天/按大小）。
 */

export type ChatlogDirection = "in" | "out";

export type ChatlogEntry = {
  ts: number;
  direction: ChatlogDirection;
  userId: string;
  name?: string;
  type: "text" | "image" | "video" | "voice" | "file";
  text?: string;
  mediaPath?: string;
  textLen: number;
};

function resolveChatlogDir(): string {
  return path.join(resolveStateDir(), "openclaw-weixin", "chatlogs");
}

/** 生成安全文件名：去除路径特殊字符，控制长度。 */
function safeKey(s: string): string {
  const cleaned = s.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 80);
  return cleaned || "unknown";
}

/** 归一化微信 userId：统一小写，与 contacts.json 的 key 保持一致（微信 userId 不区分大小写）。 */
function normalizeUserId(userId: string): string {
  return userId.trim().toLowerCase();
}

function resolveChatlogPath(userId: string, name?: string): string {
  const key = safeKey(name?.trim() || userId);
  return path.join(resolveChatlogDir(), `${key}.jsonl`);
}

/** 追加一条聊天记录。 */
export function appendChatlog(entry: ChatlogEntry): void {
  try {
    const nuserId = normalizeUserId(entry.userId);
    if (!nuserId) return;
    const filePath = resolveChatlogPath(nuserId, entry.name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify({ ...entry, userId: nuserId }) + "\n", "utf-8");
  } catch (err) {
    logger.warn(`chatlog: append failed for ${entry.userId}: ${String(err)}`);
  }
}

/** 读取最近 N 条聊天记录（时间倒序返回最新在前）。 */
export function readChatlog(
  userId: string,
  name: string | undefined,
  limit: number,
): ChatlogEntry[] {
  try {
    const filePath = resolveChatlogPath(normalizeUserId(userId), name);
    if (!fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
    const entries = lines
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as ChatlogEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is ChatlogEntry => e !== null);
    return entries.slice(-Math.max(1, Math.floor(limit))).reverse();
  } catch (err) {
    logger.warn(`chatlog: read failed for ${userId}: ${String(err)}`);
    return [];
  }
}

/** 删除某用户（按 userId 或显示名）对应的归档文件。用于 /setname 改名后重命名文件。 */
export function renameChatlogForUser(
  userId: string,
  oldName: string | undefined,
  newName: string | undefined,
): void {
  try {
    const oldPath = resolveChatlogPath(normalizeUserId(userId), oldName);
    const newPath = resolveChatlogPath(normalizeUserId(userId), newName);
    if (oldPath === newPath) return;
    if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
      fs.renameSync(oldPath, newPath);
      logger.info(`chatlog: renamed ${oldPath} -> ${newPath}`);
    }
  } catch (err) {
    logger.warn(`chatlog: rename failed for ${userId}: ${String(err)}`);
  }
}
