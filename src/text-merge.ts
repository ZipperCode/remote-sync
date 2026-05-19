import { FileEntry } from "./sync-types";

const AUTO_MERGE_TEXT_EXTENSIONS = new Set([".md", ".txt", ".json"]);
export const MAX_MERGE_BASE_BYTES = 64 * 1024;

interface ChangeRange {
  start: number;
  end: number;
  replacement: string[];
}

interface MergeSuccess {
  ok: true;
  mergedContent: string;
}

interface MergeConflict {
  ok: false;
}

export function isAutoMergeTextEntry(entry: FileEntry): boolean {
  return entry.type === "file" && isAutoMergeTextPath(entry.path);
}

export function isAutoMergeTextPath(path: string): boolean {
  const normalized = path.toLowerCase();
  for (const extension of AUTO_MERGE_TEXT_EXTENSIONS) {
    if (normalized.endsWith(extension)) {
      return true;
    }
  }
  return false;
}

export function canStoreMergeBase(entry: FileEntry): boolean {
  return isAutoMergeTextEntry(entry) && entry.size <= MAX_MERGE_BASE_BYTES;
}

export function decodeTextContent(content: ArrayBuffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(content));
}

export function encodeTextContent(content: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(content);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function mergeTextContent(
  baseContent: string,
  localContent: string,
  remoteContent: string
): MergeSuccess | MergeConflict {
  if (localContent === remoteContent) {
    return { ok: true, mergedContent: localContent };
  }
  if (localContent === baseContent) {
    return { ok: true, mergedContent: remoteContent };
  }
  if (remoteContent === baseContent) {
    return { ok: true, mergedContent: localContent };
  }

  const baseLines = splitLines(baseContent);
  const localChanges = buildChangeRanges(baseLines, splitLines(localContent));
  const remoteChanges = buildChangeRanges(baseLines, splitLines(remoteContent));
  const merged: string[] = [];

  let baseIndex = 0;
  let localIndex = 0;
  let remoteIndex = 0;

  while (
    baseIndex < baseLines.length ||
    localIndex < localChanges.length ||
    remoteIndex < remoteChanges.length
  ) {
    const localChange = localChanges[localIndex];
    const remoteChange = remoteChanges[remoteIndex];
    const nextStart = Math.min(
      localChange?.start ?? Number.POSITIVE_INFINITY,
      remoteChange?.start ?? Number.POSITIVE_INFINITY,
      baseLines.length
    );

    if (baseIndex < nextStart) {
      merged.push(...baseLines.slice(baseIndex, nextStart));
      baseIndex = nextStart;
      continue;
    }

    if (localChange && remoteChange && localChange.start === baseIndex && remoteChange.start === baseIndex) {
      if (
        localChange.end === remoteChange.end &&
        arraysEqual(localChange.replacement, remoteChange.replacement)
      ) {
        merged.push(...localChange.replacement);
        baseIndex = localChange.end;
        localIndex += 1;
        remoteIndex += 1;
        continue;
      }

      return { ok: false };
    }

    if (localChange && localChange.start === baseIndex) {
      if (remoteChange && rangesOverlap(localChange, remoteChange)) {
        return { ok: false };
      }

      merged.push(...localChange.replacement);
      baseIndex = localChange.end;
      localIndex += 1;
      continue;
    }

    if (remoteChange && remoteChange.start === baseIndex) {
      if (localChange && rangesOverlap(remoteChange, localChange)) {
        return { ok: false };
      }

      merged.push(...remoteChange.replacement);
      baseIndex = remoteChange.end;
      remoteIndex += 1;
      continue;
    }

    if (baseIndex < baseLines.length) {
      merged.push(baseLines[baseIndex]);
      baseIndex += 1;
      continue;
    }

    return { ok: false };
  }

  return { ok: true, mergedContent: merged.join("") };
}

function splitLines(content: string): string[] {
  const matches = content.match(/[^\n]*\n|[^\n]+$/g);
  return matches ?? [];
}

function buildChangeRanges(baseLines: string[], nextLines: string[]): ChangeRange[] {
  const lcs = buildLcsTable(baseLines, nextLines);
  const operations: Array<{ type: "equal" | "insert" | "delete"; value?: string }> = [];

  let baseIndex = 0;
  let nextIndex = 0;

  while (baseIndex < baseLines.length || nextIndex < nextLines.length) {
    if (
      baseIndex < baseLines.length &&
      nextIndex < nextLines.length &&
      baseLines[baseIndex] === nextLines[nextIndex]
    ) {
      operations.push({ type: "equal", value: baseLines[baseIndex] });
      baseIndex += 1;
      nextIndex += 1;
      continue;
    }

    if (
      nextIndex < nextLines.length &&
      (baseIndex === baseLines.length || lcs[baseIndex][nextIndex + 1] >= lcs[baseIndex + 1][nextIndex])
    ) {
      operations.push({ type: "insert", value: nextLines[nextIndex] });
      nextIndex += 1;
      continue;
    }

    operations.push({ type: "delete", value: baseLines[baseIndex] });
    baseIndex += 1;
  }

  const changes: ChangeRange[] = [];
  let current: ChangeRange | null = null;
  baseIndex = 0;

  for (const operation of operations) {
    if (operation.type === "equal") {
      if (current) {
        changes.push(current);
        current = null;
      }
      baseIndex += 1;
      continue;
    }

    if (!current) {
      current = { start: baseIndex, end: baseIndex, replacement: [] };
    }

    if (operation.type === "delete") {
      current.end += 1;
      baseIndex += 1;
      continue;
    }

    current.replacement.push(operation.value ?? "");
  }

  if (current) {
    changes.push(current);
  }

  return changes;
}

function buildLcsTable(baseLines: string[], nextLines: string[]): number[][] {
  const table = Array.from({ length: baseLines.length + 1 }, () =>
    Array.from({ length: nextLines.length + 1 }, () => 0)
  );

  for (let i = baseLines.length - 1; i >= 0; i -= 1) {
    for (let j = nextLines.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        baseLines[i] === nextLines[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  return table;
}

function rangesOverlap(left: ChangeRange, right: ChangeRange): boolean {
  return left.start < right.end && right.start < left.end;
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}
