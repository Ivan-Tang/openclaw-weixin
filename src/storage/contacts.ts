import fs from "node:fs";
import path from "node:path";

import { logger } from "../util/logger.js";
import { resolveStateDir } from "./state-dir.js";

/**
 * 联系人簿：微信 userId → 显示名 的映射（权威源）。
 *
 * 内存缓存 + 磁盘落盘。数据文件：<stateDir>/openclaw-weixin/contacts.json
 * 命名来源：config 预设（contactPresets）或用户通过 /setname 自助命名。
 * /setname 写回文件且优先于预设；touchUser 只更新内存 lastSeenAt（去抖落盘）。
 */

export type Contact = {
  name: string;
  note?: string;
  createdAt: number;
  updatedAt: number;
  lastSeenAt?: number;
};

type ContactsFile = {
  version: 1;
  contacts: Record<string, Contact>;
};

let contactsCache: Record<string, Contact> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function resolveContactsFilePath(): string {
  return path.join(resolveStateDir(), "openclaw-weixin", "contacts.json");
}

function loadContacts(): Record<string, Contact> {
  if (contactsCache) return contactsCache;
  contactsCache = {};
  try {
    const filePath = resolveContactsFilePath();
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ContactsFile;
      if (parsed?.contacts && typeof parsed.contacts === "object") {
        contactsCache = parsed.contacts;
      }
    }
  } catch (err) {
    logger.warn(`contacts: load failed: ${String(err)}`);
  }
  return contactsCache;
}

function persistContacts(): void {
  try {
    const filePath = resolveContactsFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const data: ContactsFile = { version: 1, contacts: loadContacts() };
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  } catch (err) {
    logger.warn(`contacts: persist failed: ${String(err)}`);
  }
}

/** 高频 touch 落盘去抖：500ms 内多次更新合并为一次写盘。 */
function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistContacts();
  }, 500);
}

/**
 * 归一化微信 userId：统一小写，保证 config 预设（小写）与运行时 senderId
 * （可能大小写混合）能匹配。微信 userId 不区分大小写。
 */
function normalizeUserId(userId: string): string {
  return userId.trim().toLowerCase();
}

/** 返回联系人显示名（未命名返回 undefined）。 */
export function getContactName(userId: string): string | undefined {
  return loadContacts()[normalizeUserId(userId)]?.name;
}

/** 返回联系人完整信息。 */
export function getContact(userId: string): Contact | undefined {
  return loadContacts()[normalizeUserId(userId)];
}

/** 记录用户活跃时间（仅更新内存 lastSeenAt，去抖落盘）。 */
export function touchUser(userId: string): void {
  const key = normalizeUserId(userId);
  if (!key) return;
  const contact = loadContacts()[key];
  if (!contact) return;
  contact.lastSeenAt = Date.now();
  schedulePersist();
}

/** 设置（或新建）用户显示名并立即落盘。 */
export function setContactName(userId: string, name: string): void {
  const key = normalizeUserId(userId);
  if (!key) return;
  const now = Date.now();
  const contacts = loadContacts();
  const existing = contacts[key];
  const cleanName = name.trim();
  contacts[key] = {
    name: cleanName || key,
    note: existing?.note,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    lastSeenAt: existing?.lastSeenAt ?? now,
  };
  persistContacts();
}

/** 列出所有联系人（按最后活跃倒序）。 */
export function listContacts(): Array<{ userId: string } & Contact> {
  return Object.entries(loadContacts())
    .map(([userId, c]) => ({ userId, ...c }))
    .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
}

/**
 * 从 config 预设合并进联系人簿（启动时调用）。
 * 已存在名字的联系人不覆盖，保留运行期 /setname 的结果。
 */
export function mergeContactPresets(presets: Record<string, string> | undefined): void {
  if (!presets) return;
  for (const [userId, name] of Object.entries(presets)) {
    const key = normalizeUserId(userId);
    if (!name?.trim() || !key) continue;
    if (loadContacts()[key]?.name) continue;
    setContactName(key, name);
  }
}
