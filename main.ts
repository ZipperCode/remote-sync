import { App, Modal, Notice, Platform, Plugin, Setting, TAbstractFile, requestUrl } from "obsidian";
import {
  DEFAULT_SETTINGS,
  normalizeRemoteSyncSettings,
  RemoteSyncSettingTab,
  RemoteSyncSettings
} from "./settings";
import {
  CODE_VIEW_TYPE,
  RemoteSyncCodeView,
  SUPPORTED_CODE_EXTENSIONS
} from "./src/code-file-view";
import { AutoSyncController, AutoSyncRunResult } from "./src/auto-sync-controller";
import { parseCustomHeaders } from "./src/custom-headers";
import { ObsidianLocalStore } from "./src/local-store";
import { S3Remote } from "./src/s3-remote";
import { WebDavRemote } from "./src/webdav-remote";
import { InitialSyncMode, SyncEngine, SyncRemoteStore, SyncRunResult } from "./src/sync-engine";
import { SyncStateStore, SyncStateStoreAdapter } from "./src/sync-state-store";
import { shouldIgnorePath } from "./src/path-utils";
import { SyncConfirmation, SyncConfirmationDecision } from "./src/sync-planner";
import { hasClipboardFiles, importClipboardFiles } from "./src/clipboard-files";
import { BackupFileEntry, listLocalBackupFiles, restoreLocalBackupFile } from "./src/restore-backups";
import { applyPluginUpdate, checkForPluginUpdate, type PluginFileAdapter } from "./src/plugin-updater";
import type { Editor, MarkdownView } from "obsidian";

const STALE_SYNC_THRESHOLD_MS = 2 * 60 * 1000;
// 轮询周期略大于 stale 阈值：让"判定僵死"先于"下一轮轮询触发"，避免一次接近
// 2 分钟的慢同步在自然完成的同一时刻被下一轮误判为僵死而接管，语义更清晰。
const AUTO_SYNC_POLL_INTERVAL_MS = 150 * 1000;

interface PluginData {
  settings?: Partial<RemoteSyncSettings>;
  syncState?: unknown;
  deviceId?: string;
}

class SyncConfirmationModal extends Modal {
  private readonly decisions = new Map<string, SyncConfirmationDecision["action"]>();
  private submitted = false;
  // Per-path dropdown components so bulk buttons can refresh the visible value
  // after programmatically changing a decision.
  private readonly dropdowns = new Map<string, { setValue: (v: string) => unknown }>();

  constructor(
    app: App,
    private readonly confirmations: SyncConfirmation[],
    private readonly onSubmit: (decisions: SyncConfirmationDecision[]) => void,
    // Fired only when the user closed the modal without making any decision
    // (X / Esc / "全部跳过"); used to degrade automatic confirmation prompts.
    private readonly onDismissWithoutSubmit?: () => void,
    // Fired on EVERY close path (submit / skip / passive dismiss / Esc),
    // independent of `submitted`; used to release the open guard so the modal
    // can be reopened later. Decoupling guard release from `submitted` prevents
    // the guard from getting stuck on (and blocking all future modals).
    private readonly onClosed?: () => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "处理同步确认" });
    contentEl.createEl("p", {
      text: "以下文件存在需要人工介入的冲突。可自动合并的文本文件会优先尝试自动合并。"
    });

    // Group confirmations by coarse conflict category so users can resolve a
    // whole category (e.g. dozens of deletions) with one click.
    const groups: Array<{ key: "delete" | "text" | "binary"; title: string; items: SyncConfirmation[] }> = [
      { key: "delete", title: "删除类冲突", items: [] },
      { key: "text", title: "文本类冲突", items: [] },
      { key: "binary", title: "二进制/其它冲突", items: [] }
    ];
    for (const confirmation of this.confirmations) {
      const group = groups.find((g) => g.key === this.groupOf(confirmation));
      group?.items.push(confirmation);
    }

    for (const group of groups) {
      if (group.items.length === 0) {
        continue;
      }
      contentEl.createEl("h3", { text: `${group.title}（${group.items.length}）` });

      // Bulk-action row for this group.
      const bulkRow = new Setting(contentEl).setName("批量处理本组");
      if (group.key === "delete") {
        bulkRow
          .addButton((b) => b.setButtonText("全部接受删除").onClick(() =>
            this.submitWith(group.items, () => "accept-delete")))
          .addButton((b) => b.setButtonText("全部保留").onClick(() =>
            this.submitWith(group.items, (c) => (c.local ? "use-local" : "use-remote"))))
          .addButton((b) => b.setButtonText("全组跳过").onClick(() =>
            this.submitWith(group.items, () => "skip")));
      } else if (group.key === "text") {
        bulkRow
          .addButton((b) => b.setButtonText("全部自动合并").onClick(() =>
            this.submitWith(group.items, (c) => (c.suggestedKind === "merge" ? "auto-merge" : this.decisions.get(c.path) ?? "skip"))))
          .addButton((b) => b.setButtonText("全部用本地").onClick(() =>
            this.submitWith(group.items, () => "use-local")))
          .addButton((b) => b.setButtonText("全部用远端").onClick(() =>
            this.submitWith(group.items, () => "use-remote")))
          .addButton((b) => b.setButtonText("全组跳过").onClick(() =>
            this.submitWith(group.items, () => "skip")));
      } else {
        bulkRow
          .addButton((b) => b.setButtonText("全部用本地").onClick(() =>
            this.submitWith(group.items, () => "use-local")))
          .addButton((b) => b.setButtonText("全部用远端").onClick(() =>
            this.submitWith(group.items, () => "use-remote")))
          .addButton((b) => b.setButtonText("全组跳过").onClick(() =>
            this.submitWith(group.items, () => "skip")));
      }

      // Per-item dropdowns (unchanged behaviour, finer control).
      for (const confirmation of group.items) {
        const defaultAction = this.defaultAction(confirmation);
        this.decisions.set(confirmation.path, defaultAction);

        new Setting(contentEl)
          .setName(confirmation.path)
          .setDesc(this.describeConfirmation(confirmation))
          .addDropdown((dropdown) => {
            dropdown.addOption("skip", "跳过");
            if (confirmation.suggestedKind === "merge") {
              dropdown.addOption("auto-merge", "自动合并");
            }
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
            this.dropdowns.set(confirmation.path, dropdown);
          });
      }
    }

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("接受所有删除")
          .onClick(() => {
            // 接受任一方向的单边删除（本地删→删远端、远端删→删本地）。
            // accept-delete 在引擎里按 local/remote 哪边存在自动决定删哪边，
            // 故对所有单边删除冲突通用；非删除冲突保持其原决策不变。
            const decisions = this.confirmations.map((confirmation) => ({
              path: confirmation.path,
              action: this.isDeleteConfirmation(confirmation)
                ? "accept-delete"
                : this.decisions.get(confirmation.path) ?? "skip"
            }));
            this.submitted = true;
            this.close();
            this.onSubmit(decisions);
          })
      )
      .addButton((button) =>
        button
          .setButtonText("全部跳过")
          .onClick(() => {
            // "全部跳过" = skip this round AND quiet down: degrade automatic
            // prompts to a status-bar hint instead of re-popping every poll.
            // Deliberately leave `submitted` false so onClose runs the dismiss
            // path (sets autoConfirmationDismissed=true). The always-on onClosed
            // callback still releases the open guard, so this active click does
            // NOT lock out future modals.
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
            this.submitted = true;
            this.close();
            this.onSubmit(decisions);
          })
      );
  }

  onClose(): void {
    if (!this.submitted) {
      this.onDismissWithoutSubmit?.();
    }
    // Always release the guard, regardless of why the modal closed.
    this.onClosed?.();
    this.contentEl.empty();
  }

  private groupOf(confirmation: SyncConfirmation): "delete" | "text" | "binary" {
    if (confirmation.conflictType === "delete-vs-modify") {
      return "delete";
    }
    if (confirmation.conflictType === "binary") {
      return "binary";
    }
    return "text";
  }

  // Apply a bulk decision to a group, refresh the visible dropdowns, then submit
  // immediately (the user explicitly chose a one-click bulk action). Decisions
  // for paths outside the group keep whatever the per-item dropdowns hold.
  private submitWith(
    items: SyncConfirmation[],
    pick: (confirmation: SyncConfirmation) => SyncConfirmationDecision["action"]
  ): void {
    for (const confirmation of items) {
      const action = pick(confirmation);
      this.decisions.set(confirmation.path, action);
      this.dropdowns.get(confirmation.path)?.setValue(action);
    }
    const decisions = this.confirmations.map((confirmation) => ({
      path: confirmation.path,
      action: this.decisions.get(confirmation.path) ?? "skip"
    }));
    this.submitted = true;
    this.close();
    this.onSubmit(decisions);
  }

  private defaultAction(confirmation: SyncConfirmation): SyncConfirmationDecision["action"] {
    if (confirmation.suggestedKind === "merge") {
      return "auto-merge";
    }
    if (confirmation.suggestedKind === "upload") {
      return "use-local";
    }
    if (confirmation.suggestedKind === "download") {
      return "use-remote";
    }
    return "skip";
  }

  private isDeleteConfirmation(confirmation: SyncConfirmation): boolean {
    // 单边删除冲突：一端已删、另一端还在（local XOR remote），两个方向都算。
    // 这类冲突可用 accept-delete 统一接受（引擎按存在的一侧反推删哪边）。
    return (
      confirmation.conflictType === "delete-vs-modify" &&
      Boolean(confirmation.local) !== Boolean(confirmation.remote)
    );
  }

  private describeConfirmation(confirmation: SyncConfirmation): string {
    switch (confirmation.conflictType) {
      case "text-auto-merge":
        return "文本文件有可用基线，已优先尝试自动三方合并。";
      case "text-overlap":
        return "本地和远端修改了相同内容区块，自动合并失败。";
      case "text-no-base":
        return confirmation.reason === "same-mtime-different-size"
          ? "文本文件修改时间相同但大小不同，且没有可用基线，无法自动合并。"
          : "文本文件没有可用基线，无法进行自动三方合并。";
      case "text-too-large":
        return confirmation.reason === "same-mtime-different-size"
          ? "文本文件修改时间相同但大小不同，且文件过大，已降级为手动处理。"
          : "文本文件过大，已降级为手动处理。";
      case "binary":
        return confirmation.reason === "same-mtime-different-size"
          ? "非文本文件修改时间相同但大小不同，需要手动选择。"
          : "非文本或不可安全合并的文件，需要手动选择。";
      case "delete-vs-modify":
        if (confirmation.reason === "local-deleted") {
          return "本地删除了该文件。为避免误删远端文件，需要确认后才会同步删除。";
        }
        if (confirmation.reason === "remote-deleted") {
          return "远端删除了该文件。为避免误删本地文件，需要确认后才会同步删除。";
        }
        return confirmation.reason === "local-deleted-remote-changed"
          ? "本地已删除，但远端在上次同步后发生变更。"
          : "远端已删除，但本地在上次同步后发生变更。";
    }
  }
}

class FirstSyncModal extends Modal {
  constructor(
    app: App,
    private readonly onSelect: (mode: Exclude<InitialSyncMode, "ask">) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "首次同步确认" });
    contentEl.createEl("p", {
      text: "当前库还没有成功同步基线。请选择首次同步策略，插件不会在未确认前写入或删除文件。"
    });

    new Setting(contentEl)
      .setName("双向合并")
      .setDesc("本地独有文件上传，远端独有文件下载；同路径差异文件进入确认。")
      .addButton((button) =>
        button
          .setButtonText("双向合并")
          .setCta()
          .onClick(() => this.submit("merge"))
      );

    new Setting(contentEl)
      .setName("以本地为准")
      .setDesc("远端会被调整为当前本地库内容；远端独有文件会先备份再删除。")
      .addButton((button) =>
        button
          .setButtonText("使用本地")
          .onClick(() => this.submit("use-local"))
      );

    new Setting(contentEl)
      .setName("以远端为准")
      .setDesc("本地会被调整为当前远端内容；本地独有文件会先备份再删除。")
      .addButton((button) =>
        button
          .setButtonText("使用远端")
          .onClick(() => this.submit("use-remote"))
      );
  }

  private submit(mode: Exclude<InitialSyncMode, "ask">): void {
    this.close();
    this.onSelect(mode);
  }
}

class RestoreBackupModal extends Modal {
  constructor(
    app: App,
    private readonly backups: BackupFileEntry[],
    private readonly onRestore: (backup: BackupFileEntry) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "恢复同步备份" });

    if (this.backups.length === 0) {
      contentEl.createEl("p", { text: "当前库没有可恢复的同步备份。" });
      return;
    }

    contentEl.createEl("p", {
      text: "选择一个备份恢复到原路径。若原路径已有文件，会被该备份覆盖。"
    });

    for (const backup of this.backups.slice(0, 100)) {
      new Setting(contentEl)
        .setName(backup.originalPath)
        .setDesc(`批次：${backup.batch}；来源：${this.describeSource(backup)}；大小：${backup.size} bytes`)
        .addButton((button) =>
          button
            .setButtonText("恢复")
            .onClick(() => {
              this.close();
              this.onRestore(backup);
            })
        );
    }
  }

  private describeSource(backup: BackupFileEntry): string {
    switch (backup.source) {
      case "local":
        return "本地";
      case "remote":
        return "远端";
      case "legacy":
        return "旧版";
    }
  }
}

export default class RemoteSyncPlugin extends Plugin {
  settings: RemoteSyncSettings = { ...DEFAULT_SETTINGS };
  private statusBarItemEl: HTMLElement | null = null;
  private deviceId = "";
  private autoSyncController: AutoSyncController | null = null;
  private syncStartedAt: number | null = null;
  private isUpdatingPlugin = false;
  private lastSyncLabel = "空闲";
  private confirmationModalOpen = false;
  private autoConfirmationDismissed = false;

  async onload(): Promise<void> {
    await this.loadSettings();
    await this.ensureDeviceId();

    this.registerView(CODE_VIEW_TYPE, (leaf) => new RemoteSyncCodeView(leaf));
    this.registerExtensions(SUPPORTED_CODE_EXTENSIONS, CODE_VIEW_TYPE);
    this.registerEvent(
      this.app.workspace.on(
        "editor-paste",
        (event: ClipboardEvent, editor: Editor, markdownView: MarkdownView) => {
          const files = event.clipboardData?.files;
          if (!files || !hasClipboardFiles(event)) {
            return;
          }

          event.preventDefault();
          void this.importPastedFiles(files, markdownView.file?.path ?? "", (links) => {
            editor.replaceSelection(links.join("\n"));
          });
        }
      )
    );

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

    this.addCommand({
      id: "restore-sync-backup",
      name: "恢复同步备份",
      callback: () => {
        this.openRestoreBackupModal();
      }
    });

    this.addCommand({
      id: "check-plugin-update",
      name: "检查插件更新",
      callback: () => {
        void this.checkPluginUpdates();
      }
    });

    this.addCommand({
      id: "reset-sync-state",
      name: "重置同步状态",
      callback: () => {
        this.resetSyncState();
      }
    });

    if (!Platform.isMobile) {
      this.statusBarItemEl = this.addStatusBarItem();
      this.updateStatus("空闲");
    }

    this.addSettingTab(new RemoteSyncSettingTab(this.app, this));
    this.registerAutoSync();
  }

  private async importPastedFiles(
    files: FileList,
    sourcePath: string,
    insertLinks: (links: string[]) => void
  ): Promise<void> {
    const links = await importClipboardFiles(this.app, files, sourcePath);
    if (links.length === 0) {
      return;
    }

    insertLinks(links);
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(CODE_VIEW_TYPE);
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

  async checkPluginUpdates(): Promise<void> {
    if (this.isUpdatingPlugin) {
      new Notice("插件更新正在进行中。");
      return;
    }

    this.isUpdatingPlugin = true;
    try {
      const result = await checkForPluginUpdate({
        currentVersion: this.manifest.version,
        pluginId: this.manifest.id,
        request: requestUrl
      });
      if (result.status === "up-to-date") {
        new Notice("当前已是最新版本。");
        return;
      }

      const pluginDir = `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
      await applyPluginUpdate({
        pluginDir,
        release: result.release,
        adapter: this.app.vault.adapter as PluginFileAdapter
      });
      new Notice(`插件已更新到 ${result.release.version}，请重启 Obsidian 或手动重载插件。`);
    } catch (error) {
      console.error("[Remote Sync] Plugin update check failed.", {
        error
      });
      new Notice(`检查插件更新失败：${formatError(error)}`);
    } finally {
      this.isUpdatingPlugin = false;
    }
  }

  isPluginUpdateInProgress(): boolean {
    return this.isUpdatingPlugin;
  }

  async syncNow(): Promise<void> {
    await this.runSync({ showBusyNotice: true, showConfigNotice: true, confirmManually: true });
  }

  async resolveSyncConfirmations(): Promise<void> {
    await this.runSync({ showBusyNotice: true, showConfigNotice: true, confirmManually: true });
  }

  resetSyncState(): void {
    // Force-release a stuck sync lock so a hung request (that never timed out)
    // can no longer block manual syncs, then immediately retry.
    this.syncStartedAt = null;
    new Notice("已重置同步状态，正在重新同步…");
    void this.syncNow();
  }

  private async syncAutomatically(): Promise<AutoSyncRunResult> {
    if (this.syncStartedAt !== null && Date.now() - this.syncStartedAt < STALE_SYNC_THRESHOLD_MS) {
      return "busy";
    }

    const didRun = await this.runSync({
      showBusyNotice: false,
      showConfigNotice: false,
      confirmManually: true,
      autoConfirm: true
    });
    return didRun ? "completed" : "skipped";
  }

  private async runSync(options: {
    showBusyNotice: boolean;
    showConfigNotice: boolean;
    confirmManually: boolean;
    autoConfirm?: boolean;
    confirmationDecisions?: SyncConfirmationDecision[];
    initialSyncMode?: InitialSyncMode;
  }): Promise<boolean> {
    if (this.syncStartedAt !== null) {
      const elapsed = Date.now() - this.syncStartedAt;
      if (elapsed < STALE_SYNC_THRESHOLD_MS) {
        if (options.showBusyNotice) {
          new Notice("同步正在进行中。");
        }
        return false;
      }
      console.warn("[Remote Sync] Detected a stale sync, forcing reset.", {
        elapsedMs: elapsed,
        threshold: STALE_SYNC_THRESHOLD_MS
      });
      this.syncStartedAt = null;
    }

    try {
      this.assertConfigured();
    } catch (error) {
      console.warn("[Remote Sync] Sync skipped because configuration is invalid.", {
        provider: this.settings.provider,
        syncStartedAt: this.syncStartedAt,
        error
      });
      if (options.showConfigNotice) {
        new Notice(formatError(error));
      }
      return false;
    }

    const syncToken = Date.now();
    this.syncStartedAt = syncToken;
    this.updateStatus("同步中...");

    try {
      // 取出本批待处理的重命名映射（取出即清空），透传给引擎在远端执行搬迁，
      // 避免重命名被拆成「删旧+增新」而误判为删除冲突。手动与自动同步都经此处。
      const renames = this.autoSyncController?.takePendingRenames() ?? [];
      const result = await this.createEngine().syncOnce(options.confirmationDecisions, {
        initialSyncMode: options.initialSyncMode ?? "ask",
        renames
      });
      this.handleSyncResult(result);
      if (result.plan.initialSyncRequired) {
        if (options.confirmManually) {
          this.openFirstSyncModal();
        }
        return true;
      }
      if (options.confirmManually && result.plan.confirmations.length > 0) {
        if (options.autoConfirm) {
          // Automatic sync: if the user already dismissed a confirmation modal
          // without acting on it, stop re-opening it on every poll and degrade
          // to a status-bar hint instead so they can dismiss it for good.
          if (this.autoConfirmationDismissed) {
            // Persist the guidance into lastSyncLabel so a later vault change
            // (onPendingChange, which falls back to lastSyncLabel when the
            // pending count is 0) cannot overwrite this "how to resolve" hint.
            this.lastSyncLabel = `待确认 ${result.plan.confirmations.length} 个，点击同步处理`;
            this.updateStatus(this.lastSyncLabel);
          } else {
            this.openConfirmationModal(result.plan.confirmations);
          }
        } else {
          // Manual entry points always open the modal and clear the degraded
          // state, since the user explicitly came to deal with the conflicts.
          this.autoConfirmationDismissed = false;
          this.openConfirmationModal(result.plan.confirmations);
        }
      }
    } catch (error) {
      this.updateStatus("同步失败");
      console.error("[Remote Sync] Sync failed.", {
        provider: this.settings.provider,
        syncStartedAt: this.syncStartedAt,
        options,
        error
      });
      new Notice(`同步失败：${formatError(error)}`);
    } finally {
      // Only clear the lock if it still belongs to this invocation.
      // A zombie recovery may have started a new sync (with a different
      // syncToken) while this stale call was still running; in that case
      // we must not clobber the new lock.
      if (this.syncStartedAt === syncToken) {
        this.syncStartedAt = null;
      }
    }

    return true;
  }

  private openConfirmationModal(confirmations: SyncConfirmation[]): void {
    if (this.confirmationModalOpen) {
      return;
    }
    // Set the guard synchronously before opening so concurrent attempts are
    // blocked regardless of when the Modal's onOpen callback fires.
    this.confirmationModalOpen = true;
    new SyncConfirmationModal(
      this.app,
      confirmations,
      (confirmationDecisions) => {
        // The user submitted a decision, so the conflicts are actually being
        // handled and the degraded auto-confirmation state can be cleared.
        // (Guard release is handled by onClosed below, which always runs.)
        this.autoConfirmationDismissed = false;
        void this.runSync({
          showBusyNotice: true,
          showConfigNotice: true,
          confirmManually: false,
          confirmationDecisions
        });
      },
      () => {
        // The user closed the modal without acting on it (X / Esc / "全部跳过").
        // Remember the dismissal so automatic syncs degrade to a status hint
        // instead of re-opening this modal on every poll.
        this.autoConfirmationDismissed = true;
      },
      () => {
        // Always runs on close, no matter the reason. Releasing the guard here
        // (rather than only on submit/dismiss) guarantees it can never get
        // stuck on and block every future confirmation modal.
        this.confirmationModalOpen = false;
      }
    ).open();
  }

  private openFirstSyncModal(): void {
    new FirstSyncModal(this.app, (initialSyncMode) => {
      void this.runSync({
        showBusyNotice: true,
        showConfigNotice: true,
        confirmManually: true,
        initialSyncMode
      });
    }).open();
  }

  private openRestoreBackupModal(): void {
    const backups = listLocalBackupFiles(this.app);
    new RestoreBackupModal(this.app, backups, (backup) => {
      void this.restoreBackup(backup);
    }).open();
  }

  private async restoreBackup(backup: BackupFileEntry): Promise<void> {
    try {
      await restoreLocalBackupFile(this.app, backup);
      new Notice(`已恢复备份：${backup.originalPath}`);
    } catch (error) {
      new Notice(`恢复备份失败：${formatError(error)}`);
    }
  }

  private registerAutoSync(): void {
    this.autoSyncController = new AutoSyncController({
      sync: () => this.syncAutomatically(),
      shouldIgnorePath: (path) =>
        shouldIgnorePath(path, this.settings.ignorePatterns, this.manifest.id),
      onPendingChange: (pendingCount) => {
        if (this.syncStartedAt !== null) {
          return;
        }
        this.updateStatus(
          pendingCount > 0 ? `待同步 ${pendingCount} 个变更` : this.lastSyncLabel
        );
      }
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

      // 启动同步：拉取其它设备在本设备离线期间的远端改动
      void this.syncAutomatically();

      // 窗口从后台切回前台/从休眠唤醒时，立即补一次同步，覆盖关闭期间其它设备
      // 或外部程序改动了文件但本地没有 vault 事件的漏感知场景。syncAutomatically
      // 自带 stale 守卫，频繁 focus 不会引发重复执行。
      this.registerDomEvent(globalThis as unknown as Window, "focus", () => {
        void this.syncAutomatically();
      });

      // 定时轮询：补齐"本地无文件事件但远端已变"的漏感知场景
      this.registerInterval(
        setInterval(() => {
          void this.syncAutomatically();
        }, AUTO_SYNC_POLL_INTERVAL_MS) as unknown as number
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
        pluginId: this.manifest.id,
        syncSafetyMode: this.settings.syncSafetyMode,
        maxAutoDeleteRatio: this.settings.maxAutoDeleteRatio,
        nonMergeableConflictPolicy: this.settings.nonMergeableConflictPolicy,
        deviceId: this.deviceId
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
      summary.initialSyncRequired
        ? "需首次确认"
        : summary.failures > 0 ? "失败" : summary.pendingConfirmations > 0 ? "待确认" : "成功";
    this.lastSyncLabel = `${status} ${new Date().toLocaleTimeString()}`;
    this.updateStatus(this.lastSyncLabel);

    if (summary.failures > 0) {
      console.warn("[Remote Sync] Sync completed with file failures.", {
        summary,
        failureDetails: summary.failureDetails
      });
    }

    new Notice(
      [
        `同步${status}。`,
        `首次同步待选择：${summary.initialSyncRequired ? 1 : 0}`,
        `上传：${summary.uploaded}`,
        `下载：${summary.downloaded}`,
        `合并：${summary.merged}`,
        `本地删除：${summary.deletedLocal}`,
        `远程删除：${summary.deletedRemote}`,
        `已备份：${summary.backedUp}`,
        `已跳过：${summary.skipped}`,
        `待确认：${summary.pendingConfirmations}`,
        `失败：${summary.failures}`,
        ...summary.failureDetails.slice(0, 5).map((failure) =>
          `- ${failure.path}：${failure.stage}：${failure.message}`
        )
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

  private async ensureDeviceId(): Promise<string> {
    if (this.deviceId) {
      return this.deviceId;
    }
    const data = await this.readPluginData();
    if (typeof data.deviceId === "string" && data.deviceId.length > 0) {
      this.deviceId = data.deviceId;
      return this.deviceId;
    }
    const generated = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.deviceId = generated;
    await this.saveData({ ...data, deviceId: generated });
    return generated;
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
