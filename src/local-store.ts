import { App, TFile } from "obsidian";
import { parentPath, shouldIgnorePath, splitPath, normalizeVaultPath } from "./path-utils";
import { SyncLocalStore } from "./sync-engine";
import { FileEntry } from "./sync-planner";

export class ObsidianLocalStore implements SyncLocalStore {
  constructor(
    private readonly app: App,
    private readonly ignorePatterns: string[],
    private readonly pluginId: string
  ) {}

  async snapshot(): Promise<FileEntry[]> {
    return this.app.vault
      .getFiles()
      .map((file) => this.toEntry(file))
      .filter((entry) => !shouldIgnorePath(entry.path, this.ignorePatterns, this.pluginId));
  }

  async readFile(path: string): Promise<ArrayBuffer> {
    const file = this.getFile(path);
    if (!file) {
      throw new Error(`找不到本地文件：${path}`);
    }

    return this.app.vault.readBinary(file);
  }

  async writeFile(path: string, content: ArrayBuffer, source?: FileEntry): Promise<void> {
    const normalized = normalizeVaultPath(path);
    await this.ensureParentFolder(normalized);

    const options = source ? { mtime: source.mtime } : undefined;
    const existing = this.app.vault.getFileByPath(normalized);
    if (existing) {
      await this.app.vault.modifyBinary(existing, content, options);
      return;
    }

    await this.app.vault.createBinary(normalized, content, options);
  }

  async deleteFile(path: string): Promise<void> {
    const file = this.app.vault.getFileByPath(normalizeVaultPath(path));
    if (!file) {
      return;
    }

    await this.app.vault.trash(file, false);
  }

  private toEntry(file: TFile): FileEntry {
    return {
      path: normalizeVaultPath(file.path),
      type: "file",
      size: file.stat.size,
      mtime: file.stat.mtime
    };
  }

  private getFile(path: string): TFile | null {
    return this.app.vault.getFileByPath(normalizeVaultPath(path));
  }

  private async ensureParentFolder(path: string): Promise<void> {
    const parent = parentPath(path);
    if (!parent) {
      return;
    }

    let current = "";
    for (const segment of splitPath(parent)) {
      current = current ? `${current}/${segment}` : segment;
      if (!this.app.vault.getFolderByPath(current)) {
        await this.app.vault.createFolder(current);
      }
    }
  }
}
