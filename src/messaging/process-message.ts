import path from "node:path";
import { randomUUID } from "node:crypto";

import { createTypingCallbacks } from "openclaw/plugin-sdk/channel-runtime";
import {
  resolveSenderCommandAuthorizationWithRuntime,
  resolveDirectDmAuthorizationOutcome,
} from "openclaw/plugin-sdk/command-auth";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/infra-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";

import { sendTyping } from "../api/api.js";
import type { WeixinMessage } from "../api/types.js";
import { MessageItemType, TypingStatus } from "../api/types.js";
import { loadWeixinAccount } from "../auth/accounts.js";
import { readFrameworkAllowFromList } from "../auth/pairing.js";
import { downloadRemoteImageToTemp } from "../cdn/upload.js";
import { resolveReplyProgressMessagesEnabled } from "../config/reply-progress.js";
import { downloadMediaFromItem } from "../media/media-download.js";
import { logger } from "../util/logger.js";
import { redactBody, redactToken } from "../util/redact.js";

import { isDebugMode } from "./debug-mode.js";
import { sendWeixinErrorNotice } from "./error-notice.js";
import { applyWeixinMessageSendingHook, emitWeixinMessageSent } from "./outbound-hooks.js";
import {
  setContextToken,
  weixinMessageToMsgContext,
  getContextTokenFromMsgContext,
  isMediaItem,
} from "./inbound.js";
import type { WeixinInboundMediaOpts } from "./inbound.js";
import { sendWeixinMediaFile } from "./send-media.js";
import { StreamingMarkdownFilter } from "./markdown-filter.js";
import { sendMessageWeixin } from "./send.js";
import { WeixinReplyProgressSender } from "./reply-progress-sender.js";
import { handleSlashCommand } from "./slash-commands.js";
import { appendChatlog, type ChatlogEntry } from "../storage/chatlog.js";
import { getContactName, mergeContactPresets, touchUser } from "../storage/contacts.js";
import { syncUsersToMemory } from "../storage/memory-sync.js";

const MEDIA_OUTBOUND_TEMP_DIR = path.join(resolvePreferredOpenClawTmpDir(), "weixin/media/outbound-temp");

/** 读取 channels.openclaw-weixin 的插件自有配置（chatlog/contactName 等；ack 逻辑单独读取）。 */
function getWeixinChannelConfig(deps: ProcessMessageDeps): {
  chatlogEnabled?: boolean;
  contactNameInjection?: boolean;
  contactPresets?: Record<string, string>;
} {
  type WeixinChannelConfig = {
    chatlogEnabled?: boolean;
    contactNameInjection?: boolean;
    contactPresets?: Record<string, string>;
  };
  return (
    (deps.config as { channels?: Record<string, WeixinChannelConfig | undefined> })
      .channels?.["openclaw-weixin"] ?? {}
  );
}

// ---------------------------------------------------------------------------
// 收到消息确认（ack）逻辑：鉴权通过后立即发送"处理中"提示，避免 typing 不显示时
// 用户以为消息丢失。3 秒内对同一账号+对端去重，防止连发消息刷屏。
// 配置：channels.openclaw-weixin.ackEnabled (默认 true) / ackText (默认 "⏳ 正在处理中…")
// ---------------------------------------------------------------------------
const ACK_COOLDOWN_MS = 3000;
const ackLastSentAt = new Map<string, number>();

function shouldSendAck(key: string, now: number): boolean {
  const last = ackLastSentAt.get(key) ?? 0;
  if (now - last < ACK_COOLDOWN_MS) return false;
  ackLastSentAt.set(key, now);
  return true;
}

/** 读取 ack 配置并发送"处理中"确认（fire-and-forget，不阻塞主流程）。 */
function sendProcessingAck(
  deps: ProcessMessageDeps,
  to: string,
  contextToken: string | undefined,
): void {
  try {
    type WeixinChannelConfig = { ackEnabled?: boolean; ackText?: string };
    const weixinCfg =
      (deps.config as { channels?: Record<string, WeixinChannelConfig | undefined> })
        .channels?.["openclaw-weixin"] ?? {};
    const ackEnabled = weixinCfg.ackEnabled !== false; // 默认开启
    const ackText =
      typeof weixinCfg.ackText === "string" && weixinCfg.ackText.trim()
        ? weixinCfg.ackText.trim()
        : "⏳ 正在处理中…";
    if (!ackEnabled || !ackText) return;

    const key = `${deps.accountId}:${to}`;
    if (!shouldSendAck(key, Date.now())) return;

    void sendMessageWeixin({
      to,
      text: ackText,
      opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken },
    }).catch((err) => {
      deps.errLog(`ack send failed to=${to}: ${String(err)}`);
    });
    logger.info(`ack sent to=${to} textLen=${ackText.length}`);
  } catch (err) {
    deps.errLog(`sendProcessingAck error: ${String(err)}`);
  }
}

/** Dependencies for processOneMessage, injected by the monitor loop. */
export type ProcessMessageDeps = {
  accountId: string;
  config: import("openclaw/plugin-sdk/core").OpenClawConfig;
  channelRuntime: PluginRuntime["channel"];
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  typingTicket?: string;
  log: (msg: string) => void;
  errLog: (m: string) => void;
};

/** Extract text body from item_list (for slash command detection). */
function extractTextBody(itemList?: import("../api/types.js").MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      return String(item.text_item.text);
    }
  }
  return "";
}

/** Map a Weixin message item type to the chatlog entry type. */
function chatlogInboundType(itemType: number | undefined): ChatlogEntry["type"] {
  switch (itemType) {
    case MessageItemType.IMAGE:
      return "image";
    case MessageItemType.VIDEO:
      return "video";
    case MessageItemType.VOICE:
      return "voice";
    case MessageItemType.FILE:
      return "file";
    default:
      return "text";
  }
}

/**
 * Process a single inbound message: route → download media → dispatch reply.
 * Extracted from the monitor loop to keep monitoring and message handling separate.
 */
export async function processOneMessage(
  full: WeixinMessage,
  deps: ProcessMessageDeps,
): Promise<void> {
  if (!deps?.channelRuntime) {
    logger.error(
      `processOneMessage: channelRuntime is undefined, skipping message from=${full.from_user_id}`,
    );
    deps.errLog("processOneMessage: channelRuntime is undefined, skip");
    return;
  }

  const receivedAt = Date.now();
  const debug = isDebugMode(deps.accountId);
  const debugTrace: string[] = [];
  const debugTs: Record<string, number> = { received: receivedAt };

  const textBody = extractTextBody(full.item_list);

  // 先合并联系人预设 + 同步 MEMORY.md 用户清单（均幂等），再处理 slash 命令：
  // /whoami /setname 需要读到预设名字，必须放在 slash 分支之前。
  const weixinCfg = getWeixinChannelConfig(deps);
  mergeContactPresets(weixinCfg.contactPresets);
  syncUsersToMemory();

  if (textBody.startsWith("/")) {
    const slashResult = await handleSlashCommand(textBody, {
      to: full.from_user_id ?? "",
      userId: full.from_user_id ?? "",
      contextToken: full.context_token,
      baseUrl: deps.baseUrl,
      token: deps.token,
      accountId: deps.accountId,
      log: deps.log,
      errLog: deps.errLog,
    }, receivedAt, full.create_time_ms);
    if (slashResult.handled) {
      logger.info(`[weixin] Slash command handled, skipping AI pipeline`);
      return;
    }
  }

  if (debug) {
    const itemTypes = full.item_list?.map((i) => i.type).join(",") ?? "none";
    debugTrace.push(
      "── 收消息 ──",
      `│ seq=${full.seq ?? "?"} msgId=${full.message_id ?? "?"} from=${full.from_user_id ?? "?"}`,
      `│ body="${textBody.slice(0, 40)}${textBody.length > 40 ? "…" : ""}" (len=${textBody.length}) itemTypes=[${itemTypes}]`,
      `│ sessionId=${full.session_id ?? "?"} contextToken=${full.context_token ? "present" : "none"}`,
    );
  }

  const mediaOpts: WeixinInboundMediaOpts = {};

  // Find the first downloadable media item (priority: IMAGE > VIDEO > FILE > VOICE).
  // When none found in the main item_list, fall back to media referenced via a quoted message.
  const hasDownloadableMedia = (m?: { encrypt_query_param?: string; full_url?: string }) =>
    m?.encrypt_query_param || m?.full_url;
  const mainMediaItem =
    full.item_list?.find(
      (i) => i.type === MessageItemType.IMAGE && hasDownloadableMedia(i.image_item?.media),
    ) ??
    full.item_list?.find(
      (i) => i.type === MessageItemType.VIDEO && hasDownloadableMedia(i.video_item?.media),
    ) ??
    full.item_list?.find(
      (i) => i.type === MessageItemType.FILE && hasDownloadableMedia(i.file_item?.media),
    ) ??
    full.item_list?.find(
      (i) =>
        i.type === MessageItemType.VOICE &&
        hasDownloadableMedia(i.voice_item?.media) &&
        !i.voice_item?.text,
    );
  const refMediaItem = !mainMediaItem
    ? full.item_list?.find(
        (i) =>
          i.type === MessageItemType.TEXT &&
          i.ref_msg?.message_item &&
          isMediaItem(i.ref_msg.message_item!),
      )?.ref_msg?.message_item
    : undefined;

  const mediaDownloadStart = Date.now();
  const mediaItem = mainMediaItem ?? refMediaItem;
  if (mediaItem) {
    const label = refMediaItem ? "ref" : "inbound";
    const downloaded = await downloadMediaFromItem(mediaItem, {
      cdnBaseUrl: deps.cdnBaseUrl,
      saveMedia: deps.channelRuntime.media.saveMediaBuffer,
      log: deps.log,
      errLog: deps.errLog,
      label,
    });
    Object.assign(mediaOpts, downloaded);
  }
  const mediaDownloadMs = Date.now() - mediaDownloadStart;

  if (debug) {
    debugTrace.push(mediaItem
      ? `│ mediaDownload: type=${mediaItem.type} cost=${mediaDownloadMs}ms`
      : "│ mediaDownload: none",
    );
  }

  const ctx = weixinMessageToMsgContext(full, deps.accountId, mediaOpts);

  // --- Framework command authorization ---
  const rawBody = ctx.Body?.trim() ?? "";
  ctx.CommandBody = rawBody;

  const senderId = full.from_user_id ?? "";

  const { senderAllowedForCommands, commandAuthorized } =
    await resolveSenderCommandAuthorizationWithRuntime({
      cfg: deps.config,
      rawBody,
      isGroup: false,
      dmPolicy: "pairing",
      configuredAllowFrom: [],
      configuredGroupAllowFrom: [],
      senderId,
      isSenderAllowed: (id: string, list: string[]) => list.length === 0 || list.includes(id),
      /** Pairing: framework credentials `*-allowFrom.json`, with account `userId` fallback for legacy installs. */
      readAllowFromStore: async () => {
        const fromStore = readFrameworkAllowFromList(deps.accountId);
        if (fromStore.length > 0) return fromStore;
        const uid = loadWeixinAccount(deps.accountId)?.userId?.trim();
        return uid ? [uid] : [];
      },
      runtime: deps.channelRuntime.commands,
    });

  const directDmOutcome = resolveDirectDmAuthorizationOutcome({
    isGroup: false,
    dmPolicy: "pairing",
    senderAllowedForCommands,
  });

  if (directDmOutcome === "disabled" || directDmOutcome === "unauthorized") {
    logger.info(
      `authorization: dropping message from=${senderId} outcome=${directDmOutcome}`,
    );
    return;
  }

  ctx.CommandAuthorized = commandAuthorized;
  logger.debug(
    `authorization: senderId=${senderId} commandAuthorized=${String(commandAuthorized)} senderAllowed=${String(senderAllowedForCommands)}`,
  );

  // --- 用户命名 + 聊天记录（入站）---
  // 仅记录鉴权通过的消息；记录用原始正文（不含下方注入的 [名字] 前缀）。
  const contactName = getContactName(senderId);
  if (weixinCfg.chatlogEnabled !== false && senderId) {
    touchUser(senderId);
    appendChatlog({
      ts: receivedAt,
      direction: "in",
      userId: senderId,
      name: contactName,
      type: chatlogInboundType(mediaItem?.type),
      text: rawBody || undefined,
      mediaPath:
        mediaOpts.decryptedPicPath ??
        mediaOpts.decryptedVideoPath ??
        mediaOpts.decryptedFilePath ??
        mediaOpts.decryptedVoicePath,
      textLen: rawBody.length,
    });
  }

  // 鉴权通过：立即发送"处理中"确认，让用户知道消息已收到（typing 常不显示）。
  sendProcessingAck(deps, ctx.To, full.context_token);

  if (debug) {
    debugTrace.push(
      "── 鉴权 & 路由 ──",
      `│ auth: cmdAuthorized=${String(commandAuthorized)} senderAllowed=${String(senderAllowedForCommands)}`,
    );
  }

  const route = deps.channelRuntime.routing.resolveAgentRoute({
    cfg: deps.config,
    channel: "openclaw-weixin",
    accountId: deps.accountId,
    peer: { kind: "direct", id: ctx.To },
  });
  logger.debug(
    `resolveAgentRoute: agentId=${route.agentId ?? "(none)"} sessionKey=${route.sessionKey ?? "(none)"} mainSessionKey=${route.mainSessionKey ?? "(none)"}`,
  );
  if (!route.agentId) {
    logger.error(
      `resolveAgentRoute: no agentId resolved for peer=${ctx.To} accountId=${deps.accountId} — message will not be dispatched`,
    );
  }

  if (debug) {
    debugTrace.push(
      `│ route: agent=${route.agentId ?? "none"} session=${route.sessionKey ?? "none"}`,
    );
    debugTs.preDispatch = Date.now();
  }
  // Propagate the resolved session key into ctx so dispatchReplyFromConfig uses
  // the correct session (matching the dmScope from config) instead of falling back
  // to agent:main:main.
  ctx.SessionKey = route.sessionKey;

  // 用户命名注入：把 [显示名] 前缀写进 ctx.Body，让 AI 在模型上下文里知道说话人是谁。
  const injectContactName = weixinCfg.contactNameInjection !== false && contactName;
  if (injectContactName) {
    const body = ctx.Body?.trim() ?? "";
    ctx.Body = body ? `[${contactName}] ${body}` : `[${contactName}]`;
  }
  const storePath = deps.channelRuntime.session.resolveStorePath(deps.config.session?.store, {
    agentId: route.agentId,
  });
  const finalized = deps.channelRuntime.reply.finalizeInboundContext(
    ctx as Parameters<typeof deps.channelRuntime.reply.finalizeInboundContext>[0],
  );

  logger.info(
    `inbound: from=${finalized.From} to=${finalized.To} bodyLen=${(finalized.Body ?? "").length} hasMedia=${Boolean(finalized.MediaPath ?? finalized.MediaUrl)}`,
  );
  logger.debug(`inbound context: ${redactBody(JSON.stringify(finalized))}`);

  await deps.channelRuntime.session.recordInboundSession({
    storePath,
    sessionKey: route.sessionKey,
    ctx: finalized as Parameters<typeof deps.channelRuntime.session.recordInboundSession>[0]["ctx"],
    updateLastRoute: {
      sessionKey: route.mainSessionKey,
      channel: "openclaw-weixin",
      to: ctx.To,
      accountId: deps.accountId,
    },
    onRecordError: (err) => deps.errLog(`recordInboundSession: ${String(err)}`),
  });
  logger.debug(
    `recordInboundSession: done storePath=${storePath} sessionKey=${route.sessionKey ?? "(none)"}`,
  );

  const contextToken = getContextTokenFromMsgContext(ctx);
  if (contextToken) {
    setContextToken(deps.accountId, full.from_user_id ?? "", contextToken);
  }
  const runId = randomUUID();
  const replyProgressSender = resolveReplyProgressMessagesEnabled(deps.config)
    ? new WeixinReplyProgressSender({
        runId,
        to: ctx.To,
        accountId: deps.accountId,
        opts: {
          baseUrl: deps.baseUrl,
          token: deps.token,
          contextToken,
        },
      })
    : undefined;
  const humanDelay = deps.channelRuntime.reply.resolveHumanDelayConfig(deps.config, route.agentId);

  const hasTypingTicket = Boolean(deps.typingTicket);
  const typingCallbacks = createTypingCallbacks({
    start: hasTypingTicket
      ? () =>
          sendTyping({
            baseUrl: deps.baseUrl,
            token: deps.token,
            body: {
              ilink_user_id: ctx.To,
              typing_ticket: deps.typingTicket!,
              status: TypingStatus.TYPING,
            },
          })
      : async () => {},
    stop: hasTypingTicket
      ? () =>
          sendTyping({
            baseUrl: deps.baseUrl,
            token: deps.token,
            body: {
              ilink_user_id: ctx.To,
              typing_ticket: deps.typingTicket!,
              status: TypingStatus.CANCEL,
            },
          })
      : async () => {},
    onStartError: (err) => deps.log(`[weixin] typing send error: ${String(err)}`),
    onStopError: (err) => deps.log(`[weixin] typing cancel error: ${String(err)}`),
    keepaliveIntervalMs: 5000,
  });

  /** Delivery records populated synchronously at deliver() entry, safe to read in finally. */
  const debugDeliveries: Array<{ textLen: number; media: string; preview: string; ts: number }> = [];

  const { dispatcher, replyOptions, markDispatchIdle } =
    deps.channelRuntime.reply.createReplyDispatcherWithTyping({
      humanDelay,
      typingCallbacks,
      deliver: async (payload) => {
        const rawText = payload.text ?? "";
        let text = (() => {
          const f = new StreamingMarkdownFilter();
          return f.feed(rawText) + f.flush();
        })();
        const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.[0];

        // 聊天记录（出站）：只在发送成功后记录。ack「处理中」不经过 deliver，天然排除。
        const recordOutbound = (outText: string, outMediaUrl?: string) => {
          if (weixinCfg.chatlogEnabled === false || !ctx.To) return;
          appendChatlog({
            ts: Date.now(),
            direction: "out",
            userId: ctx.To,
            name: getContactName(ctx.To),
            type: outMediaUrl ? "image" : "text",
            text: outText || undefined,
            mediaPath: outMediaUrl,
            textLen: outText.length,
          });
        };

        logger.debug(`outbound payload: ${redactBody(JSON.stringify(payload))}`);
        logger.info(
          `outbound: to=${ctx.To} contextToken=${redactToken(contextToken)} textLen=${text.length} mediaUrl=${mediaUrl ? "present" : "none"}`,
        );

        if (debug) {
          debugDeliveries.push({
            textLen: text.length,
            media: mediaUrl ? "present" : "none",
            preview: `${text.slice(0, 60)}${text.length > 60 ? "…" : ""}`,
            ts: Date.now(),
          });
        }

        const sendingResult = await applyWeixinMessageSendingHook({
          to: ctx.To,
          text,
          accountId: deps.accountId,
          mediaUrl,
          runId,
        });
        if (sendingResult.cancelled) {
          logger.info(`outbound: cancelled by message_sending hook to=${ctx.To}`);
          return;
        }
        text = sendingResult.text;

        try {
          if (mediaUrl) {
            let filePath: string;
            if (!mediaUrl.includes("://") || mediaUrl.startsWith("file://")) {
              if (mediaUrl.startsWith("file://")) {
                filePath = new URL(mediaUrl).pathname;
              } else if (!path.isAbsolute(mediaUrl)) {
                filePath = path.resolve(mediaUrl);
                logger.debug(`outbound: resolved relative path ${mediaUrl} -> ${filePath}`);
              } else {
                filePath = mediaUrl;
              }
              logger.debug(`outbound: local file path resolved filePath=${filePath}`);
            } else if (mediaUrl.startsWith("http://") || mediaUrl.startsWith("https://")) {
              logger.debug(`outbound: downloading remote mediaUrl=${mediaUrl.slice(0, 80)}...`);
              filePath = await downloadRemoteImageToTemp(mediaUrl, MEDIA_OUTBOUND_TEMP_DIR);
              logger.debug(`outbound: remote image downloaded to filePath=${filePath}`);
            } else {
              logger.warn(
                `outbound: unrecognized mediaUrl scheme, sending text only mediaUrl=${mediaUrl.slice(0, 80)}`,
              );
              await sendMessageWeixin({ to: ctx.To, text, opts: {
                baseUrl: deps.baseUrl,
                token: deps.token,
                contextToken,
                runId,
              }});
              emitWeixinMessageSent({ to: ctx.To, content: text, success: true, accountId: deps.accountId, runId });
              recordOutbound(text);
              logger.info(`outbound: text sent to=${ctx.To}`);
              return;
            }
            await sendWeixinMediaFile({
              filePath,
              to: ctx.To,
              text,
              opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken, runId },
              cdnBaseUrl: deps.cdnBaseUrl,
            });
            emitWeixinMessageSent({ to: ctx.To, content: text, success: true, accountId: deps.accountId, runId });
            recordOutbound(text, mediaUrl);
            logger.info(`outbound: media sent OK to=${ctx.To}`);
          } else {
            logger.debug(`outbound: sending text message to=${ctx.To}`);
            await sendMessageWeixin({ to: ctx.To, text, opts: {
              baseUrl: deps.baseUrl,
              token: deps.token,
              contextToken,
              runId,
            }});
            emitWeixinMessageSent({ to: ctx.To, content: text, success: true, accountId: deps.accountId, runId });
            recordOutbound(text);
            logger.info(`outbound: text sent OK to=${ctx.To}`);
          }
        } catch (err) {
          emitWeixinMessageSent({ to: ctx.To, content: text, success: false, error: String(err), accountId: deps.accountId, runId });
          logger.error(
            `outbound: FAILED to=${ctx.To} mediaUrl=${mediaUrl ?? "none"} err=${String(err)} stack=${(err as Error).stack ?? ""}`,
          );
          throw err;
        }
      },
      onError: (err, info) => {
        deps.errLog(`weixin reply ${info.kind}: ${String(err)}`);
        const errMsg = err instanceof Error ? err.message : String(err);
        let notice: string;
        if (errMsg.includes("remote media download failed") || errMsg.includes("fetch")) {
          notice = `⚠️ 媒体文件下载失败，请检查链接是否可访问。`;
        } else if (
          errMsg.includes("getUploadUrl") ||
          errMsg.includes("CDN upload") ||
          errMsg.includes("upload_param")
        ) {
          notice = `⚠️ 媒体文件上传失败，请稍后重试。`;
        } else {
          notice = `⚠️ 消息发送失败：${errMsg}`;
        }
        void sendWeixinErrorNotice({
          to: ctx.To,
          contextToken,
          message: notice,
          baseUrl: deps.baseUrl,
          token: deps.token,
          runId,
          errLog: deps.errLog,
        });
      },
    });

  logger.debug(`dispatchReplyFromConfig: starting agentId=${route.agentId ?? "(none)"}`);
  try {
    await deps.channelRuntime.reply.withReplyDispatcher({
      dispatcher,
      run: () =>
        deps.channelRuntime.reply.dispatchReplyFromConfig({
          ctx: finalized,
          cfg: deps.config,
          dispatcher,
          replyOptions: {
            ...replyOptions,
            ...(replyProgressSender?.replyOptions ?? {}),
            disableBlockStreaming: true,
          },
        }),
    });
    logger.debug(`dispatchReplyFromConfig: done agentId=${route.agentId ?? "(none)"}`);
  } catch (err) {
    logger.error(
      `dispatchReplyFromConfig: error agentId=${route.agentId ?? "(none)"} err=${String(err)}`,
    );
    throw err;
  } finally {
    markDispatchIdle();
    await replyProgressSender?.finalize();

    logger.info(
      `debug-check: accountId=${deps.accountId} debug=${String(debug)} hasContextToken=${Boolean(contextToken)}`,
    );

    if (debug && contextToken) {
      const dispatchDoneAt = Date.now();
      const eventTs = full.create_time_ms ?? 0;
      const platformDelay = eventTs > 0 ? `${receivedAt - eventTs}ms` : "N/A";
      const inboundProcessMs = (debugTs.preDispatch ?? receivedAt) - receivedAt;
      const aiMs = dispatchDoneAt - (debugTs.preDispatch ?? receivedAt);
      const totalTime = eventTs > 0 ? `${dispatchDoneAt - eventTs}ms` : `${dispatchDoneAt - receivedAt}ms`;

      if (debugDeliveries.length > 0) {
        debugTrace.push("── 回复 ──");
        for (const d of debugDeliveries) {
          debugTrace.push(
            `│ textLen=${d.textLen} media=${d.media}`,
            `│ text="${d.preview}"`,
          );
        }
        const firstTs = debugDeliveries[0].ts;
        debugTrace.push(`│ deliver耗时: ${dispatchDoneAt - firstTs}ms`);
      } else {
        debugTrace.push("── 回复 ──", "│ (deliver未捕获)");
      }

      debugTrace.push(
        "── 耗时 ──",
        `├ 平台→插件: ${platformDelay}`,
        `├ 入站处理(auth+route+media): ${inboundProcessMs}ms (mediaDownload: ${mediaDownloadMs}ms)`,
        `├ AI生成+回复: ${aiMs}ms`,
        `├ 总耗时: ${totalTime}`,
        `└ eventTime: ${eventTs > 0 ? new Date(eventTs).toISOString() : "N/A"}`,
      );

      const timingText = `⏱ Debug 全链路\n${debugTrace.join("\n")}`;

      logger.info(`debug-timing: sending to=${ctx.To}`);
      try {
        await sendMessageWeixin({
          to: ctx.To,
          text: timingText,
          opts: { baseUrl: deps.baseUrl, token: deps.token, contextToken, runId },
        });
        logger.info(`debug-timing: sent OK`);
      } catch (debugErr) {
        logger.error(`debug-timing: send FAILED err=${String(debugErr)}`);
      }
    }
  }
}
