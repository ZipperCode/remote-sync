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
});
