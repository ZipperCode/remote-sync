import { describe, expect, test } from "vitest";
import { buildConflictCopyPath } from "../src/device-id";

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
