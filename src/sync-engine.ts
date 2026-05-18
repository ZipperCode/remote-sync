import {
  SyncConfirmation,
  SyncConfirmationDecision,
  SyncOperation,
  SyncPlan,
  FileEntry,
  planSync
} from "./sync-planner";
import { SyncStateStore } from "./sync-state-store";
import { normalizeVaultPath, REMOTE_SYNC_TRASH_DIR } from "./path-utils";

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
  skipped: number;
  conflicts: number;
  pendingConfirmations: number;
  backedUp: number;
  failures: number;
}

export interface SyncRunResult {
  plan: SyncPlan;
  summary: SyncSummary;
}

export class SyncEngine {
  constructor(
    private readonly local: SyncLocalStore,
    private readonly remote: SyncRemoteStore,
    private readonly stateStore: SyncStateStore,
    private readonly options: SyncEngineOptions
  ) {}

  async syncOnce(decisions: SyncConfirmationDecision[] = []): Promise<SyncRunResult> {
    await this.stateStore.load();

    const [localSnapshot, remoteSnapshot] = await Promise.all([
      this.local.snapshot(),
      this.remote.snapshot()
    ]);

    const plan = planSync({
      local: localSnapshot,
      remote: remoteSnapshot,
      previous: this.stateStore.getPreviousEntries(),
      ignorePatterns: this.options.ignorePatterns,
      pluginId: this.options.pluginId
    });

    const summary: SyncSummary = {
      uploaded: 0,
      downloaded: 0,
      deletedLocal: 0,
      deletedRemote: 0,
      skipped: plan.skipped.length,
      conflicts: 0,
      pendingConfirmations: 0,
      backedUp: 0,
      failures: 0
    };

    const approvedOperations = this.buildApprovedOperations(plan.confirmations, decisions);
    summary.pendingConfirmations = plan.confirmations.length - approvedOperations.length;
    summary.conflicts = summary.pendingConfirmations;

    const trashBatch = createTrashBatchName();
    for (const operation of [...plan.operations, ...approvedOperations]) {
      try {
        summary.backedUp += await this.executeOperation(operation, trashBatch);
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
        }
      } catch {
        summary.failures += 1;
      }
    }

    if (summary.failures === 0 && summary.pendingConfirmations === 0) {
      const [updatedLocalSnapshot, updatedRemoteSnapshot] = await Promise.all([
        this.local.snapshot(),
        this.remote.snapshot()
      ]);
      await this.stateStore.saveSuccessfulSync(updatedLocalSnapshot, updatedRemoteSnapshot);
    }

    return { plan, summary };
  }

  private buildApprovedOperations(
    confirmations: SyncConfirmation[],
    decisions: SyncConfirmationDecision[]
  ): SyncOperation[] {
    const decisionsByPath = new Map(decisions.map((decision) => [decision.path, decision.action]));
    const operations: SyncOperation[] = [];

    for (const confirmation of confirmations) {
      const action = decisionsByPath.get(confirmation.path);
      if (!action || action === "skip") {
        continue;
      }

      if (action === "use-local" && confirmation.local) {
        operations.push({
          kind: "upload",
          path: confirmation.path,
          reason: "local-newer",
          local: confirmation.local,
          remote: confirmation.remote,
          previous: confirmation.previous
        });
        continue;
      }

      if (action === "use-remote" && confirmation.remote) {
        operations.push({
          kind: "download",
          path: confirmation.path,
          reason: "remote-newer",
          local: confirmation.local,
          remote: confirmation.remote,
          previous: confirmation.previous
        });
        continue;
      }

      if (action === "accept-delete" && confirmation.local && !confirmation.remote) {
        operations.push({
          kind: "delete-local",
          path: confirmation.path,
          reason: "remote-deleted",
          local: confirmation.local,
          previous: confirmation.previous
        });
        continue;
      }

      if (action === "accept-delete" && confirmation.remote && !confirmation.local) {
        operations.push({
          kind: "delete-remote",
          path: confirmation.path,
          reason: "local-deleted",
          remote: confirmation.remote,
          previous: confirmation.previous
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
          backups += await this.backupFile(this.remote, operation.path, operation.remote, trashBatch);
        }
        const content = await this.local.readFile(operation.path);
        await this.remote.writeFile(operation.path, content, operation.local);
        return backups;
      }
      case "download": {
        let backups = 0;
        if (operation.local) {
          backups += await this.backupFile(this.local, operation.path, operation.local, trashBatch);
        }
        const content = await this.remote.readFile(operation.path);
        await this.local.writeFile(operation.path, content, operation.remote);
        return backups;
      }
      case "delete-local": {
        let backups = 0;
        if (operation.local) {
          backups += await this.backupFile(this.local, operation.path, operation.local, trashBatch);
        }
        await this.local.deleteFile(operation.path);
        return backups;
      }
      case "delete-remote": {
        let backups = 0;
        if (operation.remote) {
          backups += await this.backupFile(this.remote, operation.path, operation.remote, trashBatch);
        }
        await this.remote.deleteFile(operation.path);
        return backups;
      }
      default:
        throw new Error(`Unsupported operation: ${operation.kind}`);
    }
  }

  private async backupFile(
    store: SyncLocalStore | SyncRemoteStore,
    path: string,
    entry: FileEntry,
    trashBatch: string
  ): Promise<number> {
    const content = await store.readFile(path);
    await store.writeFile(normalizeVaultPath(`${REMOTE_SYNC_TRASH_DIR}/${trashBatch}/${path}`), content, entry);
    return 1;
  }
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
