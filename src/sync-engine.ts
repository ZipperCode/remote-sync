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
import { SyncConfirmationAction } from "./sync-types";
import { decodeTextContent, encodeTextContent, mergeTextContent } from "./text-merge";

export type InitialSyncMode = "ask" | "merge" | "use-local" | "use-remote";

export interface SyncOnceOptions {
  initialSyncMode?: InitialSyncMode;
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
        pluginId: this.options.pluginId
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

    const approvedOperations = this.buildApprovedOperations(plan.confirmations, decisions);
    const approvedPaths = new Set(approvedOperations.map(({ confirmation }) => confirmation.path));
    const pendingConfirmations = plan.confirmations.filter(
      (confirmation) => !approvedPaths.has(confirmation.path)
    );
    summary.pendingConfirmations = pendingConfirmations.length;
    summary.conflicts = pendingConfirmations.length;

    const trashBatch = createTrashBatchName();
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

    if (summary.failures === 0 && summary.pendingConfirmations === 0) {
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
          }
        );
      } catch (error) {
        this.recordFailure(summary, { path: "<sync-state>" }, error, "save-state");
      }
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
          throw new AutoMergeConflictError();
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
    return confirmation.suggestedKind === "merge" ? "auto-merge" : undefined;
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
