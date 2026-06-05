import { describe, expect, test } from "vitest";
import { SyncEngine, SyncLocalStore, SyncRemoteStore } from "../src/sync-engine";
import { FileEntry, PreviousEntry } from "../src/sync-planner";
import { SyncStateStore, SyncStateStoreAdapter } from "../src/sync-state-store";
import { encodeTextContent } from "../src/text-merge";

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
  test("executes operations but requires confirmation for deletion in manual mode", async () => {
    const oldDeleted = file("deleted.md", 100);
    const adapter = new MemoryAdapter(
      JSON.stringify({ version: 1, lastSyncTime: 123, previousEntries: [previous(oldDeleted)] })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([file("local.md", 200)]);
    const remote = new FakeStore([file("remote.md", 200), oldDeleted]);
    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      syncSafetyMode: "manual"
    });

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
    // 已成功的 local.md/remote.md 推进基线；待确认的 deleted.md 保留旧基线。
    const saved = stateStore.getPreviousEntries();
    expect(saved.find((e) => e.path === "local.md")).toBeTruthy();
    expect(saved.find((e) => e.path === "remote.md")).toBeTruthy();
    const deleted = saved.find((e) => e.path === "deleted.md");
    expect(deleted?.local?.mtime).toBe(100);
    expect(deleted?.remote?.mtime).toBe(100);
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

  test("auto-propagates simple deletes in auto mode", async () => {
    const oldDeleted = file("deleted.md", 100);
    const adapter = new MemoryAdapter(
      JSON.stringify({ version: 1, lastSyncTime: 123, previousEntries: [previous(oldDeleted)] })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([]);
    const remote = new FakeStore([oldDeleted]);
    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      syncSafetyMode: "auto",
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
    // 删除失败 -> deleted.md 旧基线必须保留（mtime 100），不能丢，否则冲突消失。
    const saved = stateStore.getPreviousEntries();
    const deleted = saved.find((e) => e.path === "deleted.md");
    expect(deleted?.local?.mtime).toBe(100);
    expect(deleted?.remote?.mtime).toBe(100);
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

  test("persists resolved operations but preserves baseline for pending confirmations", async () => {
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
    // 语义变更：不再"完全不变"。已成功的 local.md upload 推进了基线，
    // 而待确认的 note.md 保留旧基线（mtime 100），不被当前快照覆盖。
    expect(adapter.value).not.toBe(before);
    expect(adapter.value).toContain("local.md");
    const saved = stateStore.getPreviousEntries();
    expect(saved.find((e) => e.path === "local.md")).toBeTruthy();
    const note = saved.find((e) => e.path === "note.md");
    expect(note?.local?.mtime).toBe(100);
    expect(note?.remote?.mtime).toBe(100);
  });

  test("persists baseline for resolved operations even when a confirmation stays pending", async () => {
    const old = file("note.md", 100, 10);
    const localOnly = file("local.md", 200);
    const adapter = new MemoryAdapter(
      JSON.stringify({ version: 1, lastSyncTime: 123, previousEntries: [previous(old)] })
    );
    const stateStore = new SyncStateStore(adapter);
    // note.md changed on both sides -> pending confirmation in manual mode.
    // local.md is local-only -> auto-executed upload (a resolved operation).
    const local = new FakeStore([file("note.md", 200, 11), localOnly]);
    const remote = new FakeStore([file("note.md", 200, 12)]);
    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      syncSafetyMode: "manual"
    });

    const result = await engine.syncOnce();

    expect(result.summary.pendingConfirmations).toBe(1);

    // 关键：已成功的操作路径必须落盘（基线推进），否则下次重复执行。
    const saved = stateStore.getPreviousEntries();
    expect(saved.find((e) => e.path === "local.md")).toBeTruthy();
    // note.md 是待确认冲突，其旧基线必须保留（mtime 100），不能被当前快照覆盖。
    const note = saved.find((e) => e.path === "note.md");
    expect(note?.local?.mtime).toBe(100);
    expect(note?.remote?.mtime).toBe(100);
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
    // 待确认的 note.md 保留旧基线（含 mergeBase），不被当前快照覆盖。
    const saved = stateStore.getPreviousEntries();
    const note = saved.find((e) => e.path === "note.md");
    expect(note?.local?.mtime).toBe(100);
    expect(note?.remote?.mtime).toBe(100);
    expect(note?.mergeBase?.content).toBe("alpha\nbeta\n");
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
    // 待确认的 big.md 保留旧基线（含 mergeBase），不被当前快照覆盖。
    const saved = stateStore.getPreviousEntries();
    const big = saved.find((e) => e.path === "big.md");
    expect(big?.local?.mtime).toBe(100);
    expect(big?.remote?.mtime).toBe(100);
    expect(big?.mergeBase?.content).toBe("base\n");
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

  test("resolves overlapping text edits by saving a conflict copy and advancing state", async () => {
    const old = file("note.md", 100, 12);
    const adapter = new MemoryAdapter(
      JSON.stringify({ version: 1, lastSyncTime: 123, previousEntries: [previous(old, "base\nsame\n")] })
    );
    const stateStore = new SyncStateStore(adapter);
    const local = new FakeStore([file("note.md", 300, 17)], { "note.md": "base\nlocal\n" });
    const remote = new FakeStore([file("note.md", 200, 18)], { "note.md": "base\nremote\n" });
    const before = adapter.value;
    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      deviceId: "tester"
    });

    const result = await engine.syncOnce();

    // 重叠冲突不再死循环：无未决确认、无失败
    expect(result.summary.pendingConfirmations).toBe(0);
    expect(result.summary.failures).toBe(0);
    // 本地权威版本被上传覆盖远端
    expect(remote.written).toContain("note.md");
    // 生成了一个冲突副本（落在本地）
    expect(local.written.some((path) => path.includes(".conflict-tester-"))).toBe(true);
    // state 正常推进（不再卡住）
    expect(adapter.value).not.toBe(before);
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
    // merge 写失败 -> note.md 旧基线（含 mergeBase）必须保留，不能推进，否则丢冲突。
    const saved = stateStore.getPreviousEntries();
    const note = saved.find((e) => e.path === "note.md");
    expect(note?.local?.mtime).toBe(100);
    expect(note?.remote?.mtime).toBe(100);
    expect(note?.mergeBase?.content).toBe("alpha\nbeta\n");
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

  test("rename moves remote file and skips delete/upload in safe mode", async () => {
    const local = new FakeStore([file("new.md", 200)], { "new.md": "hello" });
    const remote = new FakeStore([file("old.md", 100)], { "old.md": "hello" });

    const stateStore = new SyncStateStore(
      new MemoryAdapter(
        JSON.stringify({
          version: 1,
          lastSyncTime: 50,
          previousEntries: [previous(file("old.md", 100))]
        })
      )
    );

    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      syncSafetyMode: "auto"
    });

    const result = await engine.syncOnce([], {
      renames: [{ from: "old.md", to: "new.md" }]
    });

    expect(remote.written).toContain("new.md");
    expect(remote.deleted).toContain("old.md");
    expect(result.summary.pendingConfirmations).toBe(0);
    const remotePaths = (await remote.snapshot()).map((e) => e.path).sort();
    expect(remotePaths).toEqual(["new.md"]);
  });

  test("rename falls back to normal plan when remote lacks the source", async () => {
    const local = new FakeStore([file("renamed.md", 200)], { "renamed.md": "data" });
    const remote = new FakeStore([], {});

    const stateStore = new SyncStateStore(
      new MemoryAdapter(
        JSON.stringify({ version: 1, lastSyncTime: 50, previousEntries: [] })
      )
    );

    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      syncSafetyMode: "auto"
    });

    const result = await engine.syncOnce([], {
      renames: [{ from: "fresh.md", to: "renamed.md" }]
    });

    expect(remote.deleted).not.toContain("fresh.md");
    expect(remote.written).toContain("renamed.md");
    expect(result.summary.pendingConfirmations).toBe(0);
  });

  test("rename keeps data and records failure when writing the remote target fails", async () => {
    const local = new FakeStore([file("new.md", 200)], { "new.md": "hello" });
    const remote = new FakeStore([file("old.md", 100)], { "old.md": "hello" });
    // 写远端新路径失败（new.md 触发），但 trash 备份写入本地不受影响。
    remote.failWritesUnder = "new.md";

    const adapter = new MemoryAdapter(
      JSON.stringify({
        version: 1,
        lastSyncTime: 50,
        previousEntries: [previous(file("old.md", 100))]
      })
    );
    const stateStore = new SyncStateStore(adapter);
    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      syncSafetyMode: "auto"
    });

    const result = await engine.syncOnce([], {
      renames: [{ from: "old.md", to: "new.md" }]
    });

    // 写远端新路径失败：搬迁未发生，旧文件未被删，新路径未 handled。
    expect(remote.deleted).not.toContain("old.md");
    expect(result.summary.failures).toBeGreaterThan(0);
    // 至少有一个 new.md 的 upload 失败被记录。
    // 注：搬迁失败后 new.md 未被 handled，仍以 local-only upload 留在计划中并被重试，
    // 因远端写仍被阻塞而再次失败——这恰好证明数据未丢（new.md 仍待同步）。
    expect(result.summary.failureDetails).toContainEqual(
      expect.objectContaining({ path: "new.md", stage: "upload" })
    );
    expect(
      result.summary.failureDetails.every(
        (d) => d.path === "new.md" && d.stage === "upload"
      )
    ).toBe(true);
    // 远端旧文件仍在，未做任何远端备份（trash 永不写远端）。
    const remotePaths = (await remote.snapshot()).map((e) => e.path).sort();
    expect(remotePaths).toEqual(["old.md"]);
    expect(remote.written.some((p) => p.startsWith(".remote-sync-trash/"))).toBe(false);
    // 写失败发生在备份之前，没有 trash 备份产生。
    expect(local.written.some((p) => p.startsWith(".remote-sync-trash/"))).toBe(false);
    expect(result.summary.backedUp).toBe(0);
    // new.md 上传失败（无旧基线）-> 被丢弃，不会被误记为已同步；
    // old.md 仍待确认（远端尚存、本地无）-> 旧基线（mtime 100）保留，数据不丢。
    expect(adapter.value).not.toContain("new.md");
    const saved = stateStore.getPreviousEntries();
    expect(saved.find((e) => e.path === "new.md")).toBeFalsy();
    const oldEntry = saved.find((e) => e.path === "old.md");
    expect(oldEntry?.local?.mtime).toBe(100);
    expect(oldEntry?.remote?.mtime).toBe(100);
  });

  test("rename backs up the remote source and keeps data when deleting it fails", async () => {
    const local = new FakeStore([file("new.md", 200)], { "new.md": "renamed body" });
    const remote = new FakeStore([file("old.md", 100)], { "old.md": "old body" });
    // 删除远端旧文件失败（备份会先成功，删除步骤报错）。
    remote.failDeletes = "old.md";

    const stateStore = new SyncStateStore(
      new MemoryAdapter(
        JSON.stringify({
          version: 1,
          lastSyncTime: 50,
          previousEntries: [previous(file("old.md", 100))]
        })
      )
    );
    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      syncSafetyMode: "auto"
    });

    const result = await engine.syncOnce([], {
      renames: [{ from: "old.md", to: "new.md" }]
    });

    // 新路径已写入远端，旧文件因删除失败仍在远端。
    expect(remote.written).toContain("new.md");
    expect(remote.deleted).not.toContain("old.md");
    const remotePaths = (await remote.snapshot()).map((e) => e.path).sort();
    expect(remotePaths).toEqual(["new.md", "old.md"]);
    // 删除失败被记入 failures（stage=delete-remote），from/to 未 handled，故计划未剔除。
    expect(result.summary.failures).toBeGreaterThan(0);
    expect(result.summary.failureDetails).toEqual([
      expect.objectContaining({ path: "old.md", stage: "delete-remote" })
    ]);
    // 删除前的远端备份已成功落入本地 trash（contract: 删远端前先落 trash）。
    expect(
      local.written.some(
        (p) => p.startsWith(".remote-sync-trash/") && p.includes("/remote/old.md")
      )
    ).toBe(true);
    expect(result.summary.backedUp).toBe(1);
  });

  test("rename skips when from equals to without touching the remote", async () => {
    const local = new FakeStore([file("same.md", 200)], { "same.md": "body" });
    const remote = new FakeStore([file("same.md", 200)], { "same.md": "body" });

    const stateStore = new SyncStateStore(
      new MemoryAdapter(
        JSON.stringify({
          version: 1,
          lastSyncTime: 50,
          previousEntries: [previous(file("same.md", 200))]
        })
      )
    );
    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      syncSafetyMode: "auto"
    });

    const result = await engine.syncOnce([], {
      renames: [{ from: "same.md", to: "same.md" }]
    });

    // from === to：搬迁被跳过，无任何远端写/删，无失败、无未决确认。
    expect(remote.deleted).toEqual([]);
    expect(remote.written.some((p) => p.startsWith(".remote-sync-trash/"))).toBe(false);
    expect(result.summary.failures).toBe(0);
    expect(result.summary.pendingConfirmations).toBe(0);
    expect(result.summary.backedUp).toBe(0);
  });

  test("rename moves multiple independent files", async () => {
    const local = new FakeStore([file("x.md", 200), file("y.md", 200)], {
      "x.md": "x body",
      "y.md": "y body"
    });
    const remote = new FakeStore([file("a.md", 100), file("b.md", 100)], {
      "a.md": "x body",
      "b.md": "y body"
    });

    const stateStore = new SyncStateStore(
      new MemoryAdapter(
        JSON.stringify({
          version: 1,
          lastSyncTime: 50,
          previousEntries: [previous(file("a.md", 100)), previous(file("b.md", 100))]
        })
      )
    );
    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      syncSafetyMode: "auto"
    });

    const result = await engine.syncOnce([], {
      renames: [
        { from: "a.md", to: "x.md" },
        { from: "b.md", to: "y.md" }
      ]
    });

    // 两个独立 rename 都被搬迁：旧文件删除、新文件写入远端。
    expect(remote.deleted).toContain("a.md");
    expect(remote.deleted).toContain("b.md");
    expect(remote.written).toContain("x.md");
    expect(remote.written).toContain("y.md");
    const remotePaths = (await remote.snapshot()).map((e) => e.path).sort();
    expect(remotePaths).toEqual(["x.md", "y.md"]);
    // 都不进 pending、两次远端备份。
    expect(result.summary.pendingConfirmations).toBe(0);
    expect(result.summary.backedUp).toBe(2);
  });
});

function entry(path: string, content: string, mtime: number): FileEntry {
  return { path, type: "file", size: encodeTextContent(content).byteLength, mtime };
}

class MemoryStore implements SyncLocalStore, SyncRemoteStore {
  files = new Map<string, { content: string; mtime: number }>();

  constructor(initial: Record<string, { content: string; mtime: number }> = {}) {
    for (const [path, value] of Object.entries(initial)) {
      this.files.set(path, value);
    }
  }

  async snapshot(): Promise<FileEntry[]> {
    return [...this.files.entries()].map(([path, v]) => entry(path, v.content, v.mtime));
  }
  async readFile(path: string): Promise<ArrayBuffer> {
    const v = this.files.get(path);
    if (!v) throw new Error(`missing ${path}`);
    return encodeTextContent(v.content);
  }
  async writeFile(path: string, content: ArrayBuffer): Promise<void> {
    this.files.set(path, {
      content: new TextDecoder().decode(new Uint8Array(content)),
      mtime: 1
    });
  }
  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }
}

class MemoryStateAdapter implements SyncStateStoreAdapter {
  value: string | null;
  constructor(value: string | null) {
    this.value = value;
  }
  async read(): Promise<string | null> {
    return this.value;
  }
  async write(value: string): Promise<void> {
    this.value = value;
  }
}

describe("SyncEngine text-overlap conflict resolution", () => {
  test("on unmergeable text conflict: saves remote as conflict copy, keeps local, advances state", async () => {
    const base = "line1\nline2\n";
    const localContent = "line1\nLOCAL\n";
    const remoteContent = "line1\nREMOTE\n";

    const previousState = JSON.stringify({
      version: 1,
      lastSyncTime: 1000,
      previousEntries: [
        {
          path: "note.md",
          local: entry("note.md", base, 1000),
          remote: entry("note.md", base, 1000),
          mergeBase: { source: "previous-sync-state", content: base }
        }
      ]
    });

    const local = new MemoryStore({ "note.md": { content: localContent, mtime: 2000 } });
    const remote = new MemoryStore({ "note.md": { content: remoteContent, mtime: 3000 } });
    const stateStore = new SyncStateStore(new MemoryStateAdapter(previousState));

    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      syncSafetyMode: "auto",
      deviceId: "laptop"
    });

    const result = await engine.syncOnce([]);

    expect(result.summary.pendingConfirmations).toBe(0);
    expect(result.summary.failures).toBe(0);

    expect(local.files.get("note.md")?.content).toBe(localContent);

    const conflictKeys = [...local.files.keys()].filter((k) => k.includes(".conflict-laptop-"));
    expect(conflictKeys).toHaveLength(1);
    expect(local.files.get(conflictKeys[0])?.content).toBe(remoteContent);

    expect(remote.files.get("note.md")?.content).toBe(localContent);

    // 副本也写到了远端（防止下次同步被当 local-only 删除，并让对端用户看到冲突）
    const remoteConflictKeys = [...remote.files.keys()].filter((k) => k.includes(".conflict-laptop-"));
    expect(remoteConflictKeys).toHaveLength(1);
    expect(remote.files.get(remoteConflictKeys[0])?.content).toBe(remoteContent);
  });

  test("conflict copy survives a second sync cycle (not deleted as local-only)", async () => {
    const base = "line1\nline2\n";
    const localContent = "line1\nLOCAL\n";
    const remoteContent = "line1\nREMOTE\n";

    const previousState = JSON.stringify({
      version: 1,
      lastSyncTime: 1000,
      previousEntries: [
        {
          path: "note.md",
          local: entry("note.md", base, 1000),
          remote: entry("note.md", base, 1000),
          mergeBase: { source: "previous-sync-state", content: base }
        }
      ]
    });

    const local = new MemoryStore({ "note.md": { content: localContent, mtime: 2000 } });
    const remote = new MemoryStore({ "note.md": { content: remoteContent, mtime: 3000 } });
    const stateStore = new SyncStateStore(new MemoryStateAdapter(previousState));
    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      syncSafetyMode: "auto",
      deviceId: "laptop"
    });

    // 第一次同步：收尾冲突，生成副本（两端）
    await engine.syncOnce([]);
    const conflictKeysAfterFirst = [...local.files.keys()].filter((k) => k.includes(".conflict-laptop-"));
    expect(conflictKeysAfterFirst).toHaveLength(1);
    const conflictPath = conflictKeysAfterFirst[0];

    // 第二次同步：副本两端一致、previous 齐全，不应被删除
    const second = await engine.syncOnce([]);
    expect(second.summary.deletedLocal).toBe(0);
    expect(second.summary.deletedRemote).toBe(0);
    expect(local.files.has(conflictPath)).toBe(true);
    expect(remote.files.has(conflictPath)).toBe(true);
  });
});
