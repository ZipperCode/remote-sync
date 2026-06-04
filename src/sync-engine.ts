import {
  SyncConfirmation,
  SyncConfirmationDecision,
  SyncOperation,
  SyncPlan,
  FileEntry,
  planSync
} from "./sync-planner";
import { SyncStateStore } from "./sync-state-store";
import { normalizeVaultPath, REMOTE_SYNC_TRASH_DIR, shouldIgnorePath } from "./path-utils";
import { NonMergeableConflictPolicy, RenameMapping, SyncConfirmationAction, SyncSafetyMode } from "./sync-types";
import { decodeTextContent, encodeTextContent, mergeTextContent } from "./text-merge";
import { buildConflictCopyPath } from "./device-id";

export type InitialSyncMode = "ask" | "merge" | "use-local" | "use-remote";

export interface SyncOnceOptions {
  initialSyncMode?: InitialSyncMode;
  renames?: RenameMapping[];
}

export interface SyncLocalStore {
  snapshot(): Promise<FileEntry[]>;
  readFile(path: string): Promise<ArrayBuffer>;
  writeFile(path: string, content: ArrayBuffer, source?: FileEntry): Promise<void>;
  deleteFile(path: string): Promise<void>;
}

export interface SyncRemoteStore {
  snapshot(): Promise<FileEntry[]>;
  readFile(path: string): Promise<ArrayBuffer>;
  writeFile(path: string, content: ArrayBuffer, source?: FileEntry): Promise<void>;
  deleteFile(path: string): Promise<void>;
}

export interface SyncEngineOptions {
  ignorePatterns: string[];
  pluginId?: string;
  syncSafetyMode?: SyncSafetyMode;
  maxAutoDeleteRatio?: number;
  nonMergeableConflictPolicy?: NonMergeableConflictPolicy;
  deviceId?: string;
}

export interface SyncSummary {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  merged: number;
  skipped: number;
  conflicts: number;
  pendingConfirmations: number;
  backedUp: number;
  failures: number;
  initialSyncRequired: boolean;
  failureDetails: SyncFailureDetail[];
}

export interface SyncRunResult {
  plan: SyncPlan;
  summary: SyncSummary;
}

export type SyncFailureStage =
  | "backup-local"
  | "backup-remote-to-local"
  | "upload"
  | "download"
  | "delete-local"
  | "delete-remote"
  | "merge"
  | "save-state";

export interface SyncFailureDetail {
  path: string;
  stage: SyncFailureStage;
  message: string;
}

interface ApprovedOperation {
  confirmation: SyncConfirmation;
  operation: SyncOperation;
}

export class SyncEngine {
  constructor(
    private readonly local: SyncLocalStore,
    private readonly remote: SyncRemoteStore,
    private readonly stateStore: SyncStateStore,
    private readonly options: SyncEngineOptions
  ) {}

  async syncOnce(
    decisions: SyncConfirmationDecision[] = [],
    options: SyncOnceOptions = {}
  ): Promise<SyncRunResult> {
    await this.stateStore.load();

    const [localSnapshot, remoteSnapshot] = await Promise.all([
      this.local.snapshot(),
      this.remote.snapshot()
    ]);

    const previousEntries = this.stateStore.getPreviousEntries();
    const initialSyncMode = options.initialSyncMode ?? "ask";
    const isInitialSync =
      this.stateStore.getLastSyncTime() === 0 &&
      previousEntries.length === 0 &&
      (localSnapshot.length > 0 || remoteSnapshot.length > 0);

    let plan: SyncPlan;
    if (isInitialSync && initialSyncMode === "ask") {
      plan = {
        operations: [],
        confirmations: [],
        conflicts: [],
        skipped: [],
        initialSyncRequired: true
      };
    } else if (
      isInitialSync &&
      (initialSyncMode === "use-local" || initialSyncMode === "use-remote")
    ) {
      plan = this.planAuthoritativeInitialSync(localSnapshot, remoteSnapshot, initialSyncMode);
    } else {
      plan = planSync({
        local: localSnapshot,
        remote: remoteSnapshot,
        previous: previousEntries,
        ignorePatterns: this.options.ignorePatterns,
        pluginId: this.options.pluginId,
        syncSafetyMode: this.options.syncSafetyMode,
        maxAutoDeleteRatio: this.options.maxAutoDeleteRatio
      });
    }

    const summary: SyncSummary = {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      merged: 0,
      skipped: plan.skipped.length,
      conflicts: 0,
      pendingConfirmations: 0,
      backedUp: 0,
      failures: 0,
      initialSyncRequired: Boolean(plan.initialSyncRequired),
      failureDetails: []
    };

    if (plan.initialSyncRequired) {
      return { plan, summary };
    }

    // 整轮同步共用同一个 trashBatch：rename 搬迁的备份与后续 plan.operations 的备份
    // 都落入同一批次目录。此处已确定非 initialSyncRequired（上方已早返回），
    // 故仅在确实要执行操作时才分配批次名，不会在"只返回计划"的纯查询路径上凭空生成。
    const trashBatch = createTrashBatchName();

    const renameHandledPaths = new Set<string>();
    const renameFailures: SyncFailureDetail[] = [];
    let renameBackups = 0;
    if (options.renames && options.renames.length > 0) {
      renameBackups = await this.applyRenames(
        options.renames,
        localSnapshot,
        remoteSnapshot,
        renameHandledPaths,
        renameFailures,
        trashBatch
      );
      if (renameHandledPaths.size > 0) {
        plan = {
          ...plan,
          operations: plan.operations.filter((op) => !renameHandledPaths.has(op.path)),
          confirmations: plan.confirmations.filter((c) => !renameHandledPaths.has(c.path)),
          conflicts: plan.conflicts.filter((c) => !renameHandledPaths.has(c.path))
        };
      }
    }

    for (const failure of renameFailures) {
      summary.failureDetails.push(failure);
      summary.failures += 1;
    }
    // rename 搬迁删除远端旧文件前产生的本地备份计入总备份数。
    summary.backedUp += renameBackups;

    const approvedOperations = this.buildApprovedOperations(plan.confirmations, decisions);
    const approvedPaths = new Set(approvedOperations.map(({ confirmation }) => confirmation.path));
    const pendingConfirmations = plan.confirmations.filter(
      (confirmation) => !approvedPaths.has(confirmation.path)
    );
    summary.pendingConfirmations = pendingConfirmations.length;
    summary.conflicts = pendingConfirmations.length;

    for (const operation of plan.operations) {
      try {
        summary.backedUp += await this.executeOperation(operation, trashBatch);
        this.incrementSummary(summary, operation);
      } catch (error) {
        this.recordFailure(summary, operation, error);
      }
    }

    for (const approved of approvedOperations) {
      try {
        summary.backedUp += await this.executeOperation(approved.operation, trashBatch);
        this.incrementSummary(summary, approved.operation);
      } catch (error) {
        if (error instanceof AutoMergeConflictError) {
          pendingConfirmations.push(this.createManualMergeConfirmation(approved.confirmation));
          continue;
        }
        this.recordFailure(summary, approved.operation, error);
      }
    }

    summary.pendingConfirmations = pendingConfirmations.length;
    summary.conflicts = pendingConfirmations.length;

    // 即便存在待确认/失败，也要落盘已成功的部分：对已处理路径推进基线，对
    // 待确认与失败路径保留旧基线，避免"一个未决导致整体重算、永远待确认"。
    // 注意时序：unresolvedPaths 必须在落盘之前算好。落盘失败时记录的伪路径
    // "<sync-state>" 是在下方 catch 里才并入 failureDetails 的，不会回灌进本集合，
    // 故不会被 saveSuccessfulSync 误当作真实文件路径处理。
    const unresolvedPaths = new Set<string>([
      ...pendingConfirmations.map((confirmation) => confirmation.path),
      ...summary.failureDetails.map((failure) => failure.path)
    ]);
    const [updatedLocalSnapshot, updatedRemoteSnapshot] = await Promise.all([
      this.local.snapshot(),
      this.remote.snapshot()
    ]);
    try {
      await this.stateStore.saveSuccessfulSync(
        this.filterIgnoredEntries(updatedLocalSnapshot),
        this.filterIgnoredEntries(updatedRemoteSnapshot),
        async (path) => {
          try {
            return decodeTextContent(await this.local.readFile(path));
          } catch {
            return undefined;
          }
        },
        unresolvedPaths
      );
    } catch (error) {
      // 伪路径仅用于失败上报，不参与基线计算（见上方时序说明）。
      this.recordFailure(summary, { path: "<sync-state>" }, error, "save-state");
    }

    return {
      plan: {
        ...plan,
        confirmations: pendingConfirmations,
        conflicts: pendingConfirmations
      },
      summary
    };
  }

  private planAuthoritativeInitialSync(
    localSnapshot: FileEntry[],
    remoteSnapshot: FileEntry[],
    mode: Exclude<InitialSyncMode, "ask" | "merge">
  ): SyncPlan {
    const local = new Map(localSnapshot.map((entry) => [entry.path, entry]));
    const remote = new Map(remoteSnapshot.map((entry) => [entry.path, entry]));
    const paths = [...new Set([...local.keys(), ...remote.keys()])].sort();
    const operations: SyncOperation[] = [];

    for (const path of paths) {
      const localEntry = local.get(path);
      const remoteEntry = remote.get(path);

      if (mode === "use-local") {
        if (localEntry) {
          operations.push({
            kind: "upload",
            path,
            reason: "initial-sync-use-local",
            local: localEntry,
            remote: remoteEntry
          });
          continue;
        }

        if (remoteEntry) {
          operations.push({
            kind: "delete-remote",
            path,
            reason: "initial-sync-use-local",
            remote: remoteEntry
          });
        }
        continue;
      }

      if (remoteEntry) {
        operations.push({
          kind: "download",
          path,
          reason: "initial-sync-use-remote",
          local: localEntry,
          remote: remoteEntry
        });
        continue;
      }

      if (localEntry) {
        operations.push({
          kind: "delete-local",
          path,
          reason: "initial-sync-use-remote",
          local: localEntry
        });
      }
    }

    return { operations, confirmations: [], conflicts: [], skipped: [] };
  }

  private filterIgnoredEntries(entries: FileEntry[]): FileEntry[] {
    return entries.filter(
      (entry) => !shouldIgnorePath(entry.path, this.options.ignorePatterns, this.options.pluginId)
    );
  }

  private buildApprovedOperations(
    confirmations: SyncConfirmation[],
    decisions: SyncConfirmationDecision[]
  ): ApprovedOperation[] {
    const decisionsByPath = new Map(decisions.map((decision) => [decision.path, decision.action]));
    const operations: ApprovedOperation[] = [];

    for (const confirmation of confirmations) {
      const action = decisionsByPath.get(confirmation.path) ?? this.defaultAction(confirmation);
      if (!action || action === "skip") {
        continue;
      }

      if (action === "use-local" && confirmation.local) {
        operations.push({
          confirmation,
          operation: {
            kind: "upload",
            path: confirmation.path,
            reason: "local-newer",
            local: confirmation.local,
            remote: confirmation.remote,
            previous: confirmation.previous
          }
        });
        continue;
      }

      if (action === "use-remote" && confirmation.remote) {
        operations.push({
          confirmation,
          operation: {
            kind: "download",
            path: confirmation.path,
            reason: "remote-newer",
            local: confirmation.local,
            remote: confirmation.remote,
            previous: confirmation.previous
          }
        });
        continue;
      }

      if (action === "accept-delete" && confirmation.local && !confirmation.remote) {
        operations.push({
          confirmation,
          operation: {
            kind: "delete-local",
            path: confirmation.path,
            reason: "remote-deleted",
            local: confirmation.local,
            previous: confirmation.previous
          }
        });
        continue;
      }

      if (action === "accept-delete" && confirmation.remote && !confirmation.local) {
        operations.push({
          confirmation,
          operation: {
            kind: "delete-remote",
            path: confirmation.path,
            reason: "local-deleted",
            remote: confirmation.remote,
            previous: confirmation.previous
          }
        });
        continue;
      }

      if (
        action === "auto-merge" &&
        confirmation.local &&
        confirmation.remote &&
        confirmation.previous?.mergeBase
      ) {
        operations.push({
          confirmation,
          operation: {
            kind: "merge",
            path: confirmation.path,
            reason: "auto-merge",
            local: confirmation.local,
            remote: confirmation.remote,
            previous: confirmation.previous,
            merge: {
              baseSource: confirmation.previous.mergeBase.source
            }
          }
        });
      }
    }

    return operations;
  }

  private async executeOperation(operation: SyncOperation, trashBatch: string): Promise<number> {
    switch (operation.kind) {
      case "upload": {
        let backups = 0;
        if (operation.remote) {
          backups += await this.backupRemoteFileToLocal(operation.path, operation.remote, trashBatch);
        }
        const content = await this.runStage(operation.path, "upload", () => this.local.readFile(operation.path));
        await this.runStage(operation.path, "upload", () =>
          this.remote.writeFile(operation.path, content, operation.local)
        );
        return backups;
      }
      case "download": {
        let backups = 0;
        if (operation.local) {
          backups += await this.backupLocalFile(operation.path, operation.local, trashBatch);
        }
        const content = await this.runStage(operation.path, "download", () => this.remote.readFile(operation.path));
        await this.runStage(operation.path, "download", () =>
          this.local.writeFile(operation.path, content, operation.remote)
        );
        return backups;
      }
      case "delete-local": {
        let backups = 0;
        if (operation.local) {
          backups += await this.backupLocalFile(operation.path, operation.local, trashBatch);
        }
        await this.runStage(operation.path, "delete-local", () => this.local.deleteFile(operation.path));
        return backups;
      }
      case "delete-remote": {
        let backups = 0;
        if (operation.remote) {
          backups += await this.backupRemoteFileToLocal(operation.path, operation.remote, trashBatch);
        }
        await this.runStage(operation.path, "delete-remote", () => this.remote.deleteFile(operation.path));
        return backups;
      }
      case "merge": {
        if (!operation.local || !operation.remote || !operation.previous?.mergeBase) {
          throw new AutoMergeConflictError();
        }

        let mergeResult: ReturnType<typeof mergeTextContent>;
        const [localContent, remoteContent] = await this.runStage(operation.path, "merge", () =>
          Promise.all([
            this.local.readFile(operation.path),
            this.remote.readFile(operation.path)
          ])
        );
        mergeResult = mergeTextContent(
          operation.previous.mergeBase.content,
          decodeTextContent(localContent),
          decodeTextContent(remoteContent)
        );

        if (!mergeResult.ok) {
          return await this.resolveUnmergeableTextConflict(
            operation,
            remoteContent,
            trashBatch
          );
        }

        let backups = 0;
        backups += await this.backupLocalFile(operation.path, operation.local, trashBatch);
        backups += await this.backupRemoteFileToLocal(operation.path, operation.remote, trashBatch);

        operation.merge = {
          baseSource: operation.previous.mergeBase.source,
          mergedContent: mergeResult.mergedContent
        };

        const mergedBuffer = encodeTextContent(mergeResult.mergedContent);
        const mergedEntry = this.createMergedEntry(operation, mergedBuffer.byteLength);
        await this.runStage(operation.path, "merge", () =>
          Promise.all([
            this.local.writeFile(operation.path, mergedBuffer, mergedEntry),
            this.remote.writeFile(operation.path, mergedBuffer, mergedEntry)
          ])
        );
        return backups;
      }
      default:
        throw new Error(`Unsupported operation: ${operation.kind}`);
    }
  }

  private defaultAction(confirmation: SyncConfirmation): SyncConfirmationAction | undefined {
    if (this.options.syncSafetyMode === "manual") {
      return undefined;
    }
    if (confirmation.suggestedKind === "merge") {
      return "auto-merge";
    }
    if (
      (this.options.nonMergeableConflictPolicy ?? "newer-wins") === "newer-wins" &&
      confirmation.local &&
      confirmation.remote &&
      (confirmation.conflictType === "text-too-large" ||
        confirmation.conflictType === "binary" ||
        confirmation.conflictType === "text-no-base")
    ) {
      return confirmation.local.mtime >= confirmation.remote.mtime ? "use-local" : "use-remote";
    }
    return undefined;
  }

  private incrementSummary(summary: SyncSummary, operation: SyncOperation): void {
    switch (operation.kind) {
      case "upload":
        summary.uploaded += 1;
        break;
      case "download":
        summary.downloaded += 1;
        break;
      case "delete-local":
        summary.deletedLocal += 1;
        break;
      case "delete-remote":
        summary.deletedRemote += 1;
        break;
      case "merge":
        summary.merged += 1;
        break;
    }
  }

  private createManualMergeConfirmation(confirmation: SyncConfirmation): SyncConfirmation {
    return {
      ...confirmation,
      conflictType: "text-overlap",
      suggestedKind:
        confirmation.local && confirmation.remote && confirmation.local.mtime !== confirmation.remote.mtime
          ? confirmation.local.mtime > confirmation.remote.mtime
            ? "upload"
            : "download"
          : undefined
    };
  }

  private createMergedEntry(operation: SyncOperation, size: number): FileEntry {
    return {
      path: operation.path,
      type: "file",
      size,
      mtime: Math.max(operation.local?.mtime ?? 0, operation.remote?.mtime ?? 0)
    };
  }

  private async resolveUnmergeableTextConflict(
    operation: SyncOperation,
    remoteContent: ArrayBuffer,
    trashBatch: string
  ): Promise<number> {
    if (!operation.local || !operation.remote) {
      throw new AutoMergeConflictError();
    }

    // 远端原内容先备份到隐藏 trash 目录（兜底，防止任何后续步骤异常导致内容不可达）
    let backups = 0;
    backups += await this.backupRemoteFileToLocal(operation.path, operation.remote, trashBatch);

    // 把远端版本另存为用户可见的 conflict 副本。
    // 关键：副本必须同时写入本地和远端，否则下次同步时副本是 local-only 文件，
    // 会被 planLocalOnly 在 balanced 模式下判定为 remote-deleted 而删除。
    // 两端都写后，下次同步副本两端一致、previous 齐全，稳定收敛，且对端用户也能看到冲突。
    const conflictPath = buildConflictCopyPath(
      operation.path,
      this.options.deviceId ?? "device",
      operation.remote.mtime
    );
    const conflictEntry: FileEntry = {
      path: conflictPath,
      type: "file",
      size: remoteContent.byteLength,
      mtime: operation.remote.mtime
    };
    await this.runStage(conflictPath, "merge", () =>
      Promise.all([
        this.local.writeFile(conflictPath, remoteContent, conflictEntry),
        this.remote.writeFile(conflictPath, remoteContent, conflictEntry)
      ])
    );

    // 本地版本视为权威，上传覆盖远端原文件（远端原内容此时已落入副本和 trash，覆盖是安全的）。
    // 若此步失败：state 不保存，下次同步会重做本次收尾（副本路径含固定的 remote.mtime，幂等覆盖同名副本，不累积）。
    const localContent = await this.runStage(operation.path, "upload", () =>
      this.local.readFile(operation.path)
    );
    await this.runStage(operation.path, "upload", () =>
      this.remote.writeFile(operation.path, localContent, operation.local)
    );

    return backups;
  }

  private async applyRenames(
    renames: RenameMapping[],
    localSnapshot: FileEntry[],
    remoteSnapshot: FileEntry[],
    handled: Set<string>,
    failures: SyncFailureDetail[],
    trashBatch: string
  ): Promise<number> {
    // 快照路径未必归一化，而 plan 的 operations/confirmations 路径已被 planSync 归一化。
    // 这里统一在归一化空间工作（Map 键、from/to、handled 三者一致），
    // 确保 handled 能正确从 plan 中剔除已搬迁的路径，避免重复操作。
    const localByPath = new Map(
      localSnapshot.map((entry) => [normalizeVaultPath(entry.path), entry])
    );
    const remoteByPath = new Map(
      remoteSnapshot.map((entry) => [normalizeVaultPath(entry.path), entry])
    );

    let backups = 0;

    for (const rename of renames) {
      const from = normalizeVaultPath(rename.from);
      const to = normalizeVaultPath(rename.to);
      if (!from || !to || from === to) {
        continue;
      }
      const localTarget = localByPath.get(to);
      const remoteSource = remoteByPath.get(from);
      const remoteTargetExists = remoteByPath.has(to);

      // 本地无新文件（改名后又删）、远端无旧文件（远端从无此文件）、
      // 或远端已存在新文件（避免覆盖对端）—— 任一成立则不搬迁，交给正常计划处理。
      if (!localTarget || !remoteSource || remoteTargetExists) {
        continue;
      }

      try {
        const content = await this.runStage(to, "upload", () => this.local.readFile(to));
        await this.runStage(to, "upload", () => this.remote.writeFile(to, content, localTarget));
        // 删除远端旧文件前必须先把其内容备份到本地 trash，维持引擎"任何远端删除都先落 trash"的契约。
        // backupRemoteFileToLocal 内部已用 runStage 包裹（stage="backup-remote-to-local"），
        // 失败会抛 SyncOperationFailure 中断本次搬迁，不会继续删除（备份失败计入 failures）。
        backups += await this.backupRemoteFileToLocal(from, remoteSource, trashBatch);
        await this.runStage(from, "delete-remote", () => this.remote.deleteFile(from));
        handled.add(from);
        handled.add(to);
      } catch (error) {
        if (error instanceof SyncOperationFailure) {
          failures.push(error.detail);
        } else {
          failures.push({ path: to, stage: "upload", message: formatError(error) });
        }
      }
    }

    return backups;
  }

  private recordFailure(
    summary: SyncSummary,
    operation: Pick<SyncOperation, "path">,
    error: unknown,
    fallbackStage: SyncFailureStage = "merge"
  ): void {
    const detail =
      error instanceof SyncOperationFailure
        ? error.detail
        : {
            path: operation.path,
            stage: fallbackStage,
            message: formatError(error)
          };
    summary.failures += 1;
    summary.failureDetails.push(detail);
  }

  private async runStage<T>(
    path: string,
    stage: SyncFailureStage,
    action: () => Promise<T>
  ): Promise<T> {
    try {
      return await action();
    } catch (error) {
      console.error("[Remote Sync] Sync stage failed.", {
        path,
        stage,
        error
      });
      throw new SyncOperationFailure({
        path,
        stage,
        message: formatError(error)
      });
    }
  }

  private async backupLocalFile(
    path: string,
    entry: FileEntry,
    trashBatch: string
  ): Promise<number> {
    const content = await this.runStage(path, "backup-local", () => this.local.readFile(path));
    await this.writeLocalBackup("local", path, content, entry, trashBatch);
    return 1;
  }

  private async backupRemoteFileToLocal(
    path: string,
    entry: FileEntry,
    trashBatch: string
  ): Promise<number> {
    const content = await this.runStage(path, "backup-remote-to-local", () => this.remote.readFile(path));
    await this.writeLocalBackup("remote", path, content, entry, trashBatch);
    return 1;
  }

  private async writeLocalBackup(
    source: "local" | "remote",
    path: string,
    content: ArrayBuffer,
    entry: FileEntry,
    trashBatch: string
  ): Promise<void> {
    await this.runStage(path, source === "local" ? "backup-local" : "backup-remote-to-local", () =>
      this.local.writeFile(
        normalizeVaultPath(`${REMOTE_SYNC_TRASH_DIR}/${trashBatch}/${source}/${path}`),
        content,
        entry
      )
    );
  }
}

class SyncOperationFailure extends Error {
  constructor(readonly detail: SyncFailureDetail) {
    super(detail.message);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createTrashBatchName(now = new Date()): string {
  const pad = (value: number, size = 2) => value.toString().padStart(size, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    "-",
    pad(now.getMilliseconds(), 3)
  ].join("");
}

class AutoMergeConflictError extends Error {}
