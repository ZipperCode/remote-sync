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

const entry = (path: string, mtime: number): FileEntry => ({
  path,
  type: "file",
  size: 1,
  mtime
});

describe("SyncStateStore", () => {
  test("updates state only when explicitly saved after a successful sync", async () => {
    const adapter = new MemoryAdapter();
    const store = new SyncStateStore(adapter);

    await store.load();
    expect(store.getPreviousEntries()).toEqual([]);

    await store.saveSuccessfulSync([entry("a.md", 100)], [entry("a.md", 110)]);

    const reloaded = new SyncStateStore(adapter);
    await reloaded.load();

    expect(reloaded.getPreviousEntries()).toEqual([
      expect.objectContaining({ path: "a.md" })
    ]);
    expect(reloaded.getLastSyncTime()).toBeGreaterThan(0);
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
