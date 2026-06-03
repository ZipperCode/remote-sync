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

    this.pendingPaths.add(path);
    this.options.onPendingChange?.(this.pendingPaths.size);
    this.requestSync();
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
