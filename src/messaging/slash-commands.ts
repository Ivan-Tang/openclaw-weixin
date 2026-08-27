/**
 * Weixin 斜杠指令处理模块
 *
 * 支持的指令：
 * - /echo <message>         直接回复消息（不经过 AI），并附带通道耗时统计
 * - /toggle-debug           开关 debug 模式，启用后每条 AI 回复追加全链路耗时
 * - /whoami                 显示自己的 userId 与当前显示名
 * - /setname <名字>         给自己命名（写 contacts.json + 同步 MEMORY.md）
 * - /listusers              列出已知用户（名字 / userId / 最后活跃）
 * - /history [N]            查看自己最近 N 条聊天记录（默认 20，上限 50）
 *
 * 管理类命令（/setname /listusers /history）内部鉴权：allowFrom 白名单优先，
 * 空则 fallback 账号绑定的 userId。未授权返回拒绝。
 */
import { spawn } from "node:child_process";
import type { WeixinApiOptions } from "../api/api.js";
import { logger } from "../util/logger.js";

import { loadWeixinAccount } from "../auth/accounts.js";
import { readFrameworkAllowFromList } from "../auth/pairing.js";
import { getContactName, listContacts, setContactName } from "../storage/contacts.js";
import { readChatlog, renameChatlogForUser } from "../storage/chatlog.js";
import { syncUsersToMemory } from "../storage/memory-sync.js";

import { toggleDebugMode, isDebugMode } from "./debug-mode.js";
import { sendMessageWeixin } from "./send.js";

export interface SlashCommandResult {
  /** 是否是斜杠指令（true 表示已处理，不需要继续走 AI） */
  handled: boolean;
}

export interface SlashCommandContext {
  to: string;
  /** 发送者的微信 userId（== to，管理命令据此鉴权） */
  userId: string;
  contextToken?: string;
  baseUrl: string;
  token?: string;
  accountId: string;
  log: (msg: string) => void;
  errLog: (msg: string) => void;
}

/** 发送回复消息 */
async function sendReply(ctx: SlashCommandContext, text: string): Promise<void> {
  const opts: WeixinApiOptions & { contextToken?: string } = {
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    contextToken: ctx.contextToken,
  };
  await sendMessageWeixin({ to: ctx.to, text, opts });
}

/** 管理命令鉴权：allowFrom 白名单优先，空则 fallback 账号绑定的 userId（与 process-message 同逻辑）。 */
async function isAuthorized(ctx: SlashCommandContext): Promise<boolean> {
  const fromStore = readFrameworkAllowFromList(ctx.accountId);
  const allowed =
    fromStore.length > 0
      ? fromStore
      : (() => {
          const uid = loadWeixinAccount(ctx.accountId)?.userId?.trim();
          return uid ? [uid] : [];
        })();
  return allowed.length === 0 || allowed.includes(ctx.userId);
}

/** 处理 /echo 指令 */
async function handleEcho(
  ctx: SlashCommandContext,
  args: string,
  receivedAt: number,
  eventTimestamp?: number,
): Promise<void> {
  const message = args.trim();
  if (message) {
    await sendReply(ctx, message);
  }
  const eventTs = eventTimestamp ?? 0;
  const platformDelay = eventTs > 0 ? `${receivedAt - eventTs}ms` : "N/A";
  const timing = [
    "⏱ 通道耗时",
    `├ 事件时间: ${eventTs > 0 ? new Date(eventTs).toISOString() : "N/A"}`,
    `├ 平台→插件: ${platformDelay}`,
    `└ 插件处理: ${Date.now() - receivedAt}ms`,
  ].join("\n");
  await sendReply(ctx, timing);
}

/** 处理 /setname 指令：给自己命名并同步 MEMORY.md 与 chatlog 文件名 */
async function handleSetName(ctx: SlashCommandContext, args: string): Promise<void> {
  const name = args.trim();
  if (!name) {
    await sendReply(ctx, "用法：/setname <显示名>（≤30 字符，如：/setname 小明）");
    return;
  }
  if (name.length > 30) {
    await sendReply(ctx, "❌ 显示名过长（≤30 字符）");
    return;
  }
  if (/[\n\r]/.test(name)) {
    await sendReply(ctx, "❌ 显示名不能包含换行");
    return;
  }
  const oldName = getContactName(ctx.userId);
  setContactName(ctx.userId, name);
  renameChatlogForUser(ctx.userId, oldName, name);
  syncUsersToMemory();
  await sendReply(ctx, `✅ 已将你命名为「${name}」`);
}

/** 处理 /whoami 指令 */
async function handleWhoAmI(ctx: SlashCommandContext): Promise<void> {
  const name = getContactName(ctx.userId);
  await sendReply(
    ctx,
    [
      `🔑 userId: ${ctx.userId}`,
      `🏷 当前名字: ${name ?? "（未命名）"}`,
      `提示：用 /setname <名字> 给自己命名`,
    ].join("\n"),
  );
}

/** 处理 /listusers 指令 */
async function handleListUsers(ctx: SlashCommandContext): Promise<void> {
  const contacts = listContacts();
  if (contacts.length === 0) {
    await sendReply(ctx, "📭 还没有已知用户");
    return;
  }
  const lines = contacts.map((c) => {
    const last = c.lastSeenAt ? new Date(c.lastSeenAt).toISOString().slice(0, 10) : "?";
    return `- ${c.name} — ${c.userId}（最后活跃 ${last}）`;
  });
  await sendReply(ctx, `👥 已知用户 (${contacts.length}):\n${lines.join("\n")}`);
}

/** 处理 /history 指令 */
async function handleHistory(ctx: SlashCommandContext, args: string): Promise<void> {
  const n = Math.min(50, Math.max(1, parseInt(args.trim(), 10) || 20));
  const entries = readChatlog(ctx.userId, getContactName(ctx.userId), n);
  if (entries.length === 0) {
    await sendReply(ctx, "📭 暂无聊天记录");
    return;
  }
  const lines = entries.map((e) => {
    const t = new Date(e.ts).toISOString().slice(11, 19);
    const body = (e.text ?? "").slice(0, 60) || (e.type !== "text" ? `[${e.type}]` : "");
    const arrow = e.direction === "in" ? "📥" : "📤";
    return `${arrow} ${t} ${e.name ? `${e.name}: ` : ""}${body}`;
  });
  await sendReply(ctx, `📜 最近 ${entries.length} 条记录:\n${lines.join("\n")}`);
}

/** 处理 /restart 指令：重启 openclaw-gateway 网关
 *
 * 重启由 detached 子进程完成（sleep 3 后再 systemctl --no-block restart）：
 * - detached + unref：本进程（gateway）被 SIGTERM 时子进程不受影响，重启必然完成
 * - --no-block：systemd 后台异步完成重启，子进程不阻塞等待
 * - 插件跑在 gateway 进程里，若直接 systemctl restart 会杀掉自己（22:48 教训）
 */
async function handleRestart(ctx: SlashCommandContext): Promise<void> {
  try {
    const child = spawn(
      "sh",
      ["-c", "sleep 3; systemctl --no-block restart openclaw-gateway"],
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    ctx.log(`[weixin] /restart: scheduled systemctl restart (pid ${child.pid})`);
  } catch (err) {
    ctx.errLog(`[weixin] /restart schedule failed: ${String(err)}`);
  }
  await sendReply(
    ctx,
    "🔄 正在重启网关，约 10~20 秒恢复。\n稍等片刻后随便发一条消息，我会带着之前的记忆继续。"
  );
}

/**
 * 尝试处理斜杠指令
 *
 * @returns handled=true 表示该消息已作为指令处理，不需要继续走 AI 管道
 */
export async function handleSlashCommand(
  content: string,
  ctx: SlashCommandContext,
  receivedAt: number,
  eventTimestamp?: number,
): Promise<SlashCommandResult> {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) {
    return { handled: false };
  }

  const spaceIdx = trimmed.indexOf(" ");
  const command = spaceIdx === -1 ? trimmed.toLowerCase() : trimmed.slice(0, spaceIdx).toLowerCase();
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);

  logger.info(`[weixin] Slash command: ${command}, args: ${args.slice(0, 50)}`);

  try {
    switch (command) {
      case "/echo":
        await handleEcho(ctx, args, receivedAt, eventTimestamp);
        return { handled: true };
      case "/toggle-debug": {
        const enabled = toggleDebugMode(ctx.accountId);
        await sendReply(
          ctx,
          enabled
            ? "Debug 模式已开启"
            : "Debug 模式已关闭",
        );
        return { handled: true };
      }
      case "/whoami":
        await handleWhoAmI(ctx);
        return { handled: true };
      case "/setname":
        if (!(await isAuthorized(ctx))) {
          await sendReply(ctx, "⛔ 你没有权限执行该命令");
          return { handled: true };
        }
        await handleSetName(ctx, args);
        return { handled: true };
      case "/listusers":
        if (!(await isAuthorized(ctx))) {
          await sendReply(ctx, "⛔ 你没有权限执行该命令");
          return { handled: true };
        }
        await handleListUsers(ctx);
        return { handled: true };
      case "/history":
        if (!(await isAuthorized(ctx))) {
          await sendReply(ctx, "⛔ 你没有权限执行该命令");
          return { handled: true };
        }
        await handleHistory(ctx, args);
        return { handled: true };
      case "/restart":
        if (!(await isAuthorized(ctx))) {
          await sendReply(ctx, "⛔ 你没有权限执行该命令");
          return { handled: true };
        }
        await handleRestart(ctx);
        return { handled: true };
      default:
        return { handled: false };
    }
  } catch (err) {
    logger.error(`[weixin] Slash command error: ${String(err)}`);
    try {
      await sendReply(ctx, `❌ 指令执行失败: ${String(err).slice(0, 200)}`);
    } catch {
      // 发送错误消息也失败了，只能记日志
    }
    return { handled: true };
  }
}
