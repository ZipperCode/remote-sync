import { describe, expect, test } from "vitest";
import { buildConflictCopyPath, sanitizeDeviceId } from "../src/device-id";

describe("buildConflictCopyPath", () => {
  test("inserts conflict marker before the extension in the same directory", () => {
    const result = buildConflictCopyPath("notes/todo.md", "laptop", 1717000000000);
    expect(result).toBe("notes/todo.conflict-laptop-1717000000000.md");
  });

  test("handles files at vault root", () => {
    const result = buildConflictCopyPath("todo.md", "phone", 1717000000000);
    expect(result).toBe("todo.conflict-phone-1717000000000.md");
  });

  test("handles files without extension", () => {
    const result = buildConflictCopyPath("notes/draft", "laptop", 1717000000000);
    expect(result).toBe("notes/draft.conflict-laptop-1717000000000");
  });

  test("handles dotfiles by appending the marker", () => {
    const result = buildConflictCopyPath("notes/.keep", "laptop", 1717000000000);
    expect(result).toBe("notes/.keep.conflict-laptop-1717000000000");
  });

  test("sanitizes unsafe characters in deviceId", () => {
    const result = buildConflictCopyPath("a.md", "my/device name", 1717000000000);
    expect(result).toBe("a.conflict-my-device-name-1717000000000.md");
  });
});

describe("sanitizeDeviceId", () => {
  test("returns a clean slug for normal names", () => {
    expect(sanitizeDeviceId("My Laptop")).toBe("My-Laptop");
  });

  test("falls back to 'device' when nothing remains", () => {
    expect(sanitizeDeviceId("!!!")).toBe("device");
    expect(sanitizeDeviceId("   ")).toBe("device");
  });

  test("trims surrounding dashes after collapsing illegal chars", () => {
    expect(sanitizeDeviceId("--name--")).toBe("name");
  });

  test("does not leave a trailing dash after truncation", () => {
    // 31 个 a + 非法字符（变成 -）+ 更多字符；截断到 32 后末尾不应是 -
    const input = "a".repeat(31) + "!!b";
    const result = sanitizeDeviceId(input);
    expect(result.endsWith("-")).toBe(false);
    expect(result).toBe("a".repeat(31));
  });
});

describe("buildConflictCopyPath multi-extension", () => {
  test("preserves only the last extension by design", () => {
    // archive.tar.gz → 仅最后一个扩展名 .gz 被保留（设计如此）
    const result = buildConflictCopyPath("archive.tar.gz", "pc", 1000);
    expect(result).toBe("archive.tar.conflict-pc-1000.gz");
  });
});
