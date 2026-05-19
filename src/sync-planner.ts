import { isRemoteSyncTrashPath, normalizeVaultPath, shouldIgnorePath } from "./path-utils";
import {
  FileEntry,
  PreviousEntry,
  SkippedEntry,
  SyncConfirmation,
  SyncConflict,
  SyncOperation,
  SyncPlan
} from "./sync-types";
import { isAutoMergeTextEntry, MAX_MERGE_BASE_BYTES } from "./text-merge";

export type {
  FileEntry,
  PreviousEntry,
  SkippedEntry,
  SyncConfirmation,
  SyncConfirmationDecision,
  SyncConflict,
  SyncOperation,
  SyncPlan
} from "./sync-types";

export interface PlanSyncInput {
  local: FileEntry[];
  remote: FileEntry[];
  previous: PreviousEntry[];
  ignorePatterns: string[];
  pluginId?: string;
}

export function planSync(input: PlanSyncInput): SyncPlan {
  const skipped: SkippedEntry[] = [];
  const local = buildEntryMap(input.local, "local", input.ignorePatterns, skipped, input.pluginId);
  const remote = buildEntryMap(input.remote, "remote", input.ignorePatterns, skipped, input.pluginId);
  const previous = buildPreviousMap(input.previous, input.ignorePatterns, input.pluginId);

  const paths = new Set<string>([
    ...local.keys(),
    ...remote.keys(),
    ...previous.keys()
  ]);

  const operations: SyncOperation[] = [];
  const confirmations: SyncConfirmation[] = [];

  for (const path of [...paths].sort()) {
    const localEntry = local.get(path);
    const remoteEntry = remote.get(path);
    const previousEntry = previous.get(path);

    if (!localEntry && !remoteEntry) {
      continue;
    }

    if (localEntry && !remoteEntry) {
      planLocalOnly(operations, confirmations, localEntry, previousEntry);
      continue;
    }

    if (!localEntry && remoteEntry) {
      planRemoteOnly(operations, confirmations, remoteEntry, previousEntry);
      continue;
    }

    if (localEntry && remoteEntry) {
      planBothPresent(operations, confirmations, localEntry, remoteEntry, previousEntry);
    }
  }

  return { operations, confirmations, conflicts: confirmations, skipped };
}

function buildEntryMap(
  entries: FileEntry[],
  side: "local" | "remote",
  ignorePatterns: string[],
  skipped: SkippedEntry[],
  pluginId?: string
): Map<string, FileEntry> {
  const map = new Map<string, FileEntry>();

  for (const entry of entries) {
    const normalized = normalizeEntry(entry);
    if (normalized.type !== "file") {
      continue;
    }
    if (shouldIgnorePath(normalized.path, ignorePatterns, pluginId)) {
      if (!isRemoteSyncTrashPath(normalized.path)) {
        skipped.push({ path: normalized.path, side, entry: normalized });
      }
      continue;
    }
    map.set(normalized.path, normalized);
  }

  return map;
}

function buildPreviousMap(
  entries: PreviousEntry[],
  ignorePatterns: string[],
  pluginId?: string
): Map<string, PreviousEntry> {
  const map = new Map<string, PreviousEntry>();

  for (const entry of entries) {
    const normalized = normalizeVaultPath(entry.path);
    if (!normalized || shouldIgnorePath(normalized, ignorePatterns, pluginId)) {
      continue;
    }

    map.set(normalized, {
      path: normalized,
      local: entry.local ? normalizeEntry(entry.local) : undefined,
      remote: entry.remote ? normalizeEntry(entry.remote) : undefined,
      mergeBase: entry.mergeBase ? { ...entry.mergeBase } : undefined
    });
  }

  return map;
}

function normalizeEntry(entry: FileEntry): FileEntry {
  return {
    ...entry,
    path: normalizeVaultPath(entry.path)
  };
}

function planLocalOnly(
  operations: SyncOperation[],
  confirmations: SyncConfirmation[],
  local: FileEntry,
  previous?: PreviousEntry
): void {
  if (!previous) {
    operations.push({ kind: "upload", path: local.path, reason: "local-only", local });
    return;
  }

  if (entryChanged(local, previous.local)) {
    confirmations.push({
      path: local.path,
      reason: "remote-deleted-local-changed",
      conflictType: "delete-vs-modify",
      local,
      previous
    });
    return;
  }

  confirmations.push({
    path: local.path,
    reason: "remote-deleted",
    conflictType: "delete-vs-modify",
    local,
    previous
  });
}

function planRemoteOnly(
  operations: SyncOperation[],
  confirmations: SyncConfirmation[],
  remote: FileEntry,
  previous?: PreviousEntry
): void {
  if (!previous) {
    operations.push({ kind: "download", path: remote.path, reason: "remote-only", remote });
    return;
  }

  if (entryChanged(remote, previous.remote)) {
    confirmations.push({
      path: remote.path,
      reason: "local-deleted-remote-changed",
      conflictType: "delete-vs-modify",
      remote,
      previous
    });
    return;
  }

  confirmations.push({
    path: remote.path,
    reason: "local-deleted",
    conflictType: "delete-vs-modify",
    remote,
    previous
  });
}

function planBothPresent(
  operations: SyncOperation[],
  confirmations: SyncConfirmation[],
  local: FileEntry,
  remote: FileEntry,
  previous?: PreviousEntry
): void {
  if (!previous) {
    planNewBothPresent(confirmations, local, remote);
    return;
  }

  const localChanged = entryChanged(local, previous.local);
  const remoteChanged = entryChanged(remote, previous.remote);

  if (!localChanged && !remoteChanged) {
    return;
  }

  if (localChanged && !remoteChanged) {
    operations.push({
      kind: "upload",
      path: local.path,
      reason: "local-changed",
      local,
      remote,
      previous
    });
    return;
  }

  if (!localChanged && remoteChanged) {
    operations.push({
      kind: "download",
      path: remote.path,
      reason: "remote-changed",
      local,
      remote,
      previous
    });
    return;
  }

  planContentConfirmation(confirmations, local, remote, previous);
}

function planNewBothPresent(
  confirmations: SyncConfirmation[],
  local: FileEntry,
  remote: FileEntry
): void {
  if (entriesEquivalent(local, remote)) {
    return;
  }

  planContentConfirmation(confirmations, local, remote);
}

function planContentConfirmation(
  confirmations: SyncConfirmation[],
  local: FileEntry,
  remote: FileEntry,
  previous?: PreviousEntry
): void {
  if (local.mtime === remote.mtime) {
    if (local.size !== remote.size) {
      const classification = classifyContentConflict(local, remote, previous);
      confirmations.push({
        path: local.path,
        reason: "same-mtime-different-size",
        conflictType: classification.conflictType,
        suggestedKind: classification.suggestedKind,
        local,
        remote,
        previous
      });
    }
    return;
  }

  const classification = classifyContentConflict(local, remote, previous);
  confirmations.push({
    path: local.path,
    reason: "both-changed",
    conflictType: classification.conflictType,
    suggestedKind: classification.suggestedKind,
    local,
    remote,
    previous
  });
}

function classifyContentConflict(
  local: FileEntry,
  remote: FileEntry,
  previous?: PreviousEntry
): Pick<SyncConfirmation, "conflictType" | "suggestedKind"> {
  if (!isAutoMergeTextEntry(local) || !isAutoMergeTextEntry(remote)) {
    return { conflictType: "binary" };
  }

  if (local.size > MAX_MERGE_BASE_BYTES || remote.size > MAX_MERGE_BASE_BYTES) {
    return { conflictType: "text-too-large" };
  }

  if (!previous?.mergeBase?.content) {
    return { conflictType: "text-no-base" };
  }

  return { conflictType: "text-auto-merge", suggestedKind: "merge" };
}

function entryChanged(current: FileEntry, previous?: FileEntry): boolean {
  if (!previous) {
    return true;
  }

  if (current.mtime !== previous.mtime || current.size !== previous.size) {
    return true;
  }

  return Boolean(current.etag && previous.etag && current.etag !== previous.etag);
}

function entriesEquivalent(left: FileEntry, right: FileEntry): boolean {
  return left.mtime === right.mtime && left.size === right.size;
}
