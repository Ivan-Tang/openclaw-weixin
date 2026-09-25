import { describe, expect, it, vi, beforeEach } from "vitest";

const getUpdatesMock = vi.hoisted(() => vi.fn());
const processOneMessageMock = vi.hoisted(() => vi.fn());

vi.mock("../api/api.js", () => ({
  getUpdates: getUpdatesMock,
  classifyFetchError: () => ({ type: "unknown" }),
}));
vi.mock("../messaging/process-message.js", () => ({
  processOneMessage: processOneMessageMock,
}));
vi.mock("../api/config-cache.js", () => ({
  WeixinConfigManager: class {
    async getForUser() {
      return { typingTicket: undefined };
    }
  },
}));
vi.mock("../storage/sync-buf.js", () => ({
  getSyncBufFilePath: () => "/tmp/ocw-test.sync.json",
  loadGetUpdatesBuf: () => "",
  saveGetUpdatesBuf: () => {},
}));

import { monitorWeixinProvider } from "./monitor.js";

function baseOpts(abortSignal?: AbortSignal) {
  return {
    baseUrl: "https://example.invalid",
    cdnBaseUrl: "https://example.invalid",
    token: "t",
    accountId: "test-im-bot",
    config: {} as never,
    channelRuntime: { fake: true } as never,
    abortSignal,
    longPollTimeoutMs: 50,
  };
}

const oneMsgResp = {
  ret: 0,
  get_updates_buf: "buf1",
  msgs: [{ from_user_id: "u1@im.wechat", item_list: [{ type: 1 }] }],
};

beforeEach(() => {
  getUpdatesMock.mockReset();
  processOneMessageMock.mockReset();
});

describe("monitorWeixinProvider abort handling", () => {
  it("exits promptly when aborted while processOneMessage is still running (hot-reload stop bug)", async () => {
    const controller = new AbortController();
    getUpdatesMock.mockResolvedValueOnce(oneMsgResp);
    let finishProcess: () => void = () => {};
    processOneMessageMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishProcess = resolve;
        }),
    );

    const monitorP = monitorWeixinProvider(baseOpts(controller.signal));
    // wait until the monitor entered processOneMessage
    await vi.waitFor(() => expect(processOneMessageMock).toHaveBeenCalled());

    controller.abort();
    // Regression: this used to hang until the agent turn finished (minutes),
    // blowing the gateway's 5s stop budget so the account never restarted.
    await Promise.race([
      monitorP,
      new Promise((_, rej) => setTimeout(() => rej(new Error("monitor did not exit")), 1000)),
    ]);

    // The detached turn was not cancelled by the monitor itself (it keeps
    // running in background); resolve it to clean up.
    finishProcess();
  }, 10_000);

  it("does not start processing queued messages after abort", async () => {
    const controller = new AbortController();
    getUpdatesMock.mockResolvedValueOnce({
      ...oneMsgResp,
      msgs: [
        { from_user_id: "u1@im.wechat", item_list: [] },
        { from_user_id: "u2@im.wechat", item_list: [] },
      ],
    });
    processOneMessageMock.mockImplementation(async () => {
      controller.abort();
    });

    await monitorWeixinProvider(baseOpts(controller.signal));
    expect(processOneMessageMock).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("exits without processing when aborted during getUpdates", async () => {
    const controller = new AbortController();
    getUpdatesMock.mockImplementation(
      () =>
        new Promise((_, rej) => {
          controller.signal.addEventListener("abort", () => rej(new Error("aborted")), {
            once: true,
          });
        }),
    );

    const monitorP = monitorWeixinProvider(baseOpts(controller.signal));
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await monitorP;
    expect(processOneMessageMock).not.toHaveBeenCalled();
  }, 10_000);
});
