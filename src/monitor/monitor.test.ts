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

/** getUpdates response with no messages (keeps the poll loop spinning). */
const emptyResp = { ret: 0, get_updates_buf: "buf-empty", msgs: [] };

/** Mock getUpdates impl that rejects when the signal aborts (like a real fetch). */
function pendingUntilAborted(signal: AbortSignal) {
  return new Promise((_, rej) => {
    signal.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
  });
}

beforeEach(() => {
  getUpdatesMock.mockReset();
  processOneMessageMock.mockReset();
});

describe("monitorWeixinProvider detached turns", () => {
  it("keeps polling while an agent turn is still running (steering requires an unblocked poll loop)", async () => {
    const controller = new AbortController();
    let finishProcess: () => void = () => {};
    processOneMessageMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishProcess = resolve;
        }),
    );
    getUpdatesMock
      .mockResolvedValueOnce(oneMsgResp)
      .mockResolvedValueOnce(emptyResp)
      .mockImplementation(() => pendingUntilAborted(controller.signal));

    const monitorP = monitorWeixinProvider(baseOpts(controller.signal));
    // Regression: the loop used to await processOneMessage (minutes), so no
    // further getUpdates happened while a turn was active and mid-run messages
    // (incl. /steer, /stop) were stranded server-side.
    await vi.waitFor(() => expect(getUpdatesMock).toHaveBeenCalledTimes(3));
    expect(processOneMessageMock).toHaveBeenCalledTimes(1);

    controller.abort();
    await monitorP;
    finishProcess(); // let the detached turn settle for cleanup
  }, 10_000);

  it("exits promptly on abort without cancelling the running turn", async () => {
    const controller = new AbortController();
    let turnCompleted = false;
    let finishProcess: () => void = () => {};
    processOneMessageMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishProcess = () => {
            turnCompleted = true;
            resolve();
          };
        }),
    );
    getUpdatesMock
      .mockResolvedValueOnce(oneMsgResp)
      .mockImplementation(() => pendingUntilAborted(controller.signal));

    const monitorP = monitorWeixinProvider(baseOpts(controller.signal));
    await vi.waitFor(() => expect(processOneMessageMock).toHaveBeenCalled());

    controller.abort();
    await Promise.race([
      monitorP,
      new Promise((_, rej) => setTimeout(() => rej(new Error("monitor did not exit")), 1000)),
    ]);
    // The detached turn keeps running (hot-reload stop bug fix semantics).
    expect(turnCompleted).toBe(false);
    finishProcess();
    expect(turnCompleted).toBe(true);
  }, 10_000);

  it("does not dispatch further messages in a batch after abort", async () => {
    const controller = new AbortController();
    getUpdatesMock.mockResolvedValueOnce({
      ...oneMsgResp,
      msgs: [
        { from_user_id: "u1@im.wechat", item_list: [] },
        { from_user_id: "u2@im.wechat", item_list: [] },
      ],
    });
    // Runs synchronously at dispatch; abort lands before the 2nd iteration.
    processOneMessageMock.mockImplementation(() => {
      controller.abort();
      return Promise.resolve();
    });

    await monitorWeixinProvider(baseOpts(controller.signal));
    expect(processOneMessageMock).toHaveBeenCalledTimes(1);
  }, 10_000);

  it("a rejected background turn does not crash the monitor", async () => {
    const controller = new AbortController();
    getUpdatesMock
      .mockResolvedValueOnce(oneMsgResp)
      .mockImplementation(() => pendingUntilAborted(controller.signal));
    processOneMessageMock.mockRejectedValueOnce(new Error("boom"));

    const monitorP = monitorWeixinProvider(baseOpts(controller.signal));
    await vi.waitFor(() => expect(processOneMessageMock).toHaveBeenCalled());
    controller.abort();
    await monitorP; // resolves cleanly despite the background rejection
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
