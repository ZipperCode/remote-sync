import { isRemoteSyncTrashPath, normalizeVaultPath, shouldIgnorePath } from "./path-utils";
import {
  FileEntry,
  PreviousEntry,
  SkippedEntry,
  SyncConfirmation,
  SyncConflict,
  SyncOperation,
  SyncPlan,
  SyncSafetyMode
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
  syncSafetyMode?: SyncSafetyMode;
  maxAutoDeleteRatio?: number;
}

const DEFAULT_MAX_AUTO_DELETE_RATIO = 0.3;

// 普通删除（一端删、另一端自上次同步未改）是否自动传播。
// "manual"：删除都需确认；"auto"：自动传播，再受占比上限兜底。
// 冲突型删除（delete-vs-modify）走前置 entryChanged 守卫，任何档都仍确认。
function shouldAutoPropagateDelete(mode: SyncSafetyMode): boolean {
  return mode === "auto";
}

export function planSync(input: PlanSyncInput): SyncPlan {
  const skipped: SkippedEntry[] = [];
  const local = buildEntryMap(input.local, "local", input.ignorePatterns, skipped, input.pluginId);
  const remote = buildEntryMap(input.remote, "remote", input.ignorePatterns, skipped, input.pluginId);
  const previous = buildPreviousMap(input.previous, input.ignorePatterns, input.pluginId);
  const syncSafetyMode = input.syncSafetyMode ?? "auto";
  const maxAutoDeleteRatio = input.maxAutoDeleteRatio ?? DEFAULT_MAX_AUTO_DELETE_RATIO;

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
      planLocalOnly(operations, confirmations, localEntry, previousEntry, syncSafetyMode);
      continue;
    }

    if (!localEntry && remoteEntry) {
      planRemoteOnly(operations, confirmations, remoteEntry, previousEntry, syncSafetyMode);
      continue;
    }

    if (localEntry && remoteEntry) {
      planBothPresent(operations, confirmations, localEntry, remoteEntry, previousEntry);
    }
  }

  protectLargeAutoDeleteBatch(
    operations,
    confirmations,
    new Set([...local.keys(), ...remote.keys()]).size,
    maxAutoDeleteRatio
  );

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
  previous: PreviousEntry | undefined,
  syncSafetyMode: SyncSafetyMode
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

  if (shouldAutoPropagateDelete(syncSafetyMode)) {
    operations.push({
      kind: "delete-local",
      path: local.path,
      reason: "remote-deleted",
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
  previous: PreviousEntry | undefined,
  syncSafetyMode: SyncSafetyMode
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

  if (shouldAutoPropagateDelete(syncSafetyMode)) {
    operations.push({
      kind: "delete-remote",
      path: remote.path,
      reason: "local-deleted",
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

function protectLargeAutoDeleteBatch(
  operations: SyncOperation[],
  confirmations: SyncConfirmation[],
  currentPathCount: number,
  maxAutoDeleteRatio: number
): void {
  const deleteOperations = operations.filter(
    (operation) => operation.kind === "delete-local" || operation.kind === "delete-remote"
  );
  if (deleteOperations.length === 0 || currentPathCount === 0) {
    return;
  }
  const deleteRatio = deleteOperations.length / currentPathCount;
  if (deleteRatio <= maxAutoDeleteRatio) {
    return;
  }

  for (let index = operations.length - 1; index >= 0; index -= 1) {
    const operation = operations[index];
    const confirmation = confirmationFromDeleteOperation(operation);
    if (!confirmation) {
      continue;
    }
    operations.splice(index, 1);
    confirmations.push(confirmation);
  }
}

function confirmationFromDeleteOperation(operation: SyncOperation): SyncConfirmation | null {
  if (operation.kind === "delete-local" && operation.local) {
    return {
      path: operation.path,
      reason: "remote-deleted",
      conflictType: "delete-vs-modify",
      local: operation.local,
      previous: operation.previous
    };
  }

  if (operation.kind === "delete-remote" && operation.remote) {
    return {
      path: operation.path,
      reason: "local-deleted",
      conflictType: "delete-vs-modify",
      remote: operation.remote,
      previous: operation.previous
    };
  }

  return null;
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
