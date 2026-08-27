import fs from "node:fs";
import path from "node:path";

import { logger } from "../util/logger.js";
import { resolveStateDir } from "./state-dir.js";
import { listContacts } from "./contacts.js";

/**
 * 同步用户清单到 workspace/MEMORY.md，让 AI 跨会话认识用户。
 *
 * 段落用 HTML 注释标记定位，插件只重写两标记之间的内容，其余原样保留，
 * 不破坏 AI 已有的长期记忆。
 */

const START_MARK = "<!-- openclaw-weixin:users:start -->";
const END_MARK = "<!-- openclaw-weixin:users:end -->";

function resolveWorkspaceDir(): string {
  return process.env.OPENCLAW_WORKSPACE_DIR?.trim() || path.join(resolveStateDir(), "workspace");
}

function resolveMemoryFilePath(): string {
  return path.join(resolveWorkspaceDir(), "MEMORY.md");
}

function buildUsersSection(): string {
  const contacts = listContacts();
  if (contacts.length === 0) return "";
  const lines = contacts.map((c) => {
    const date = c.lastSeenAt ? new Date(c.lastSeenAt).toISOString().slice(0, 10) : "未知";
    return `- ${c.name} — \`${c.userId}\`（最后活跃 ${date}）`;
  });
  return ["", "## 用户清单（openclaw-weixin 插件自动维护，请勿手动删除）", "", ...lines, ""].join(
    "\n",
  );
}

/**
 * 更新 MEMORY.md 中的用户清单段落（幂等）。
 * 无联系人时移除该段落；有联系人时新建或全量重写两标记之间的内容。
 */
export function syncUsersToMemory(): void {
  try {
    const filePath = resolveMemoryFilePath();
    const section = buildUsersSection();
    const wrapped = `${START_MARK}\n${section}\n${END_MARK}`;
    let content = "";
    if (fs.existsSync(filePath)) {
      content = fs.readFileSync(filePath, "utf-8");
    }
    const startIdx = content.indexOf(START_MARK);
    const endIdx = content.indexOf(END_MARK);
    let next: string;
    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
      next = content.slice(0, startIdx) + wrapped + content.slice(endIdx + END_MARK.length);
    } else {
      const base = content.trimEnd();
      next = base ? `${base}\n\n${wrapped}\n` : `${wrapped}\n`;
    }
    if (next === content) {
      return; // 段落无变化，不写盘（每条消息都会触发，靠此幂等）
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, next, "utf-8");
    logger.info(`memory-sync: updated user list in ${filePath}`);
  } catch (err) {
    logger.warn(`memory-sync: failed: ${String(err)}`);
  }
}
