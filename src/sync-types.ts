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
}

export type SyncOperationKind =
  | "upload"
  | "download"
  | "delete-local"
  | "delete-remote";

export type SyncOperationReason =
  | "local-only"
  | "remote-only"
  | "local-changed"
  | "remote-changed"
  | "local-newer"
  | "remote-newer"
  | "local-deleted"
  | "remote-deleted";

export interface SyncOperation {
  kind: SyncOperationKind;
  path: string;
  reason: SyncOperationReason;
  local?: FileEntry;
  remote?: FileEntry;
  previous?: PreviousEntry;
}

export type SyncConfirmationReason =
  | "both-changed"
  | "same-mtime-different-size"
  | "local-deleted-remote-changed"
  | "remote-deleted-local-changed";

export interface SyncConfirmation {
  path: string;
  reason: SyncConfirmationReason;
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
}
