import type { App, TFile } from "obsidian";
import { normalizeVaultPath, parentPath, REMOTE_SYNC_TRASH_DIR, splitPath } from "./path-utils";

export interface BackupFileEntry {
  batch: string;
  source: "local" | "remote" | "legacy";
  backupPath: string;
  originalPath: string;
  size: number;
  mtime: number;
}

export function listLocalBackupFiles(app: App): BackupFileEntry[] {
  return app.vault
    .getFiles()
    .map((file) => toBackupFileEntry(file))
    .filter((entry): entry is BackupFileEntry => entry !== null)
    .sort((left, right) => {
      if (left.batch !== right.batch) {
        return right.batch.localeCompare(left.batch);
      }
      return left.originalPath.localeCompare(right.originalPath);
    });
}

export async function restoreLocalBackupFile(app: App, backup: BackupFileEntry): Promise<void> {
  const source = app.vault.getFileByPath(backup.backupPath);
  if (!source) {
    throw new Error(`找不到备份文件：${backup.backupPath}`);
  }

  const content = await app.vault.readBinary(source);
  const targetPath = normalizeVaultPath(backup.originalPath);
  await ensureParentFolder(app, targetPath);

  const existing = app.vault.getFileByPath(targetPath);
  if (existing) {
    await app.vault.modifyBinary(existing, content);
    return;
  }

  await app.vault.createBinary(targetPath, content);
}

function toBackupFileEntry(file: TFile): BackupFileEntry | null {
  const path = normalizeVaultPath(file.path);
  const prefix = `${REMOTE_SYNC_TRASH_DIR}/`;
  if (!path.startsWith(prefix)) {
    return null;
  }

  const rest = path.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash === -1) {
    return null;
  }

  const batch = rest.slice(0, slash);
  const rawOriginalPath = normalizeVaultPath(rest.slice(slash + 1));
  const parts = splitPath(rawOriginalPath);
  const firstPart = parts[0];
  const hasSourcePrefix = firstPart === "local" || firstPart === "remote";
  const source = hasSourcePrefix ? firstPart : "legacy";
  const originalPath = hasSourcePrefix ? parts.slice(1).join("/") : rawOriginalPath;
  if (!batch || !originalPath) {
    return null;
  }

  return {
    batch,
    source,
    backupPath: path,
    originalPath,
    size: file.stat.size,
    mtime: file.stat.mtime
  };
}

async function ensureParentFolder(app: App, path: string): Promise<void> {
  const parent = parentPath(path);
  if (!parent) {
    return;
  }

  let current = "";
  for (const segment of splitPath(parent)) {
    current = current ? `${current}/${segment}` : segment;
    if (!app.vault.getFolderByPath(current)) {
      await app.vault.createFolder(current);
    }
  }
}
