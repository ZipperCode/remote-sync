import { beforeEach, describe, expect, test, vi } from "vitest";
import { Notice } from "obsidian";

import { hasClipboardFiles, importClipboardFiles } from "../src/clipboard-files";

function createMockApp() {
  return {
    fileManager: {
      getAvailablePathForAttachment: vi.fn(async (filename: string) => `attachments/${filename}`),
      generateMarkdownLink: vi.fn((file: { path: string }) => `![[${file.path}]]`)
    },
    vault: {
      createBinary: vi.fn(async (path: string) => ({ path }))
    }
  };
}

function createClipboardEvent(files?: readonly File[]): ClipboardEvent {
  return {
    clipboardData: files
      ? {
          files: files as unknown as FileList
        }
      : null
  } as ClipboardEvent;
}

describe("clipboard file imports", () => {
  beforeEach(() => {
    vi.mocked(Notice).mockClear();
  });

  test("detects only clipboard events with files", () => {
    expect(hasClipboardFiles(createClipboardEvent([new File(["content"], "doc.pdf")]))).toBe(true);
    expect(hasClipboardFiles(createClipboardEvent([]))).toBe(false);
    expect(hasClipboardFiles(createClipboardEvent())).toBe(false);
  });

  test("imports one clipboard file through Obsidian attachment APIs", async () => {
    const app = createMockApp();
    const file = new File(["hello"], "doc.pdf");

    const links = await importClipboardFiles(app as never, [file], "notes/source.md");

    expect(app.fileManager.getAvailablePathForAttachment).toHaveBeenCalledWith("doc.pdf", "notes/source.md");
    expect(app.vault.createBinary).toHaveBeenCalledWith("attachments/doc.pdf", expect.any(ArrayBuffer));
    expect(Buffer.from(new Uint8Array(app.vault.createBinary.mock.calls[0][1])).toString()).toBe("hello");
    expect(app.fileManager.generateMarkdownLink).toHaveBeenCalledWith(
      { path: "attachments/doc.pdf" },
      "notes/source.md"
    );
    expect(links).toEqual(["![[attachments/doc.pdf]]"]);
  });

  test("imports multiple clipboard files in clipboard order", async () => {
    const app = createMockApp();
    const files = [new File(["a"], "a.txt"), new File(["b"], "b.txt")];

    const links = await importClipboardFiles(app as never, files, "notes/source.md");

    expect(app.vault.createBinary.mock.calls.map(([path]) => path)).toEqual([
      "attachments/a.txt",
      "attachments/b.txt"
    ]);
    expect(links.join("\n")).toBe("![[attachments/a.txt]]\n![[attachments/b.txt]]");
  });

  test("does not write or notify for an empty file list", async () => {
    const app = createMockApp();

    const links = await importClipboardFiles(app as never, [], "notes/source.md");

    expect(links).toEqual([]);
    expect(app.vault.createBinary).not.toHaveBeenCalled();
    expect(Notice).not.toHaveBeenCalled();
  });

  test("keeps successful imports and reports failed files", async () => {
    const app = createMockApp();
    app.vault.createBinary.mockRejectedValueOnce(new Error("cannot read"));
    app.vault.createBinary.mockResolvedValueOnce({ path: "attachments/ok.txt" });

    const links = await importClipboardFiles(
      app as never,
      [new File(["bad"], "bad.txt"), new File(["ok"], "ok.txt")],
      "notes/source.md"
    );

    expect(links).toEqual(["![[attachments/ok.txt]]"]);
    expect(Notice).toHaveBeenCalledWith("剪贴板文件导入失败：bad.txt: cannot read");
  });
});
