import { describe, expect, test, vi } from "vitest";

import { ObsidianLocalStore } from "../src/local-store";

describe("ObsidianLocalStore", () => {
  test("continues when Obsidian reports an existing parent folder during write", async () => {
    const createFolder = vi.fn(async (path: string) => {
      if (path === ".remote-sync-trash") {
        throw new Error("Folder already exists.");
      }
    });
    const createBinary = vi.fn();
    const app = {
      vault: {
        getFiles: vi.fn(() => []),
        getFolderByPath: vi.fn(() => null),
        createFolder,
        getFileByPath: vi.fn(() => null),
        createBinary,
        modifyBinary: vi.fn()
      }
    };
    const store = new ObsidianLocalStore(app as never, [], "obsidian-webdav-sync");
    const content = new TextEncoder().encode("backup").buffer;

    await store.writeFile(".remote-sync-trash/20260519/local/welcome.md", content);

    expect(createFolder).toHaveBeenCalledWith(".remote-sync-trash");
    expect(createFolder).toHaveBeenCalledWith(".remote-sync-trash/20260519");
    expect(createFolder).toHaveBeenCalledWith(".remote-sync-trash/20260519/local");
    expect(createBinary).toHaveBeenCalledWith(
      ".remote-sync-trash/20260519/local/welcome.md",
      content,
      undefined
    );
  });
});
