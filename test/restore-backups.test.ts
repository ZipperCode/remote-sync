import { describe, expect, test, vi } from "vitest";

import { listLocalBackupFiles, restoreLocalBackupFile } from "../src/restore-backups";

function createMockApp(files: Array<{ path: string; content?: string; size?: number; mtime?: number }>) {
  const entries = new Map(
    files.map((file) => [
      file.path,
      {
        path: file.path,
        stat: {
          size: file.size ?? file.content?.length ?? 0,
          mtime: file.mtime ?? 1
        },
        content: new TextEncoder().encode(file.content ?? file.path).buffer
      }
    ])
  );
  const folders = new Set<string>();

  return {
    vault: {
      getFiles: vi.fn(() =>
        [...entries.values()].map(({ path, stat }) => ({
          path,
          stat
        }))
      ),
      getFileByPath: vi.fn((path: string) => {
        const entry = entries.get(path);
        return entry ? { path: entry.path, stat: entry.stat } : null;
      }),
      readBinary: vi.fn(async (file: { path: string }) => {
        const entry = entries.get(file.path);
        if (!entry) {
          throw new Error(`Missing file: ${file.path}`);
        }
        return entry.content.slice(0);
      }),
      modifyBinary: vi.fn(async (file: { path: string }, content: ArrayBuffer) => {
        const entry = entries.get(file.path);
        if (!entry) {
          throw new Error(`Missing file: ${file.path}`);
        }
        entry.content = content.slice(0);
      }),
      createBinary: vi.fn(async (path: string, content: ArrayBuffer) => {
        entries.set(path, {
          path,
          stat: { size: content.byteLength, mtime: 1 },
          content: content.slice(0)
        });
        return { path };
      }),
      getFolderByPath: vi.fn((path: string) => (folders.has(path) ? { path } : null)),
      createFolder: vi.fn(async (path: string) => {
        folders.add(path);
      })
    }
  };
}

describe("backup restore helpers", () => {
  test("lists local backup files by batch and original path", () => {
    const app = createMockApp([
      { path: ".remote-sync-trash/20260518-2/B.md", size: 20, mtime: 2 },
      { path: "Notes/current.md", size: 10, mtime: 1 },
      { path: ".remote-sync-trash/20260518-1/A.md", size: 30, mtime: 3 }
    ]);

    expect(listLocalBackupFiles(app as never)).toEqual([
      {
        batch: "20260518-2",
        source: "legacy",
        backupPath: ".remote-sync-trash/20260518-2/B.md",
        originalPath: "B.md",
        size: 20,
        mtime: 2
      },
      {
        batch: "20260518-1",
        source: "legacy",
        backupPath: ".remote-sync-trash/20260518-1/A.md",
        originalPath: "A.md",
        size: 30,
        mtime: 3
      }
    ]);
  });

  test("restores a backup to the original path and creates missing folders", async () => {
    const app = createMockApp([
      { path: ".remote-sync-trash/20260518/remote/Notes/note.md", content: "backup" }
    ]);
    const [backup] = listLocalBackupFiles(app as never);

    await restoreLocalBackupFile(app as never, backup);

    expect(app.vault.createFolder).toHaveBeenCalledWith("Notes");
    expect(app.vault.createBinary).toHaveBeenCalledWith("Notes/note.md", expect.any(ArrayBuffer));
  });

  test("overwrites an existing original path when restoring", async () => {
    const app = createMockApp([
      { path: ".remote-sync-trash/20260518/local/note.md", content: "backup" },
      { path: "note.md", content: "current" }
    ]);
    const [backup] = listLocalBackupFiles(app as never);

    await restoreLocalBackupFile(app as never, backup);

    expect(app.vault.modifyBinary).toHaveBeenCalledWith(
      { path: "note.md", stat: { size: 7, mtime: 1 } },
      expect.any(ArrayBuffer)
    );
    expect(app.vault.createBinary).not.toHaveBeenCalled();
  });
});
