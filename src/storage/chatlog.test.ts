import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { appendChatlog, readChatlog, renameChatlogForUser, type ChatlogEntry } from "./chatlog.js";

let tmpDir: string;

function makeEntry(overrides: Partial<ChatlogEntry>): ChatlogEntry {
  return {
    ts: 1_000_000,
    direction: "in",
    userId: "user1",
    name: "Bob",
    type: "text",
    text: "hello",
    textLen: 5,
    ...overrides,
  };
}

describe("chatlog", () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocw-chatlog-"));
    process.env.OPENCLAW_STATE_DIR = tmpDir;
  });

  afterAll(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends and reads back entries newest-first", () => {
    appendChatlog(makeEntry({ ts: 100 }));
    appendChatlog(makeEntry({ ts: 200, direction: "out", text: "hi back", textLen: 7 }));
    appendChatlog(makeEntry({ ts: 300 }));

    const entries = readChatlog("user1", "Bob", 10);
    expect(entries.map((e) => e.ts)).toEqual([300, 200, 100]);
    expect(entries[1].direction).toBe("out");
    expect(entries[1].text).toBe("hi back");
  });

  it("honors the limit and normalizes the userId", () => {
    appendChatlog(makeEntry({ ts: 1 }));
    appendChatlog(makeEntry({ ts: 2 }));
    appendChatlog(makeEntry({ ts: 3 }));

    const limited = readChatlog("USER1", "Bob", 2);
    expect(limited.map((e) => e.ts)).toEqual([3, 2]);
  });

  it("returns an empty list for a user with no log", () => {
    expect(readChatlog("nobody", undefined, 10)).toEqual([]);
  });

  it("skips empty userIds", () => {
    expect(() => appendChatlog(makeEntry({ userId: "  " }))).not.toThrow();
  });

  it("sanitizes unsafe characters in the display-name file key", () => {
    const weirdName = 'a/b\\c:d*e?"f|g<>h';
    appendChatlog(makeEntry({ name: weirdName, text: "x", textLen: 1 }));
    const dir = path.join(tmpDir, "openclaw-weixin", "chatlogs");
    const files = fs.readdirSync(dir);
    expect(files).toContain("a_b_c_d_e__f_g__h.jsonl");
  });

  it("renames the archive file when a user renames", () => {
    appendChatlog(makeEntry({ name: "OldName", text: "before" }));
    renameChatlogForUser("user1", "OldName", "NewName");

    expect(readChatlog("user1", "NewName", 10).length).toBe(1);
    expect(readChatlog("user1", "OldName", 10)).toEqual([]);
  });

  it("ignores rename when the target already exists", () => {
    appendChatlog(makeEntry({ name: "Src", text: "s" }));
    appendChatlog(makeEntry({ name: "Dst", text: "d" }));
    renameChatlogForUser("user1", "Src", "Dst");

    expect(readChatlog("user1", "Src", 10).length).toBe(1);
    expect(readChatlog("user1", "Dst", 10).length).toBe(1);
  });

  it("does not throw when appending fails", () => {
    const spy = vi
      .spyOn(fs, "appendFileSync")
      .mockImplementation(() => {
        throw new Error("disk full");
      });
    expect(() => appendChatlog(makeEntry({}))).not.toThrow();
    spy.mockRestore();
  });

  it("does not throw when renaming fails", () => {
    appendChatlog(makeEntry({ name: "Src", text: "s" }));
    const spy = vi
      .spyOn(fs, "renameSync")
      .mockImplementation(() => {
        throw new Error("permission denied");
      });
    expect(() => renameChatlogForUser("user1", "Src", "Dst")).not.toThrow();
    spy.mockRestore();
  });

  it("skips malformed lines while reading", () => {
    const dir = path.join(tmpDir, "openclaw-weixin", "chatlogs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "Bob.jsonl"), '{"ts":1}\nnot-json\n{"ts":3}\n');
    const entries = readChatlog("user1", "Bob", 10);
    expect(entries.map((e) => e.ts)).toEqual([3, 1]);
  });

  it("does not throw when reading fails", () => {
    appendChatlog(makeEntry({}));
    const spy = vi
      .spyOn(fs, "readFileSync")
      .mockImplementation(() => {
        throw new Error("EIO");
      });
    expect(readChatlog("user1", "Bob", 10)).toEqual([]);
    spy.mockRestore();
  });
});
