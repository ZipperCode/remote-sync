import { describe, expect, test } from "vitest";
import { SyncEngine, SyncLocalStore, SyncRemoteStore } from "../src/sync-engine";
import { FileEntry, PreviousEntry } from "../src/sync-planner";
import { SyncStateStore, SyncStateStoreAdapter } from "../src/sync-state-store";

class MemoryAdapter implements SyncStateStoreAdapter {
  value: string | null;

  constructor(value: string | null = null) {
    this.value = value;
  }

  async read(): Promise<string | null> {
    return this.value;
  }

  async write(value: string): Promise<void> {
    this.value = value;
  }
}

class FakeStore implements SyncLocalStore, SyncRemoteStore {
  readonly deleted: string[] = [];
  readonly written: string[] = [];
  failWritesUnder: string | null = null;
  failDeletes: string | null = null;
  private readonly files = new Map<string, { entry: FileEntry; content: ArrayBuffer }>();

  constructor(entries: FileEntry[], contents: Record<string, string> = {}) {
    for (const entry of entries) {
      this.files.set(entry.path, {
        entry,
        content: new TextEncoder().encode(contents[entry.path] ?? entry.path).buffer
      });
    }
  }

  async snapshot(): Promise<FileEntry[]> {
    return [...this.files.values()].map((item) => ({ ...item.entry }));
  }

  async readFile(path: string): Promise<ArrayBuffer> {
    const file = this.files.get(path);
    if (!file) {
      throw new Error(`Missing file: ${path}`);
    }
    return file.content.slice(0);
  }

  async writeFile(path: string, content: ArrayBuffer, source?: FileEntry): Promise<void> {
    if (this.failWritesUnder && path.startsWith(this.failWritesUnder)) {
      throw new Error(`Blocked write: ${path}`);
    }
    this.written.push(path);
    this.files.set(path, {
      entry: source ? { ...source, path } : { path, type: "file", size: content.byteLength, mtime: 1 },
      content: content.slice(0)
    });
  }

  async deleteFile(path: string): Promise<void> {
    if (this.failDeletes === path) {
      throw new Error(`Blocked delete: ${path}`);
    }
    this.deleted.push(path);
    this.files.delete(path);
  }

  readText(path: string): string {
    const file = this.files.get(path);
    if (!file) {
      throw new Error(`Missing file: ${path}`);
    }
    return new TextDecoder().decode(new Uint8Array(file.content));
  }
}

const file = (path: string, mtime: number, size = 10): FileEntry => ({
  path,
  type: "file",
  mtime,
  size
});

const previous = (entry: FileEntry, baseContent?: string): PreviousEntry => ({
  path: entry.path,
  local: entry,
  remote: entry,
  mergeBase: baseContent
    ? {
        source: "previous-sync-state",
        content: baseContent
      }
    : undefined
});

describe("SyncEngine", () => {
  test("executes safe operations but requires confirmation for deletion", async () => {
    const oldDeleted = file("deleted.md", 100);
    const adapter = new MemoryAdapter(
      JSON.stringify({ version: 1, lastSyncTime: 123, previousEntries: [previous(oldDeleted)] })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([file("local.md", 200)]);
    const remote = new FakeStore([file("remote.md", 200), oldDeleted]);
    const engine = new SyncEngine(local, remote, stateStore, { ignorePatterns: [] });

    const result = await engine.syncOnce();

    expect(result.summary).toEqual(
      expect.objectContaining({
        uploaded: 1,
        downloaded: 1,
        deletedRemote: 0,
        backedUp: 0,
        failures: 0,
        conflicts: 1
      })
    );
    expect(remote.written).toContain("local.md");
    expect(local.written).toEqual(["remote.md"]);
    expect(remote.deleted).toEqual([]);
    expect(adapter.value).not.toContain("local.md");
  });

  test("executes approved delete confirmation and saves successful state", async () => {
    const oldDeleted = file("deleted.md", 100);
    const adapter = new MemoryAdapter(
      JSON.stringify({ version: 1, lastSyncTime: 123, previousEntries: [previous(oldDeleted)] })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([]);
    const remote = new FakeStore([oldDeleted]);
    const engine = new SyncEngine(local, remote, stateStore, { ignorePatterns: [] });

    const result = await engine.syncOnce([{ path: "deleted.md", action: "accept-delete" }]);

    expect(result.summary.pendingConfirmations).toBe(0);
    expect(result.summary.deletedRemote).toBe(1);
    expect(result.summary.backedUp).toBe(1);
    expect(local.written.some((path) => path.startsWith(".remote-sync-trash/") && path.includes("/remote/"))).toBe(true);
    expect(remote.written.some((path) => path.startsWith(".remote-sync-trash/"))).toBe(false);
    expect(remote.deleted).toEqual(["deleted.md"]);
    expect(adapter.value).not.toContain("deleted.md");
  });

  test("auto-propagates simple deletes in balanced mode", async () => {
    const oldDeleted = file("deleted.md", 100);
    const adapter = new MemoryAdapter(
      JSON.stringify({ version: 1, lastSyncTime: 123, previousEntries: [previous(oldDeleted)] })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([]);
    const remote = new FakeStore([oldDeleted]);
    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      syncSafetyMode: "balanced",
      maxAutoDeleteRatio: 1
    });

    const result = await engine.syncOnce();

    expect(result.summary.pendingConfirmations).toBe(0);
    expect(result.summary.deletedRemote).toBe(1);
    expect(result.summary.backedUp).toBe(1);
    expect(local.written.some((path) => path.startsWith(".remote-sync-trash/") && path.includes("/remote/"))).toBe(true);
    expect(remote.deleted).toEqual(["deleted.md"]);
    expect(adapter.value).not.toContain("deleted.md");
  });

  test("records delete-remote failure details after preserving a local backup", async () => {
    const oldDeleted = file("deleted.md", 100);
    const adapter = new MemoryAdapter(
      JSON.stringify({ version: 1, lastSyncTime: 123, previousEntries: [previous(oldDeleted)] })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([]);
    const remote = new FakeStore([oldDeleted]);
    const before = adapter.value;
    remote.failDeletes = "deleted.md";
    const engine = new SyncEngine(local, remote, stateStore, { ignorePatterns: [] });

    const result = await engine.syncOnce([{ path: "deleted.md", action: "accept-delete" }]);

    expect(result.summary.backedUp).toBe(0);
    expect(result.summary.failures).toBe(1);
    expect(result.summary.failureDetails).toEqual([
      expect.objectContaining({
        path: "deleted.md",
        stage: "delete-remote",
        message: "Blocked delete: deleted.md"
      })
    ]);
    expect(local.written.some((path) => path.startsWith(".remote-sync-trash/") && path.includes("/remote/deleted.md"))).toBe(true);
    expect(remote.deleted).toEqual([]);
    expect(adapter.value).toBe(before);
  });

  test("requires a first sync choice before writing without a baseline", async () => {
    const adapter = new MemoryAdapter(null);
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([file("local.md", 200)]);
    const remote = new FakeStore([file("remote.md", 200)]);
    const engine = new SyncEngine(local, remote, stateStore, { ignorePatterns: [] });

    const result = await engine.syncOnce();

    expect(result.plan.initialSyncRequired).toBe(true);
    expect(result.summary.initialSyncRequired).toBe(true);
    expect(result.summary.uploaded).toBe(0);
    expect(result.summary.downloaded).toBe(0);
    expect(remote.written).toEqual([]);
    expect(local.written).toEqual([]);
    expect(adapter.value).toBe(null);
  });

  test("uses an explicit local-first choice for first sync", async () => {
    const adapter = new MemoryAdapter(null);
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([file("shared.md", 300), file("local.md", 200)]);
    const remote = new FakeStore([file("shared.md", 100), file("remote.md", 200)]);
    const engine = new SyncEngine(local, remote, stateStore, { ignorePatterns: [] });

    const result = await engine.syncOnce([], { initialSyncMode: "use-local" });

    expect(result.summary.initialSyncRequired).toBe(false);
    expect(result.summary.uploaded).toBe(2);
    expect(result.summary.deletedRemote).toBe(1);
    expect(remote.written).toContain("shared.md");
    expect(remote.written).toContain("local.md");
    expect(local.written.some((path) => path.startsWith(".remote-sync-trash/") && path.includes("/remote/remote.md"))).toBe(true);
    expect(remote.written.some((path) => path.startsWith(".remote-sync-trash/"))).toBe(false);
    expect(remote.deleted).toEqual(["remote.md"]);
    expect(adapter.value).toContain("local.md");
    expect(adapter.value).not.toContain("remote.md");
  });

  test("executes safe operations but keeps state unchanged when manual confirmations are pending", async () => {
    const old = file("note.md", 100, 10);
    const localOnly = file("local.md", 200);
    const adapter = new MemoryAdapter(
      JSON.stringify({ version: 1, lastSyncTime: 123, previousEntries: [previous(old)] })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([file("note.md", 200, 11), localOnly]);
    const remote = new FakeStore([file("note.md", 200, 12)]);
    const before = adapter.value;
    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      syncSafetyMode: "manual"
    });

    const result = await engine.syncOnce();

    expect(result.summary.pendingConfirmations).toBe(1);
    expect(result.summary.uploaded).toBe(1);
    expect(result.summary.downloaded).toBe(0);
    expect(remote.written).toContain("local.md");
    expect(adapter.value).toBe(before);
  });

  test("backs up local file before overwriting it with a remote download", async () => {
    const old = file("note.md", 100, 10);
    const adapter = new MemoryAdapter(
      JSON.stringify({ version: 1, lastSyncTime: 123, previousEntries: [previous(old)] })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([old]);
    const remote = new FakeStore([file("note.md", 200, 10)]);
    const engine = new SyncEngine(local, remote, stateStore, { ignorePatterns: [] });

    const result = await engine.syncOnce();

    expect(result.summary.downloaded).toBe(1);
    expect(result.summary.backedUp).toBe(1);
    expect(local.written.some((path) => path.startsWith(".remote-sync-trash/"))).toBe(true);
    expect(local.written).toContain("note.md");
  });

  test("auto-merges non-overlapping text changes and writes backups for both sides", async () => {
    const old = file("note.md", 100, 20);
    const adapter = new MemoryAdapter(
      JSON.stringify({
        version: 1,
        lastSyncTime: 123,
        previousEntries: [previous(old, "alpha\nbeta\n")]
      })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([file("note.md", 300, 24)], { "note.md": "alpha local\nbeta\n" });
    const remote = new FakeStore([file("note.md", 200, 25)], { "note.md": "alpha\nbeta remote\n" });
    const engine = new SyncEngine(local, remote, stateStore, { ignorePatterns: [] });

    const result = await engine.syncOnce();

    expect(result.summary.pendingConfirmations).toBe(0);
    expect(result.summary.merged).toBe(1);
    expect(result.summary.backedUp).toBe(2);
    expect(local.written.some((path) => path.startsWith(".remote-sync-trash/") && path.includes("/local/"))).toBe(true);
    expect(local.written.some((path) => path.startsWith(".remote-sync-trash/") && path.includes("/remote/"))).toBe(true);
    expect(remote.written.some((path) => path.startsWith(".remote-sync-trash/"))).toBe(false);
    expect(local.readText("note.md")).toBe("alpha local\nbeta remote\n");
    expect(remote.readText("note.md")).toBe("alpha local\nbeta remote\n");
    expect(adapter.value).toContain("\"mergeBase\"");
    expect(adapter.value).toContain("alpha local\\nbeta remote\\n");
  });

  test("auto-uploads oversized text conflicts when local is newer", async () => {
    const old = file("big.md", 100, 10);
    const adapter = new MemoryAdapter(
      JSON.stringify({
        version: 1,
        lastSyncTime: 123,
        previousEntries: [previous(old, "base\n")]
      })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([file("big.md", 300, 70 * 1024)], { "big.md": "local large" });
    const remote = new FakeStore([file("big.md", 200, 70 * 1024)], { "big.md": "remote large" });
    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      nonMergeableConflictPolicy: "newer-wins"
    });

    const result = await engine.syncOnce();

    expect(result.summary.pendingConfirmations).toBe(0);
    expect(result.summary.uploaded).toBe(1);
    expect(result.summary.downloaded).toBe(0);
    expect(result.summary.backedUp).toBe(1);
    expect(remote.readText("big.md")).toBe("local large");
  });

  test("auto-downloads oversized text conflicts when remote is newer", async () => {
    const old = file("big.md", 100, 10);
    const adapter = new MemoryAdapter(
      JSON.stringify({
        version: 1,
        lastSyncTime: 123,
        previousEntries: [previous(old, "base\n")]
      })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([file("big.md", 200, 70 * 1024)], { "big.md": "local large" });
    const remote = new FakeStore([file("big.md", 300, 70 * 1024)], { "big.md": "remote large" });
    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      nonMergeableConflictPolicy: "newer-wins"
    });

    const result = await engine.syncOnce();

    expect(result.summary.pendingConfirmations).toBe(0);
    expect(result.summary.uploaded).toBe(0);
    expect(result.summary.downloaded).toBe(1);
    expect(result.summary.backedUp).toBe(1);
    expect(local.readText("big.md")).toBe("remote large");
  });

  test("auto-uploads binary conflicts with equal mtimes by preferring local", async () => {
    const old = file("image.png", 100, 10);
    const adapter = new MemoryAdapter(
      JSON.stringify({ version: 1, lastSyncTime: 123, previousEntries: [previous(old)] })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([file("image.png", 300, 12)], { "image.png": "local image" });
    const remote = new FakeStore([file("image.png", 300, 13)], { "image.png": "remote image" });
    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      nonMergeableConflictPolicy: "newer-wins"
    });

    const result = await engine.syncOnce();

    expect(result.summary.pendingConfirmations).toBe(0);
    expect(result.summary.uploaded).toBe(1);
    expect(result.summary.backedUp).toBe(1);
    expect(remote.readText("image.png")).toBe("local image");
  });

  test("keeps auto-merge candidates pending in manual mode", async () => {
    const old = file("note.md", 100, 20);
    const adapter = new MemoryAdapter(
      JSON.stringify({
        version: 1,
        lastSyncTime: 123,
        previousEntries: [previous(old, "alpha\nbeta\n")]
      })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([file("note.md", 300, 24)], { "note.md": "alpha local\nbeta\n" });
    const remote = new FakeStore([file("note.md", 200, 25)], { "note.md": "alpha\nbeta remote\n" });
    const before = adapter.value;
    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      syncSafetyMode: "manual"
    });

    const result = await engine.syncOnce();

    expect(result.summary.pendingConfirmations).toBe(1);
    expect(result.summary.merged).toBe(0);
    expect(result.plan.confirmations).toEqual([
      expect.objectContaining({ path: "note.md", conflictType: "text-auto-merge" })
    ]);
    expect(local.written).toEqual([]);
    expect(remote.written).toEqual([]);
    expect(adapter.value).toBe(before);
  });

  test("keeps non-mergeable conflicts pending in manual mode", async () => {
    const old = file("big.md", 100, 10);
    const adapter = new MemoryAdapter(
      JSON.stringify({
        version: 1,
        lastSyncTime: 123,
        previousEntries: [previous(old, "base\n")]
      })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([file("big.md", 300, 70 * 1024)], { "big.md": "local large" });
    const remote = new FakeStore([file("big.md", 200, 70 * 1024)], { "big.md": "remote large" });
    const before = adapter.value;
    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      syncSafetyMode: "manual",
      nonMergeableConflictPolicy: "newer-wins"
    });

    const result = await engine.syncOnce();

    expect(result.summary.pendingConfirmations).toBe(1);
    expect(result.summary.uploaded).toBe(0);
    expect(result.plan.confirmations).toEqual([
      expect.objectContaining({ path: "big.md", conflictType: "text-too-large" })
    ]);
    expect(remote.readText("big.md")).toBe("remote large");
    expect(adapter.value).toBe(before);
  });

  test("does not overwrite when backup fails", async () => {
    const old = file("note.md", 100, 10);
    const adapter = new MemoryAdapter(
      JSON.stringify({ version: 1, lastSyncTime: 123, previousEntries: [previous(old)] })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([old]);
    const remote = new FakeStore([file("note.md", 200, 10)]);
    local.failWritesUnder = ".remote-sync-trash/";
    const engine = new SyncEngine(local, remote, stateStore, { ignorePatterns: [] });

    const result = await engine.syncOnce();

    expect(result.summary.downloaded).toBe(0);
    expect(result.summary.backedUp).toBe(0);
    expect(result.summary.failures).toBe(1);
    expect(result.summary.failureDetails).toEqual([
      expect.objectContaining({
        path: "note.md",
        stage: "backup-local",
        message: expect.stringContaining("Blocked write: .remote-sync-trash/")
      })
    ]);
    expect(local.written).not.toContain("note.md");
  });

  test("keeps overlapping text edits pending for manual resolution", async () => {
    const old = file("note.md", 100, 12);
    const adapter = new MemoryAdapter(
      JSON.stringify({ version: 1, lastSyncTime: 123, previousEntries: [previous(old, "base\nsame\n")] })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([file("note.md", 300, 17)], { "note.md": "base\nlocal\n" });
    const remote = new FakeStore([file("note.md", 200, 18)], { "note.md": "base\nremote\n" });
    const before = adapter.value;
    const engine = new SyncEngine(local, remote, stateStore, { ignorePatterns: [] });

    const result = await engine.syncOnce();

    expect(result.summary.merged).toBe(0);
    expect(result.summary.failures).toBe(0);
    expect(result.summary.pendingConfirmations).toBe(1);
    expect(result.plan.confirmations).toEqual([
      expect.objectContaining({ path: "note.md", conflictType: "text-overlap" })
    ]);
    expect(local.written).not.toContain("note.md");
    expect(remote.written).not.toContain("note.md");
    expect(adapter.value).toBe(before);
  });

  test("does not update sync state when merge write steps fail", async () => {
    const old = file("note.md", 100, 20);
    const adapter = new MemoryAdapter(
      JSON.stringify({
        version: 1,
        lastSyncTime: 123,
        previousEntries: [previous(old, "alpha\nbeta\n")]
      })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([file("note.md", 300, 24)], { "note.md": "alpha local\nbeta\n" });
    const remote = new FakeStore([file("note.md", 200, 25)], { "note.md": "alpha\nbeta remote\n" });
    local.failWritesUnder = "note.md";
    const before = adapter.value;
    const engine = new SyncEngine(local, remote, stateStore, { ignorePatterns: [] });

    const result = await engine.syncOnce();

    expect(result.summary.merged).toBe(0);
    expect(result.summary.failures).toBe(1);
    expect(result.summary.failureDetails).toEqual([
      expect.objectContaining({
        path: "note.md",
        stage: "merge",
        message: "Blocked write: note.md"
      })
    ]);
    expect(adapter.value).toBe(before);
  });

  test("executes approved confirmation choices after recomputing the plan", async () => {
    const old = file("note.md", 100, 10);
    const adapter = new MemoryAdapter(
      JSON.stringify({ version: 1, lastSyncTime: 123, previousEntries: [previous(old)] })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([file("note.md", 300, 12)]);
    const remote = new FakeStore([file("note.md", 200, 12)]);
    const engine = new SyncEngine(local, remote, stateStore, { ignorePatterns: [] });

    const result = await engine.syncOnce([{ path: "note.md", action: "use-local" }]);

    expect(result.summary.pendingConfirmations).toBe(0);
    expect(result.summary.uploaded).toBe(1);
    expect(result.summary.backedUp).toBe(1);
    expect(local.written.some((path) => path.startsWith(".remote-sync-trash/") && path.includes("/remote/note.md"))).toBe(true);
    expect(remote.written.some((path) => path.startsWith(".remote-sync-trash/"))).toBe(false);
    expect(remote.written).toContain("note.md");
    expect(adapter.value).toContain("note.md");
  });
});
