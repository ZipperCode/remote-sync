import { describe, expect, test } from "vitest";
import { FileEntry } from "../src/sync-planner";
import { SyncStateStore, SyncStateStoreAdapter } from "../src/sync-state-store";

class MemoryAdapter implements SyncStateStoreAdapter {
  private value: string | null = null;

  async read(): Promise<string | null> {
    return this.value;
  }

  async write(value: string): Promise<void> {
    this.value = value;
  }
}

const entry = (path: string, mtime: number, size = 1): FileEntry => ({
  path,
  type: "file",
  size,
  mtime
});

describe("SyncStateStore", () => {
  test("updates state only when explicitly saved after a successful sync", async () => {
    const adapter = new MemoryAdapter();
    const store = new SyncStateStore(adapter);

    await store.load();
    expect(store.getPreviousEntries()).toEqual([]);

    await store.saveSuccessfulSync(
      [entry("a.md", 100, 10)],
      [entry("a.md", 110, 10)],
      async () => "merged body"
    );

    const reloaded = new SyncStateStore(adapter);
    await reloaded.load();

    expect(reloaded.getPreviousEntries()).toEqual([
      expect.objectContaining({
        path: "a.md",
        mergeBase: {
          source: "previous-sync-state",
          content: "merged body"
        }
      })
    ]);
    expect(reloaded.getLastSyncTime()).toBeGreaterThan(0);
  });

  test("does not store merge bases for oversized text files", async () => {
    const adapter = new MemoryAdapter();
    const store = new SyncStateStore(adapter);

    await store.saveSuccessfulSync(
      [entry("large.md", 100, 70000)],
      [entry("large.md", 100, 70000)],
      async () => "should not be used"
    );

    const reloaded = new SyncStateStore(adapter);
    await reloaded.load();

    expect(reloaded.getPreviousEntries()).toEqual([
      expect.objectContaining({
        path: "large.md",
        mergeBase: undefined
      })
    ]);
  });

  test("loads legacy array state for forward compatibility", async () => {
    const adapter = new MemoryAdapter();
    await adapter.write(
      JSON.stringify([
        {
          path: "legacy.md",
          local: entry("legacy.md", 100),
          remote: entry("legacy.md", 100)
        }
      ])
    );

    const store = new SyncStateStore(adapter);
    await store.load();

    expect(store.getPreviousEntries()).toEqual([
      expect.objectContaining({ path: "legacy.md" })
    ]);
  });

  test("preserves the previous baseline for unresolved paths and advances resolved ones", async () => {
    const adapter = new MemoryAdapter();
    const store = new SyncStateStore(adapter);

    // First sync: both a.md and b.md are clean and fully recorded.
    await store.saveSuccessfulSync(
      [entry("a.md", 100, 10), entry("b.md", 100, 20)],
      [entry("a.md", 100, 10), entry("b.md", 100, 20)],
      async () => "base"
    );

    // Second sync: a.md was resolved (advanced to mtime 200), but b.md is an
    // unresolved conflict this round. The snapshots reflect the *current* disk
    // state (b.md changed to 300), but because b.md is unresolved its baseline
    // MUST stay at the previous value (mtime 100) so the conflict is still
    // detected next time.
    await store.saveSuccessfulSync(
      [entry("a.md", 200, 11), entry("b.md", 300, 21)],
      [entry("a.md", 200, 11), entry("b.md", 100, 20)],
      async () => "base2",
      new Set(["b.md"])
    );

    const reloaded = new SyncStateStore(adapter);
    await reloaded.load();
    const entries = reloaded.getPreviousEntries();

    const a = entries.find((e) => e.path === "a.md");
    const b = entries.find((e) => e.path === "b.md");

    // a.md advanced to the new snapshot.
    expect(a?.local?.mtime).toBe(200);
    // b.md kept the OLD baseline (mtime 100 on both sides), not the new disk state.
    expect(b?.local?.mtime).toBe(100);
    expect(b?.remote?.mtime).toBe(100);
  });

  test("drops a first-seen unresolved path that has no previous baseline", async () => {
    const adapter = new MemoryAdapter();
    const store = new SyncStateStore(adapter);

    // c.md appears for the first time and is immediately unresolved (e.g. both
    // sides created it with different content). It has no previous baseline, so
    // it must NOT be written — otherwise next time it would look already-synced.
    await store.saveSuccessfulSync(
      [entry("c.md", 100, 10)],
      [entry("c.md", 100, 99)],
      async () => "x",
      new Set(["c.md"])
    );

    const reloaded = new SyncStateStore(adapter);
    await reloaded.load();
    expect(reloaded.getPreviousEntries()).toEqual([]);
  });
});
