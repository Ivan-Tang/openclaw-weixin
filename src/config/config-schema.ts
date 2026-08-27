import { z } from "zod";

import { CDN_BASE_URL, DEFAULT_BASE_URL } from "../auth/accounts.js";

// ---------------------------------------------------------------------------
// Zod config schema
// ---------------------------------------------------------------------------

const weixinAccountSchema = z.object({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  cdnBaseUrl: z.string().default(CDN_BASE_URL),
  routeTag: z.number().optional(),
});

/** Top-level weixin config schema (token is stored in credentials file, not config). */
export const WeixinConfigSchema = weixinAccountSchema.extend({
  accounts: z.record(z.string(), weixinAccountSchema).optional(),
  replyProgressMessages: z.boolean().default(true),
  /** ISO 8601; bumped on each successful login to refresh gateway config from disk. */
  channelConfigUpdatedAt: z.string().optional(),
  /** 收到消息时先发送"处理中"确认（ack）。ackEnabled=false 关闭；ackText 为发送内容。 */
  ackEnabled: z.boolean().optional(),
  ackText: z.string().optional(),
  /** 是否归档聊天记录到 openclaw-weixin/chatlogs/*.jsonl（默认 true）。 */
  chatlogEnabled: z.boolean().optional(),
  /** 入站消息是否注入 [显示名] 前缀，让 AI 知道说话人是谁（默认 true）。 */
  contactNameInjection: z.boolean().optional(),
  /** 静态用户命名预设：{ [微信userId]: 显示名 }，运行期 /setname 可覆盖。 */
  contactPresets: z.record(z.string(), z.string()).optional(),
});
