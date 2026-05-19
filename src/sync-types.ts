export type FileEntryType = "file" | "folder";

export interface FileEntry {
  path: string;
  type: FileEntryType;
  size: number;
  mtime: number;
  etag?: string;
}

export interface PreviousEntry {
  path: string;
  local?: FileEntry;
  remote?: FileEntry;
  mergeBase?: SyncMergeBase;
}

export type SyncOperationKind =
  | "upload"
  | "download"
  | "delete-local"
  | "delete-remote"
  | "merge";

export type SyncOperationReason =
  | "local-only"
  | "remote-only"
  | "local-changed"
  | "remote-changed"
  | "local-newer"
  | "remote-newer"
  | "local-deleted"
  | "remote-deleted"
  | "initial-sync-use-local"
  | "initial-sync-use-remote"
  | "auto-merge";

export type SyncMergeBaseSource = "previous-sync-state";

export interface SyncMergeBase {
  source: SyncMergeBaseSource;
  content: string;
}

export interface SyncMergeResult {
  baseSource: SyncMergeBaseSource;
  mergedContent?: string;
}

export interface SyncOperation {
  kind: SyncOperationKind;
  path: string;
  reason: SyncOperationReason;
  local?: FileEntry;
  remote?: FileEntry;
  previous?: PreviousEntry;
  merge?: SyncMergeResult;
}

export type SyncConfirmationReason =
  | "both-changed"
  | "same-mtime-different-size"
  | "local-deleted"
  | "remote-deleted"
  | "local-deleted-remote-changed"
  | "remote-deleted-local-changed";

export type SyncConflictType =
  | "text-auto-merge"
  | "text-overlap"
  | "text-no-base"
  | "text-too-large"
  | "binary"
  | "delete-vs-modify";

export interface SyncConfirmation {
  path: string;
  reason: SyncConfirmationReason;
  conflictType: SyncConflictType;
  suggestedKind?: SyncOperationKind;
  local?: FileEntry;
  remote?: FileEntry;
  previous?: PreviousEntry;
}

export type SyncConflict = SyncConfirmation;

export type SyncConfirmationAction =
  | "use-local"
  | "use-remote"
  | "accept-delete"
  | "auto-merge"
  | "skip";

export interface SyncConfirmationDecision {
  path: string;
  action: SyncConfirmationAction;
}

export interface SkippedEntry {
  path: string;
  side: "local" | "remote";
  entry: FileEntry;
}

export interface SyncPlan {
  operations: SyncOperation[];
  confirmations: SyncConfirmation[];
  conflicts: SyncConflict[];
  skipped: SkippedEntry[];
  initialSyncRequired?: boolean;
}
