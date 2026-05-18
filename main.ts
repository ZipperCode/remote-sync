import { App, Modal, Notice, Platform, Plugin, Setting, TAbstractFile } from "obsidian";
import {
  DEFAULT_SETTINGS,
  normalizeRemoteSyncSettings,
  RemoteSyncSettingTab,
  RemoteSyncSettings
} from "./settings";
import { AutoSyncController, AutoSyncRunResult } from "./src/auto-sync-controller";
import { parseCustomHeaders } from "./src/custom-headers";
import { ObsidianLocalStore } from "./src/local-store";
import { S3Remote } from "./src/s3-remote";
import { WebDavRemote } from "./src/webdav-remote";
import { SyncEngine, SyncRemoteStore, SyncRunResult } from "./src/sync-engine";
import { SyncStateStore, SyncStateStoreAdapter } from "./src/sync-state-store";
import { shouldIgnorePath } from "./src/path-utils";
import { SyncConfirmation, SyncConfirmationDecision } from "./src/sync-planner";

interface PluginData {
  settings?: Partial<RemoteSyncSettings>;
  syncState?: unknown;
}

class SyncConfirmationModal extends Modal {
  private readonly decisions = new Map<string, SyncConfirmationDecision["action"]>();

  constructor(
    app: App,
    private readonly confirmations: SyncConfirmation[],
    private readonly onSubmit: (decisions: SyncConfirmationDecision[]) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "处理同步确认" });
    contentEl.createEl("p", {
      text: "以下文件存在双方变更或删除冲突。请选择要保留的一侧，未处理的项目会保持待确认。"
    });

    for (const confirmation of this.confirmations) {
      const defaultAction = this.defaultAction(confirmation);
      this.decisions.set(confirmation.path, defaultAction);

      new Setting(contentEl)
        .setName(confirmation.path)
        .setDesc(this.describeConfirmation(confirmation))
        .addDropdown((dropdown) => {
          dropdown.addOption("skip", "跳过");
          if (confirmation.local) {
            dropdown.addOption("use-local", "使用本地版本");
          }
          if (confirmation.remote) {
            dropdown.addOption("use-remote", "使用远端版本");
          }
          if ((confirmation.local && !confirmation.remote) || (confirmation.remote && !confirmation.local)) {
            dropdown.addOption("accept-delete", "接受删除");
          }
          dropdown.setValue(defaultAction).onChange((value) => {
            this.decisions.set(confirmation.path, value as SyncConfirmationDecision["action"]);
          });
        });
    }

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("全部跳过")
          .onClick(() => {
            this.close();
          })
      )
      .addButton((button) =>
        button
          .setButtonText("执行选择")
          .setCta()
          .onClick(() => {
            const decisions = this.confirmations.map((confirmation) => ({
              path: confirmation.path,
              action: this.decisions.get(confirmation.path) ?? "skip"
            }));
            this.close();
            this.onSubmit(decisions);
          })
      );
  }

  private defaultAction(confirmation: SyncConfirmation): SyncConfirmationDecision["action"] {
    if (confirmation.suggestedKind === "upload") {
      return "use-local";
    }
    if (confirmation.suggestedKind === "download") {
      return "use-remote";
    }
    return "skip";
  }

  private describeConfirmation(confirmation: SyncConfirmation): string {
    switch (confirmation.reason) {
      case "both-changed":
        return confirmation.suggestedKind === "upload"
          ? "本地和远端都有变更，默认建议使用更新时间更新的本地版本。"
          : "本地和远端都有变更，默认建议使用更新时间更新的远端版本。";
      case "same-mtime-different-size":
        return "本地和远端修改时间相同但文件大小不同，需要手动选择。";
      case "local-deleted-remote-changed":
        return "本地已删除，但远端在上次同步后发生变更。";
      case "remote-deleted-local-changed":
        return "远端已删除，但本地在上次同步后发生变更。";
    }
  }
}

export default class RemoteSyncPlugin extends Plugin {
  settings: RemoteSyncSettings = { ...DEFAULT_SETTINGS };
  private statusBarItemEl: HTMLElement | null = null;
  private autoSyncController: AutoSyncController | null = null;
  private isSyncing = false;

  async onload(): Promise<void> {
    await this.loadSettings();

    this.addRibbonIcon("refresh-cw", "同步远端仓库", () => {
      void this.syncNow();
    });

    this.addCommand({
      id: "sync-now",
      name: "立即同步",
      callback: () => {
        void this.syncNow();
      }
    });

    this.addCommand({
      id: "resolve-sync-confirmations",
      name: "处理同步确认",
      callback: () => {
        void this.resolveSyncConfirmations();
      }
    });

    if (!Platform.isMobile) {
      this.statusBarItemEl = this.addStatusBarItem();
      this.updateStatus("空闲");
    }

    this.addSettingTab(new RemoteSyncSettingTab(this.app, this));
    this.registerAutoSync();
  }

  async loadSettings(): Promise<void> {
    const data = await this.readPluginData();
    this.settings = normalizeRemoteSyncSettings(data.settings, this.app.vault.getName());
  }

  async saveSettings(): Promise<void> {
    const data = await this.readPluginData();
    await this.saveData({
      ...data,
      settings: this.settings
    });
  }

  async testConnection(): Promise<void> {
    this.assertConfigured();
    await this.createRemote().testConnection();
  }

  async syncNow(): Promise<void> {
    await this.runSync({ showBusyNotice: true, showConfigNotice: true, confirmManually: true });
  }

  async resolveSyncConfirmations(): Promise<void> {
    await this.runSync({ showBusyNotice: true, showConfigNotice: true, confirmManually: true });
  }

  private async syncAutomatically(): Promise<AutoSyncRunResult> {
    if (this.isSyncing) {
      return "busy";
    }

    const didRun = await this.runSync({
      showBusyNotice: false,
      showConfigNotice: false,
      confirmManually: false
    });
    return didRun ? "completed" : "skipped";
  }

  private async runSync(options: {
    showBusyNotice: boolean;
    showConfigNotice: boolean;
    confirmManually: boolean;
    confirmationDecisions?: SyncConfirmationDecision[];
  }): Promise<boolean> {
    if (this.isSyncing) {
      if (options.showBusyNotice) {
        new Notice("同步正在进行中。");
      }
      return false;
    }

    try {
      this.assertConfigured();
    } catch (error) {
      if (options.showConfigNotice) {
        new Notice(formatError(error));
      }
      return false;
    }

    this.isSyncing = true;
    this.updateStatus("同步中...");

    try {
      const result = await this.createEngine().syncOnce(options.confirmationDecisions);
      this.handleSyncResult(result);
      if (options.confirmManually && result.plan.confirmations.length > 0) {
        this.openConfirmationModal(result.plan.confirmations);
      }
    } catch (error) {
      this.updateStatus("同步失败");
      new Notice(`同步失败：${formatError(error)}`);
    } finally {
      this.isSyncing = false;
    }

    return true;
  }

  private openConfirmationModal(confirmations: SyncConfirmation[]): void {
    new SyncConfirmationModal(this.app, confirmations, (confirmationDecisions) => {
      void this.runSync({
        showBusyNotice: true,
        showConfigNotice: true,
        confirmManually: false,
        confirmationDecisions
      });
    }).open();
  }

  private registerAutoSync(): void {
    this.autoSyncController = new AutoSyncController({
      sync: () => this.syncAutomatically(),
      shouldIgnorePath: (path) =>
        shouldIgnorePath(path, this.settings.ignorePatterns, this.manifest.id)
    });
    this.register(() => this.autoSyncController?.dispose());

    this.app.workspace.onLayoutReady(() => {
      const controller = this.autoSyncController;
      if (!controller) {
        return;
      }

      this.registerEvent(
        this.app.vault.on("create", (file: TAbstractFile) => {
          controller.handleVaultChange(file.path);
        })
      );
      this.registerEvent(
        this.app.vault.on("modify", (file: TAbstractFile) => {
          controller.handleVaultChange(file.path);
        })
      );
      this.registerEvent(
        this.app.vault.on("delete", (file: TAbstractFile) => {
          controller.handleVaultChange(file.path);
        })
      );
      this.registerEvent(
        this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
          controller.handleVaultRename(file.path, oldPath);
        })
      );
    });
  }

  private createEngine(): SyncEngine {
    return new SyncEngine(
      new ObsidianLocalStore(this.app, this.settings.ignorePatterns, this.manifest.id),
      this.createRemote(),
      new SyncStateStore(new PluginSyncStateAdapter(this)),
      {
        ignorePatterns: this.settings.ignorePatterns,
        pluginId: this.manifest.id
      }
    );
  }

  private createRemote(): SyncRemoteStore & { testConnection(): Promise<void> } {
    const customHeaders = parseCustomHeaders(this.settings.customHeaders);

    if (this.settings.provider === "s3") {
      return new S3Remote({
        preset: this.settings.s3Preset,
        endpoint: this.settings.s3Endpoint,
        region: this.settings.s3Region,
        bucket: this.settings.s3Bucket,
        prefix: this.settings.s3Prefix,
        accessKeyId: this.settings.s3AccessKeyId,
        secretAccessKey: this.settings.s3SecretAccessKey,
        sessionToken: this.settings.s3SessionToken,
        addressingStyle: this.settings.s3AddressingStyle,
        customHeaders
      });
    }

    return new WebDavRemote({
      baseUrl: this.settings.baseUrl,
      username: this.settings.username,
      password: this.settings.password,
      remoteRoot: this.settings.remoteRoot || this.app.vault.getName(),
      customHeaders
    });
  }

  private handleSyncResult(result: SyncRunResult): void {
    const { summary } = result;
    const status =
      summary.failures > 0 ? "失败" : summary.pendingConfirmations > 0 ? "待确认" : "成功";
    this.updateStatus(`${status} ${new Date().toLocaleTimeString()}`);

    new Notice(
      [
        `同步${status}。`,
        `上传：${summary.uploaded}`,
        `下载：${summary.downloaded}`,
        `本地删除：${summary.deletedLocal}`,
        `远程删除：${summary.deletedRemote}`,
        `已备份：${summary.backedUp}`,
        `已跳过：${summary.skipped}`,
        `待确认：${summary.pendingConfirmations}`,
        `失败：${summary.failures}`
      ].join("\n")
    );
  }

  private updateStatus(value: string): void {
    this.statusBarItemEl?.setText(`远端同步：${value}`);
  }

  private assertConfigured(): void {
    parseCustomHeaders(this.settings.customHeaders);

    if (this.settings.provider === "s3") {
      if (!this.settings.s3Endpoint) {
        throw new Error("请先填写 S3 Endpoint。");
      }
      if (!this.settings.s3Bucket) {
        throw new Error("请先填写 S3 Bucket。");
      }
      if (!this.settings.s3Region) {
        throw new Error("请先填写 S3 Region。");
      }
      if (!this.settings.s3AccessKeyId || !this.settings.s3SecretAccessKey) {
        throw new Error("请先填写 S3 访问密钥。");
      }
      return;
    }

    if (!this.settings.baseUrl) {
      throw new Error("请先填写 WebDAV 地址。");
    }
  }

  private async readPluginData(): Promise<PluginData> {
    return ((await this.loadData()) as PluginData | null) ?? {};
  }
}

class PluginSyncStateAdapter implements SyncStateStoreAdapter {
  constructor(private readonly plugin: RemoteSyncPlugin) {}

  async read(): Promise<string | null> {
    const data = await this.readPluginData();
    return data.syncState ? JSON.stringify(data.syncState) : null;
  }

  async write(value: string): Promise<void> {
    const data = await this.readPluginData();
    await this.plugin.saveData({
      ...data,
      syncState: JSON.parse(value) as unknown
    });
  }

  private async readPluginData(): Promise<PluginData> {
    return ((await this.plugin.loadData()) as PluginData | null) ?? {};
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
