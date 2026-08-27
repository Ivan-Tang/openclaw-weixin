import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type ContactsApi = typeof import("./contacts.js");

let tmpDir: string;
let api: ContactsApi;

describe("contacts", () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ocw-contacts-"));
  });

  beforeEach(async () => {
    process.env.OPENCLAW_STATE_DIR = tmpDir;
    // Reset the module so the in-memory contactsCache starts empty per test.
    vi.resetModules();
    api = await import("./contacts.js");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllTimers();
    fs.rmSync(path.join(tmpDir, "openclaw-weixin"), { recursive: true, force: true });
  });

  afterAll(() => {
    delete process.env.OPENCLAW_STATE_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sets a contact name and reads it back", () => {
    api.setContactName("user1", "Bob");
    expect(api.getContactName("user1")).toBe("Bob");
    const c = api.getContact("user1");
    expect(c?.name).toBe("Bob");
    expect(c?.createdAt).toBeDefined();
  });

  it("normalizes userId casing and whitespace for lookup", () => {
    api.setContactName("UserA", "Alice");
    expect(api.getContactName("usera")).toBe("Alice");
    expect(api.getContactName("  UserA  ")).toBe("Alice");
  });

  it("falls back to the normalized userId when the name is empty", () => {
    api.setContactName("user2", "  ");
    expect(api.getContactName("user2")).toBe("user2");
  });

  it("keeps createdAt stable across renames and bumps updatedAt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    api.setContactName("user4", "Dora");
    vi.setSystemTime(2_000_000);
    api.setContactName("user4", "Dory");
    vi.useRealTimers();

    const c = api.getContact("user4");
    expect(c?.name).toBe("Dory");
    expect(c?.createdAt).toBe(1_000_000);
    expect(c?.updatedAt).toBe(2_000_000);
  });

  it("touchUser updates lastSeenAt in memory", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    api.setContactName("user3", "Carol");
    vi.setSystemTime(2_000_000);
    api.touchUser("user3");
    expect(api.getContact("user3")?.lastSeenAt).toBe(2_000_000);
    vi.useRealTimers();
  });

  it("touchUser is a no-op for unknown users", () => {
    expect(() => api.touchUser("ghost")).not.toThrow();
    expect(api.getContact("ghost")).toBeUndefined();
  });

  it("lists contacts sorted by lastSeenAt descending", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    api.setContactName("userA", "Zed");
    api.setContactName("userB", "Ann");
    vi.setSystemTime(2_000_000);
    api.touchUser("userB");
    vi.useRealTimers();

    const list = api.listContacts();
    expect(list.map((c) => c.userId)).toEqual(["userb", "usera"]);
    expect(list[0].name).toBe("Ann");
  });

  it("mergeContactPresets seeds names but does not override existing ones", () => {
    api.setContactName("userC", "Cara");
    api.mergeContactPresets({ userc: "Overridden", userD: "Dave" });
    expect(api.getContactName("userC")).toBe("Cara");
    expect(api.getContactName("userD")).toBe("Dave");
  });

  it("persists contacts to disk so the file survives a reload", () => {
    api.setContactName("userPersist", "Persist");
    const filePath = path.join(tmpDir, "openclaw-weixin", "contacts.json");
    expect(fs.existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      version: number;
      contacts: Record<string, { name: string }>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.contacts.userpersist?.name).toBe("Persist");
  });

  it("tolerates a corrupt contacts file on load", () => {
    fs.mkdirSync(path.join(tmpDir, "openclaw-weixin"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "openclaw-weixin", "contacts.json"), "{ not valid json ");
    expect(api.getContactName("user1")).toBeUndefined();
    expect(api.getContact("user1")).toBeUndefined();
  });

  it("treats a valid file without a contacts field as empty", () => {
    fs.mkdirSync(path.join(tmpDir, "openclaw-weixin"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "openclaw-weixin", "contacts.json"),
      JSON.stringify({ version: 1 }),
    );
    expect(api.listContacts()).toEqual([]);
  });

  it("does not throw when persisting to disk fails", () => {
    const spy = vi
      .spyOn(fs, "writeFileSync")
      .mockImplementation(() => {
        throw new Error("disk full");
      });
    expect(() => api.setContactName("userX", "Xavier")).not.toThrow();
    spy.mockRestore();
  });

  it("persists after the debounce when a user is touched", () => {
    vi.useFakeTimers();
    api.setContactName("userDebounce", "Dan");
    const filePath = path.join(tmpDir, "openclaw-weixin", "contacts.json");
    fs.rmSync(filePath, { force: true });
    api.touchUser("userDebounce");
    vi.advanceTimersByTime(600);
    vi.useRealTimers();
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("reloads existing contacts from disk into a fresh module", async () => {
    api.setContactName("userDisk", "Disk");
    vi.resetModules();
    const fresh = await import("./contacts.js");
    expect(fresh.getContactName("userdisk")).toBe("Disk");
  });

  it("ignores undefined or malformed presets", () => {
    api.mergeContactPresets(undefined);
    api.mergeContactPresets({ "": "x" });
    api.mergeContactPresets({ userE: "  " });
    expect(api.getContactName("userE")).toBeUndefined();
    expect(api.listContacts()).toEqual([]);
  });

  it("ignores empty userIds in setContactName and touchUser", () => {
    expect(() => api.setContactName("", "X")).not.toThrow();
    expect(() => api.setContactName("  ", "Y")).not.toThrow();
    expect(() => api.touchUser("")).not.toThrow();
    expect(api.listContacts()).toEqual([]);
  });
});
