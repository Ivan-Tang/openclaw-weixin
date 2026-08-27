import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { setContactName } from "./contacts.js";
import { syncUsersToMemory } from "./memory-sync.js";

let tmpDir: string;
let workspaceDir: string;

describe("memory-sync", () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocw-memory-"));
    workspaceDir = path.join(tmpDir, "workspace");
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    process.env.OPENCLAW_WORKSPACE_DIR = workspaceDir;
  });

  afterAll(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    delete process.env.OPENCLAW_WORKSPACE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes the user list section into a new MEMORY.md", () => {
    setContactName("user1", "Alice");
    syncUsersToMemory();

    const filePath = path.join(workspaceDir, "MEMORY.md");
    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("<!-- openclaw-weixin:users:start -->");
    expect(content).toContain("- Alice — `user1`");
    expect(content).toContain("<!-- openclaw-weixin:users:end -->");
  });

  it("replaces only the managed section, keeping the rest of MEMORY.md intact", () => {
    const filePath = path.join(workspaceDir, "MEMORY.md");
    fs.writeFileSync(
      filePath,
      "# Memory\n\nSome long-term memory here.\n\n<!-- openclaw-weixin:users:start -->\n\n<!-- openclaw-weixin:users:end -->\n\nTrailing notes.\n",
    );
    setContactName("user1", "Alice");
    setContactName("user2", "Bob");
    syncUsersToMemory();

    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("Some long-term memory here.");
    expect(content).toContain("Trailing notes.");
    expect(content).toContain("- Alice — `user1`");
    expect(content).toContain("- Bob — `user2`");
  });

  it("is idempotent: a second sync adds no extra write", () => {
    setContactName("user1", "Alice");
    const writeSpy = vi.spyOn(fs, "writeFileSync");
    syncUsersToMemory();
    const writesAfterFirst = writeSpy.mock.calls.length;
    syncUsersToMemory();
    expect(writeSpy.mock.calls.length).toBe(writesAfterFirst);
    writeSpy.mockRestore();
  });

  it("appends the managed section to the end of a file without markers", () => {
    const filePath = path.join(workspaceDir, "MEMORY.md");
    fs.writeFileSync(filePath, "# Plain memory\n");
    syncUsersToMemory();
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("# Plain memory");
    expect(content).toContain("<!-- openclaw-weixin:users:start -->");
    expect(content).toContain("<!-- openclaw-weixin:users:end -->");
  });

  it("does not throw when writing fails", () => {
    setContactName("userWriteFail", "WriteFail");
    const spy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation(() => {
        throw new Error("disk full");
      });
    expect(() => syncUsersToMemory()).not.toThrow();
    spy.mockRestore();
  });
});
