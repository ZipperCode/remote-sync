import { afterEach, describe, expect, test, vi } from "vitest";
import { AUTO_SYNC_DEBOUNCE_MS, AutoSyncController } from "../src/auto-sync-controller";

describe("AutoSyncController", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("debounces create, modify, delete, and rename events into one sync", async () => {
    vi.useFakeTimers();
    const sync = vi.fn().mockResolvedValue(undefined);
    const controller = new AutoSyncController({
      sync,
      shouldIgnorePath: () => false
    });

    controller.handleVaultChange("new.md");
    await vi.advanceTimersByTimeAsync(1000);
    controller.handleVaultChange("edited.md");
    await vi.advanceTimersByTimeAsync(1000);
    controller.handleVaultChange("deleted.md");
    await vi.advanceTimersByTimeAsync(1000);
    controller.handleVaultRename("renamed.md", "old.md");
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS - 1);

    expect(sync).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(sync).toHaveBeenCalledTimes(1);
  });

  test("ignores ignored path events", async () => {
    vi.useFakeTimers();
    const sync = vi.fn().mockResolvedValue(undefined);
    const controller = new AutoSyncController({
      sync,
      shouldIgnorePath: (path) => path.startsWith(".obsidian/")
    });

    controller.handleVaultChange(".obsidian/workspace.json");
    controller.handleVaultRename(".obsidian/new.json", ".obsidian/old.json");
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS);

    expect(sync).not.toHaveBeenCalled();
  });

  test("does not run sync concurrently and schedules one pending sync after current run", async () => {
    vi.useFakeTimers();
    let finishFirstSync!: () => void;
    const sync = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirstSync = resolve;
          })
      )
      .mockResolvedValue(undefined);
    const controller = new AutoSyncController({
      sync,
      shouldIgnorePath: () => false
    });

    controller.handleVaultChange("first.md");
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS);

    expect(sync).toHaveBeenCalledTimes(1);

    controller.handleVaultChange("second.md");
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS);

    expect(sync).toHaveBeenCalledTimes(1);

    finishFirstSync();
    await vi.runOnlyPendingTimersAsync();

    expect(sync).toHaveBeenCalledTimes(2);
  });

  test("reports pending change count via onPendingChange and resets after sync", async () => {
    vi.useFakeTimers();
    const counts: number[] = [];
    const sync = vi.fn().mockResolvedValue(undefined);
    const controller = new AutoSyncController({
      sync,
      shouldIgnorePath: () => false,
      onPendingChange: (n) => counts.push(n)
    });

    controller.handleVaultChange("a.md");
    controller.handleVaultChange("b.md");
    controller.handleVaultRename("c.md", "old.md");

    // 探测到 3 个不同路径的变更
    expect(counts[counts.length - 1]).toBe(3);

    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS);
    expect(sync).toHaveBeenCalledTimes(1);

    // 同步发起后计数归零
    expect(counts[counts.length - 1]).toBe(0);
  });

  test("ignored paths do not increase pending count", async () => {
    vi.useFakeTimers();
    const counts: number[] = [];
    const sync = vi.fn().mockResolvedValue(undefined);
    const controller = new AutoSyncController({
      sync,
      shouldIgnorePath: (p) => p.startsWith(".obsidian/"),
      onPendingChange: (n) => counts.push(n)
    });

    controller.handleVaultChange(".obsidian/workspace.json");
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS);

    expect(counts).toEqual([]);
    expect(sync).not.toHaveBeenCalled();
  });
});
