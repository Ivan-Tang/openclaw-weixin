import { describe, it, expect, vi, beforeEach } from "vitest";

import { handleSlashCommand } from "./slash-commands.js";
import type { SlashCommandContext } from "./slash-commands.js";
import { isDebugMode, _resetForTest as resetDebugMode } from "./debug-mode.js";

const mockSendMessageWeixin = vi.hoisted(() => vi.fn().mockResolvedValue({ messageId: "test-id" }));

vi.mock("./send.js", () => ({
  sendMessageWeixin: mockSendMessageWeixin,
}));

vi.mock("../util/logger.js", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

const mockGetContactName = vi.hoisted(() => vi.fn());
const mockSetContactName = vi.hoisted(() => vi.fn());
const mockListContacts = vi.hoisted(() => vi.fn());
const mockReadChatlog = vi.hoisted(() => vi.fn());
const mockRenameChatlog = vi.hoisted(() => vi.fn());
const mockSyncUsersToMemory = vi.hoisted(() => vi.fn());
const mockLoadAccount = vi.hoisted(() => vi.fn());
const mockReadAllowFrom = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("../storage/contacts.js", () => ({
  getContactName: mockGetContactName,
  setContactName: mockSetContactName,
  listContacts: mockListContacts,
}));

vi.mock("../storage/chatlog.js", () => ({
  readChatlog: mockReadChatlog,
  renameChatlogForUser: mockRenameChatlog,
}));

vi.mock("../storage/memory-sync.js", () => ({
  syncUsersToMemory: mockSyncUsersToMemory,
}));

vi.mock("../auth/accounts.js", () => ({
  loadWeixinAccount: mockLoadAccount,
}));

vi.mock("../auth/pairing.js", () => ({
  readFrameworkAllowFromList: mockReadAllowFrom,
}));

vi.mock("node:child_process", () => ({
  spawn: mockSpawn,
}));

describe("handleSlashCommand", () => {
  let ctx: SlashCommandContext;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDebugMode();
    ctx = {
      to: "user123",
      userId: "user123",
      contextToken: "token123",
      baseUrl: "https://api.example.com",
      token: "bot-token",
      accountId: "acc1",
      log: vi.fn(),
      errLog: vi.fn(),
    };
  });

  it("returns handled=false for non-slash messages", async () => {
    const result = await handleSlashCommand("hello world", ctx, Date.now());
    expect(result.handled).toBe(false);
    expect(mockSendMessageWeixin).not.toHaveBeenCalled();
  });

  it("returns handled=false for unknown slash commands", async () => {
    const result = await handleSlashCommand("/unknown arg", ctx, Date.now());
    expect(result.handled).toBe(false);
    expect(mockSendMessageWeixin).not.toHaveBeenCalled();
  });

  it("handles /echo with message and timing", async () => {
    const receivedAt = Date.now();
    const eventTimestamp = receivedAt - 100;
    const result = await handleSlashCommand("/echo hello", ctx, receivedAt, eventTimestamp);

    expect(result.handled).toBe(true);
    expect(mockSendMessageWeixin).toHaveBeenCalledTimes(2);

    const firstCall = mockSendMessageWeixin.mock.calls[0][0];
    expect(firstCall.to).toBe("user123");
    expect(firstCall.text).toBe("hello");
    expect(firstCall.opts.contextToken).toBe("token123");

    const secondCall = mockSendMessageWeixin.mock.calls[1][0];
    expect(secondCall.text).toContain("⏱ 通道耗时");
    expect(secondCall.text).toContain("平台→插件");
  });

  it("handles /echo without message (timing only)", async () => {
    const receivedAt = Date.now();
    const result = await handleSlashCommand("/echo", ctx, receivedAt);

    expect(result.handled).toBe(true);
    expect(mockSendMessageWeixin).toHaveBeenCalledTimes(1);

    const call = mockSendMessageWeixin.mock.calls[0][0];
    expect(call.text).toContain("⏱ 通道耗时");
  });

  it("handles /echo case-insensitively", async () => {
    const result = await handleSlashCommand("/ECHO test", ctx, Date.now());
    expect(result.handled).toBe(true);
    expect(mockSendMessageWeixin).toHaveBeenCalledTimes(2);
  });

  it("shows N/A when eventTimestamp is not provided", async () => {
    const result = await handleSlashCommand("/echo", ctx, Date.now());

    expect(result.handled).toBe(true);
    const call = mockSendMessageWeixin.mock.calls[0][0];
    expect(call.text).toContain("N/A");
  });

  it("sends error message when command execution fails", async () => {
    mockSendMessageWeixin.mockRejectedValueOnce(new Error("network error"));

    const result = await handleSlashCommand("/echo hello", ctx, Date.now());

    expect(result.handled).toBe(true);
    expect(mockSendMessageWeixin).toHaveBeenCalledTimes(2);
    const errorCall = mockSendMessageWeixin.mock.calls[1][0];
    expect(errorCall.text).toContain("❌ 指令执行失败");
  });

  it("handles error when sending error message also fails", async () => {
    mockSendMessageWeixin.mockRejectedValue(new Error("network error"));

    const result = await handleSlashCommand("/echo hello", ctx, Date.now());

    expect(result.handled).toBe(true);
  });

  it("trims whitespace from content", async () => {
    const result = await handleSlashCommand("  /echo hello  ", ctx, Date.now());
    expect(result.handled).toBe(true);
  });

  it("/toggle-debug enables debug mode and replies", async () => {
    const result = await handleSlashCommand("/toggle-debug", ctx, Date.now());
    expect(result.handled).toBe(true);
    expect(isDebugMode("acc1")).toBe(true);

    const call = mockSendMessageWeixin.mock.calls[0][0];
    expect(call.text).toContain("Debug 模式已开启");
  });

  it("/toggle-debug disables debug mode when already on", async () => {
    await handleSlashCommand("/toggle-debug", ctx, Date.now());
    mockSendMessageWeixin.mockClear();

    const result = await handleSlashCommand("/toggle-debug", ctx, Date.now());
    expect(result.handled).toBe(true);
    expect(isDebugMode("acc1")).toBe(false);

    const call = mockSendMessageWeixin.mock.calls[0][0];
    expect(call.text).toContain("Debug 模式已关闭");
  });

  it("/toggle-debug is case-insensitive", async () => {
    const result = await handleSlashCommand("/TOGGLE-DEBUG", ctx, Date.now());
    expect(result.handled).toBe(true);
    expect(isDebugMode("acc1")).toBe(true);
  });

  describe("自定义管理命令", () => {
    beforeEach(() => {
      // 默认：allowFrom 为空 → 鉴权 fallback 到账号绑定的 userId（= ctx.userId）
      mockReadAllowFrom.mockReturnValue([]);
      mockLoadAccount.mockReturnValue({ userId: "user123" });
      mockGetContactName.mockReturnValue(undefined);
      mockListContacts.mockReturnValue([]);
      mockReadChatlog.mockReturnValue([]);
      mockSpawn.mockReturnValue({ unref: vi.fn(), pid: 12345 });
    });

    it("/whoami 显示 userId，未命名时提示", async () => {
      const result = await handleSlashCommand("/whoami", ctx, Date.now());
      expect(result.handled).toBe(true);
      const call = mockSendMessageWeixin.mock.calls[0][0];
      expect(call.text).toContain("user123");
      expect(call.text).toContain("（未命名）");
    });

    it("/whoami 显示已命名的名字", async () => {
      mockGetContactName.mockReturnValue("Alice");
      const result = await handleSlashCommand("/whoami", ctx, Date.now());
      expect(result.handled).toBe(true);
      const call = mockSendMessageWeixin.mock.calls[0][0];
      expect(call.text).toContain("Alice");
    });

    it("/setname 命名并同步 chatlog 文件名与 MEMORY.md", async () => {
      mockGetContactName.mockReturnValue("OldName");
      const result = await handleSlashCommand("/setname 小明", ctx, Date.now());
      expect(result.handled).toBe(true);
      expect(mockSetContactName).toHaveBeenCalledWith("user123", "小明");
      expect(mockRenameChatlog).toHaveBeenCalledWith("user123", "OldName", "小明");
      expect(mockSyncUsersToMemory).toHaveBeenCalledTimes(1);
      const call = mockSendMessageWeixin.mock.calls[0][0];
      expect(call.text).toContain("小明");
    });

    it("/setname 空名字提示用法", async () => {
      const result = await handleSlashCommand("/setname", ctx, Date.now());
      expect(result.handled).toBe(true);
      expect(mockSetContactName).not.toHaveBeenCalled();
      const call = mockSendMessageWeixin.mock.calls[0][0];
      expect(call.text).toContain("用法：/setname");
    });

    it("/setname 超长名字被拒", async () => {
      const result = await handleSlashCommand(`/setname ${"长".repeat(31)}`, ctx, Date.now());
      expect(result.handled).toBe(true);
      expect(mockSetContactName).not.toHaveBeenCalled();
      const call = mockSendMessageWeixin.mock.calls[0][0];
      expect(call.text).toContain("过长");
    });

    it("/setname 拒绝包含换行的名字", async () => {
      const result = await handleSlashCommand("/setname 小明\nbad", ctx, Date.now());
      expect(result.handled).toBe(true);
      expect(mockSetContactName).not.toHaveBeenCalled();
      const call = mockSendMessageWeixin.mock.calls[0][0];
      expect(call.text).toContain("换行");
    });

    it("/listusers 无用户时提示空", async () => {
      const result = await handleSlashCommand("/listusers", ctx, Date.now());
      expect(result.handled).toBe(true);
      const call = mockSendMessageWeixin.mock.calls[0][0];
      expect(call.text).toContain("还没有已知用户");
    });

    it("/listusers 列出已知用户", async () => {
      mockListContacts.mockReturnValue([
        { userId: "user123", name: "Alice", createdAt: 0, updatedAt: 0, lastSeenAt: 1_700_000_000_000 },
      ]);
      const result = await handleSlashCommand("/listusers", ctx, Date.now());
      expect(result.handled).toBe(true);
      const call = mockSendMessageWeixin.mock.calls[0][0];
      expect(call.text).toContain("已知用户 (1)");
      expect(call.text).toContain("Alice");
      expect(call.text).toContain("user123");
    });

    it("/history 无记录时提示空", async () => {
      const result = await handleSlashCommand("/history", ctx, Date.now());
      expect(result.handled).toBe(true);
      const call = mockSendMessageWeixin.mock.calls[0][0];
      expect(call.text).toContain("暂无聊天记录");
    });

    it("/history 默认读取最近 20 条并格式化输出", async () => {
      mockReadChatlog.mockReturnValue([
        { ts: 1_700_000_000_000, direction: "in", userId: "user123", name: "Alice", type: "text", text: "你好", textLen: 2 },
      ]);
      const result = await handleSlashCommand("/history", ctx, Date.now());
      expect(result.handled).toBe(true);
      expect(mockReadChatlog).toHaveBeenCalledWith("user123", undefined, 20);
      const call = mockSendMessageWeixin.mock.calls[0][0];
      expect(call.text).toContain("最近 1 条记录");
      expect(call.text).toContain("你好");
    });

    it("/history 指定数量，封顶 50，非法输入回退默认", async () => {
      await handleSlashCommand("/history 5", ctx, Date.now());
      expect(mockReadChatlog).toHaveBeenLastCalledWith("user123", undefined, 5);
      await handleSlashCommand("/history 999", ctx, Date.now());
      expect(mockReadChatlog).toHaveBeenLastCalledWith("user123", undefined, 50);
      await handleSlashCommand("/history 0", ctx, Date.now());
      expect(mockReadChatlog).toHaveBeenLastCalledWith("user123", undefined, 20);
    });

    it("/restart 调度重启并提示", async () => {
      const result = await handleSlashCommand("/restart", ctx, Date.now());
      expect(result.handled).toBe(true);
      expect(mockSpawn).toHaveBeenCalledWith(
        "sh",
        ["-c", "sleep 3; systemctl --no-block restart openclaw-gateway"],
        { detached: true, stdio: "ignore" },
      );
      const call = mockSendMessageWeixin.mock.calls[0][0];
      expect(call.text).toContain("正在重启网关");
    });

    it("/restart 在 spawn 失败时记录 errLog 并仍回复", async () => {
      mockSpawn.mockImplementation(() => {
        throw new Error("EPERM");
      });
      const result = await handleSlashCommand("/restart", ctx, Date.now());
      expect(result.handled).toBe(true);
      expect(ctx.errLog).toHaveBeenCalled();
      const call = mockSendMessageWeixin.mock.calls[0][0];
      expect(call.text).toContain("正在重启网关");
    });

    it("/history 显示出站消息与非文本记录", async () => {
      mockReadChatlog.mockReturnValue([
        { ts: 1_700_000_000_000, direction: "out", userId: "user123", name: "", type: "image", text: "", textLen: 0 },
      ]);
      const result = await handleSlashCommand("/history", ctx, Date.now());
      expect(result.handled).toBe(true);
      const call = mockSendMessageWeixin.mock.calls[0][0];
      expect(call.text).toContain("📤");
      expect(call.text).toContain("[image]");
    });

    it("/history 文本超长时截断到 60 字符", async () => {
      mockReadChatlog.mockReturnValue([
        { ts: 1_700_000_000_000, direction: "in", userId: "user123", name: "Alice", type: "text", text: "x".repeat(80), textLen: 80 },
      ]);
      await handleSlashCommand("/history", ctx, Date.now());
      const call = mockSendMessageWeixin.mock.calls[0][0];
      expect(call.text).toContain("x".repeat(60));
      expect(call.text).not.toContain("x".repeat(61));
    });

    it("/listusers lastSeenAt 缺失时显示问号", async () => {
      mockListContacts.mockReturnValue([
        { userId: "user1", name: "Zed", createdAt: 0, updatedAt: 0, lastSeenAt: 0 },
      ]);
      await handleSlashCommand("/listusers", ctx, Date.now());
      const call = mockSendMessageWeixin.mock.calls[0][0];
      expect(call.text).toContain("最后活跃 ?");
    });

    it("allowFrom 非空时优先于账号，未授权被拒", async () => {
      mockReadAllowFrom.mockReturnValue(["someone-else"]);
      const result = await handleSlashCommand("/setname 小黑", ctx, Date.now());
      expect(result.handled).toBe(true);
      expect(mockSetContactName).not.toHaveBeenCalled();
      const call = mockSendMessageWeixin.mock.calls[0][0];
      expect(call.text).toContain("⛔ 你没有权限");
    });

    it("allowFrom 与账号都为空时放行（不设限）", async () => {
      mockReadAllowFrom.mockReturnValue([]);
      mockLoadAccount.mockReturnValue({ userId: "  " });
      const result = await handleSlashCommand("/listusers", ctx, Date.now());
      expect(result.handled).toBe(true);
      expect(mockListContacts).toHaveBeenCalled();
    });
  });
});
