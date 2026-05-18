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
  private readonly files = new Map<string, { entry: FileEntry; content: ArrayBuffer }>();

  constructor(entries: FileEntry[]) {
    for (const entry of entries) {
      this.files.set(entry.path, {
        entry,
        content: new TextEncoder().encode(entry.path).buffer
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
      entry: source ? { ...source } : { path, type: "file", size: content.byteLength, mtime: 1 },
      content: content.slice(0)
    });
  }

  async deleteFile(path: string): Promise<void> {
    this.deleted.push(path);
    this.files.delete(path);
  }
}

const file = (path: string, mtime: number, size = 10): FileEntry => ({
  path,
  type: "file",
  mtime,
  size
});

const previous = (entry: FileEntry): PreviousEntry => ({
  path: entry.path,
  local: entry,
  remote: entry
});

describe("SyncEngine", () => {
  test("executes upload, download, and remote deletion then saves successful state", async () => {
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
        deletedRemote: 1,
        backedUp: 1,
        failures: 0,
        conflicts: 0
      })
    );
    expect(remote.written).toContain("local.md");
    expect(remote.written.some((path) => path.startsWith(".remote-sync-trash/"))).toBe(true);
    expect(local.written).toEqual(["remote.md"]);
    expect(remote.deleted).toEqual(["deleted.md"]);
    expect(adapter.value).toContain("local.md");
    expect(adapter.value).toContain("remote.md");
  });

  test("executes safe operations but keeps state unchanged when confirmations are pending", async () => {
    const old = file("note.md", 100, 10);
    const localOnly = file("local.md", 200);
    const adapter = new MemoryAdapter(
      JSON.stringify({ version: 1, lastSyncTime: 123, previousEntries: [previous(old)] })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([file("note.md", 200, 11), localOnly]);
    const remote = new FakeStore([file("note.md", 200, 12)]);
    const before = adapter.value;
    const engine = new SyncEngine(local, remote, stateStore, { ignorePatterns: [] });

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
    expect(local.written).not.toContain("note.md");
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
    expect(remote.written).toContain("note.md");
    expect(adapter.value).toContain("note.md");
  });
});
