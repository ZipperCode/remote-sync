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
});
