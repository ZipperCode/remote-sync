import { RenameMapping } from "./sync-types";

export const AUTO_SYNC_DEBOUNCE_MS = 3000;

export type AutoSyncRunResult = "completed" | "busy" | "skipped";

export interface AutoSyncControllerOptions {
  sync: () => Promise<void | AutoSyncRunResult>;
  shouldIgnorePath: (path: string) => boolean;
  debounceMs?: number;
  onPendingChange?: (pendingCount: number) => void;
}

export class AutoSyncController {
  private readonly debounceMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private syncInProgress = false;
  private pendingAfterCurrentSync = false;
  private pendingPaths = new Set<string>();
  private pendingRenames = new Map<string, string>();

  constructor(private readonly options: AutoSyncControllerOptions) {
    this.debounceMs = options.debounceMs ?? AUTO_SYNC_DEBOUNCE_MS;
  }

  handleVaultChange(path: string): void {
    if (this.options.shouldIgnorePath(path)) {
      return;
    }

    this.pendingPaths.add(path);
    this.options.onPendingChange?.(this.pendingPaths.size);
    this.requestSync();
  }

  handleVaultRename(path: string, oldPath: string): void {
    if (this.options.shouldIgnorePath(path) && this.options.shouldIgnorePath(oldPath)) {
      return;
    }

    this.recordRename(oldPath, path);
    this.pendingPaths.add(path);
    this.options.onPendingChange?.(this.pendingPaths.size);
    this.requestSync();
  }

  takePendingRenames(): RenameMapping[] {
    const renames = [...this.pendingRenames.entries()].map(([from, to]) => ({ from, to }));
    this.pendingRenames.clear();
    return renames;
  }

  private recordRename(from: string, to: string): void {
    // 链式合并：若已存在 X -> from，则更新为 X -> to（删除中间态 from）。
    let origin = from;
    for (const [existingFrom, existingTo] of this.pendingRenames.entries()) {
      if (existingTo === from) {
        origin = existingFrom;
        this.pendingRenames.delete(existingFrom);
        break;
      }
    }
    if (origin === to) {
      // 改回原名（A→B→A），净效果为空：移除该链。
      // 注意：真正的两文件交换（a↔b 互换名字）产生的事件序列与"改回原名"完全相同，
      // 因此也会在此被合并为空。这是已知且可接受的退化——引擎 applyRenames 的
      // remoteTargetExists 守卫 + trash 备份保证此时退化为普通同步计划不会丢数据，
      // 仅损失 rename 优化。区分两者需追踪文件内容/inode，不在当前范围内。
      this.pendingRenames.delete(origin);
      return;
    }
    this.pendingRenames.set(origin, to);
  }

  dispose(): void {
    this.clearTimer();
  }

  private requestSync(): void {
    if (this.syncInProgress) {
      this.pendingAfterCurrentSync = true;
      return;
    }

    this.scheduleSync();
  }

  private scheduleSync(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runSync();
    }, this.debounceMs);
  }

  private async runSync(): Promise<void> {
    if (this.syncInProgress) {
      this.pendingAfterCurrentSync = true;
      return;
    }

    this.syncInProgress = true;
    this.pendingPaths.clear();
    this.options.onPendingChange?.(0);
    let retryAfterCurrentSync = false;
    try {
      const result = await this.options.sync();
      retryAfterCurrentSync = result === "busy";
    } finally {
      this.syncInProgress = false;
      if (retryAfterCurrentSync || this.pendingAfterCurrentSync) {
        this.pendingAfterCurrentSync = false;
        this.scheduleSync();
      }
    }
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
