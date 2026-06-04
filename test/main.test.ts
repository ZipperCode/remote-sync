import { describe, expect, test, vi } from "vitest";

const modalHooks = vi.hoisted(() => {
  return {
    openCount: 0,
    // The most recently opened modal instance, so tests can drive its
    // close() to emulate the user dismissing the dialog.
    lastInstance: null as null | { close: () => void },
    // Button onClick handlers registered during the most recent onOpen,
    // keyed by their button label, so tests can emulate a real button click
    // (e.g. "全部跳过") instead of only the X / Esc close() path.
    buttons: new Map<string, () => void>(),
    reset(): void {
      this.openCount = 0;
      this.lastInstance = null;
      this.buttons.clear();
    },
    click(label: string): void {
      const handler = this.buttons.get(label);
      if (!handler) {
        throw new Error(`No button registered with label "${label}"`);
      }
      handler();
    }
  };
});

function createChainableEl(): any {
  const el: any = {
    empty: vi.fn(() => el),
    createEl: vi.fn(() => createChainableEl()),
    createDiv: vi.fn(() => createChainableEl()),
    setText: vi.fn(() => el),
    addClass: vi.fn(() => el),
    addEventListener: vi.fn()
  };
  return el;
}

vi.mock("obsidian", () => {
  class Modal {
    contentEl = createChainableEl();
    constructor(public app: unknown) {}
    open(): void {
      modalHooks.openCount += 1;
      modalHooks.lastInstance = this as unknown as { close: () => void };
      (this as unknown as { onOpen?: () => void }).onOpen?.();
    }
    close(): void {
      (this as unknown as { onClose?: () => void }).onClose?.();
    }
  }

  // Setting is fully chainable; dropdown/button callbacks receive chainable
  // stubs so SyncConfirmationModal.onOpen can render without throwing.
  class Setting {
    constructor(_containerEl?: unknown) {}
    setName(): this {
      return this;
    }
    setDesc(): this {
      return this;
    }
    addDropdown(cb: (dropdown: unknown) => void): this {
      let current = "";
      const dropdown: any = {
        addOption: vi.fn(() => dropdown),
        setValue: vi.fn((value: string) => {
          current = value;
          return dropdown;
        }),
        getValue: vi.fn(() => current),
        onChange: vi.fn(() => dropdown)
      };
      cb(dropdown);
      return this;
    }
    addButton(cb: (button: unknown) => void): this {
      let label = "";
      const button: any = {
        setButtonText: vi.fn((text: string) => {
          label = text;
          return button;
        }),
        setCta: vi.fn(() => button),
        // Record the handler under the button's label so tests can fire it.
        onClick: vi.fn((handler: () => void) => {
          modalHooks.buttons.set(label, handler);
          return button;
        })
      };
      cb(button);
      return this;
    }
  }

  return {
    App: class {},
    Modal,
    Notice: vi.fn(),
    Platform: { isMobile: false },
    Plugin: class {},
    PluginSettingTab: class {},
    Setting,
    TextFileView: class {},
    requestUrl: vi.fn()
  };
});

vi.mock("../src/code-file-view", () => ({
  CODE_VIEW_TYPE: "remote-sync-code-view",
  RemoteSyncCodeView: class {},
  SUPPORTED_CODE_EXTENSIONS: []
}));

describe("RemoteSyncPlugin", () => {
  test("registers a command for checking plugin updates", async () => {
    const { default: RemoteSyncPlugin } = await import("../main.ts");
    const plugin = new RemoteSyncPlugin();
    const addCommand = vi.fn();

    Object.assign(plugin, {
      app: {
        workspace: {
          on: vi.fn(() => ({}))
        },
        vault: {
          getName: vi.fn(() => "My Vault")
        }
      },
      loadData: vi.fn(async () => ({ settings: {} })),
      saveData: vi.fn(async () => {}),
      registerView: vi.fn(),
      registerExtensions: vi.fn(),
      registerEvent: vi.fn(),
      register: vi.fn(),
      addRibbonIcon: vi.fn(),
      addCommand,
      addStatusBarItem: vi.fn(() => ({
        setText: vi.fn()
      })),
      addSettingTab: vi.fn(),
      registerAutoSync: vi.fn()
    });

    await plugin.onload();

    const updateCommand = addCommand.mock.calls
      .map(([command]) => command)
      .find((command) => command.id === "check-plugin-update");

    expect(updateCommand?.name).toBe("检查插件更新");
  });

  test("registers a '重置同步状态' command that clears the stale lock and re-syncs", async () => {
    const { default: RemoteSyncPlugin } = await import("../main.ts");
    const plugin = new RemoteSyncPlugin();
    const addCommand = vi.fn();

    Object.assign(plugin, {
      app: { workspace: { on: vi.fn(() => ({})) }, vault: { getName: vi.fn(() => "V") } },
      loadData: vi.fn(async () => ({ settings: {} })),
      saveData: vi.fn(async () => {}),
      registerView: vi.fn(),
      registerExtensions: vi.fn(),
      registerEvent: vi.fn(),
      register: vi.fn(),
      addRibbonIcon: vi.fn(),
      addCommand,
      addStatusBarItem: vi.fn(() => ({ setText: vi.fn() })),
      addSettingTab: vi.fn(),
      registerAutoSync: vi.fn()
    });

    await plugin.onload();

    const resetCommand = addCommand.mock.calls
      .map(([command]) => command)
      .find((command) => command.id === "reset-sync-state");
    expect(resetCommand?.name).toBe("重置同步状态");

    // Simulate a stuck lock, then invoke the command callback.
    const internals = plugin as unknown as { syncStartedAt: number | null; syncNow: () => Promise<void> };
    internals.syncStartedAt = 123;
    const syncNow = vi.fn(async () => {});
    internals.syncNow = syncNow;

    resetCommand!.callback();

    expect(internals.syncStartedAt).toBeNull();
    expect(syncNow).toHaveBeenCalledTimes(1);
  });

  test("downloads and applies the latest plugin release files", async () => {
    const { Notice, requestUrl } = await import("obsidian");
    const { default: RemoteSyncPlugin } = await import("../main.ts");
    const plugin = new RemoteSyncPlugin();
    const storedFiles = new Map<string, ArrayBuffer>([
      [
        ".obsidian/plugins/obsidian-webdav-sync/manifest.json",
        new TextEncoder().encode('{"version":"0.1.1"}').buffer
      ],
      [
        ".obsidian/plugins/obsidian-webdav-sync/main.js",
        new TextEncoder().encode("console.log('old');").buffer
      ],
      [
        ".obsidian/plugins/obsidian-webdav-sync/styles.css",
        new TextEncoder().encode(".status { color: blue; }").buffer
      ]
    ]);
    const writeBinary = vi.fn(async (path: string, content: ArrayBuffer) => {
      storedFiles.set(path, content);
    });

    vi.mocked(requestUrl).mockReset();
    vi.mocked(requestUrl)
      .mockResolvedValueOnce({
        status: 200,
        json: {
          tag_name: "v0.1.2",
          assets: [
            {
              name: "manifest.json",
              browser_download_url: "https://example.com/manifest.json"
            },
            {
              name: "main.js",
              browser_download_url: "https://example.com/main.js"
            },
            {
              name: "styles.css",
              browser_download_url: "https://example.com/styles.css"
            }
          ]
        }
      })
      .mockResolvedValueOnce({
        status: 200,
        arrayBuffer: new TextEncoder().encode(
          JSON.stringify({
            id: "obsidian-webdav-sync",
            version: "0.1.2"
          })
        ).buffer
      })
      .mockResolvedValueOnce({
        status: 200,
        arrayBuffer: new TextEncoder().encode("console.log('new');").buffer
      })
      .mockResolvedValueOnce({
        status: 200,
        arrayBuffer: new TextEncoder().encode(".status { color: green; }").buffer
      });
    vi.mocked(Notice).mockClear();

    Object.assign(plugin, {
      manifest: {
        id: "obsidian-webdav-sync",
        version: "0.1.1"
      },
      app: {
        workspace: {
          on: vi.fn(() => ({}))
        },
        vault: {
          configDir: ".obsidian",
          getName: vi.fn(() => "My Vault"),
          adapter: {
            exists: vi.fn(async (path: string) => storedFiles.has(path)),
            readBinary: vi.fn(async (path: string) => storedFiles.get(path) ?? new ArrayBuffer(0)),
            writeBinary,
            mkdir: vi.fn(async () => {})
          }
        }
      }
    });

    await plugin.checkPluginUpdates();

    expect(writeBinary).toHaveBeenCalledWith(
      ".obsidian/plugins/obsidian-webdav-sync/manifest.json",
      expect.any(ArrayBuffer)
    );
    expect(writeBinary).toHaveBeenCalledWith(
      ".obsidian/plugins/obsidian-webdav-sync/main.js",
      expect.any(ArrayBuffer)
    );
    expect(writeBinary).toHaveBeenCalledWith(
      ".obsidian/plugins/obsidian-webdav-sync/styles.css",
      expect.any(ArrayBuffer)
    );
    expect(vi.mocked(Notice)).toHaveBeenCalledWith(
      "插件已更新到 0.1.2，请重启 Obsidian 或手动重载插件。"
    );
  });

  // Builds a plugin instance wired for runSync: configured WebDAV settings so
  // assertConfigured passes, a stubbed engine whose syncOnce always reports a
  // pending confirmation, and a status-bar element we can inspect.
  async function buildConfirmationPlugin() {
    const { Notice } = await import("obsidian");
    vi.mocked(Notice).mockClear();
    modalHooks.reset();

    const { default: RemoteSyncPlugin } = await import("../main.ts");
    const plugin = new RemoteSyncPlugin();
    const statusText = vi.fn();

    const confirmation = {
      path: "notes/conflict.md",
      conflictType: "binary" as const,
      reason: "same-mtime-different-size" as const,
      local: { path: "notes/conflict.md" },
      remote: { path: "notes/conflict.md" }
    };
    const result = {
      plan: {
        operations: [],
        confirmations: [confirmation],
        conflicts: [],
        skipped: [],
        initialSyncRequired: false
      },
      summary: {
        uploaded: 0,
        downloaded: 0,
        deletedLocal: 0,
        deletedRemote: 0,
        merged: 0,
        skipped: 0,
        conflicts: 0,
        pendingConfirmations: 1,
        backedUp: 0,
        failures: 0,
        initialSyncRequired: false,
        failureDetails: []
      }
    };
    const syncOnce = vi.fn(async () => result);

    Object.assign(plugin, {
      manifest: { id: "obsidian-webdav-sync", version: "0.1.1" },
      statusBarItemEl: { setText: statusText },
      settings: {
        provider: "webdav",
        baseUrl: "https://example.com/dav",
        customHeaders: ""
      },
      createEngine: () => ({ syncOnce })
    });

    return { plugin, statusText, syncOnce };
  }

  // Builds a plugin whose engine reports the given confirmations, captures the
  // decisions submitted by the modal so a test can assert what the group
  // buttons produced.
  async function buildGroupedConfirmationPlugin(confirmations: any[]) {
    const { Notice } = await import("obsidian");
    vi.mocked(Notice).mockClear();
    modalHooks.reset();

    const { default: RemoteSyncPlugin } = await import("../main.ts");
    const plugin = new RemoteSyncPlugin();
    const submitted: any[] = [];

    const result = {
      plan: {
        operations: [],
        confirmations,
        conflicts: [],
        skipped: [],
        initialSyncRequired: false
      },
      summary: {
        uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0,
        merged: 0, skipped: 0, conflicts: 0,
        pendingConfirmations: confirmations.length,
        backedUp: 0, failures: 0, initialSyncRequired: false, failureDetails: []
      }
    };
    // First call returns the confirmations; the resubmit (confirmManually:false)
    // call captures decisions and returns a clean result.
    const syncOnce = vi
      .fn()
      .mockResolvedValueOnce(result)
      .mockImplementation(async (decisions: any[]) => {
        if (decisions) submitted.push(...decisions);
        return { ...result, plan: { ...result.plan, confirmations: [] }, summary: { ...result.summary, pendingConfirmations: 0 } };
      });

    Object.assign(plugin, {
      manifest: { id: "obsidian-webdav-sync", version: "0.1.1" },
      statusBarItemEl: { setText: vi.fn() },
      settings: { provider: "webdav", baseUrl: "https://example.com/dav", customHeaders: "" },
      createEngine: () => ({ syncOnce })
    });

    return { plugin, submitted };
  }

  test("group button '全部接受删除' applies accept-delete to all delete-vs-modify entries only", async () => {
    const confirmations = [
      { path: "del1.md", conflictType: "delete-vs-modify", reason: "remote-deleted", local: { path: "del1.md" } },
      { path: "del2.md", conflictType: "delete-vs-modify", reason: "remote-deleted", local: { path: "del2.md" } },
      { path: "bin.png", conflictType: "binary", reason: "same-mtime-different-size", local: { path: "bin.png" }, remote: { path: "bin.png" } }
    ];
    const { plugin, submitted } = await buildGroupedConfirmationPlugin(confirmations);

    await (plugin as unknown as { syncNow: () => Promise<void> }).syncNow();
    expect(modalHooks.openCount).toBe(1);

    // Click the delete-group bulk button.
    modalHooks.click("全部接受删除");

    const byPath = new Map(submitted.map((d) => [d.path, d.action]));
    expect(byPath.get("del1.md")).toBe("accept-delete");
    expect(byPath.get("del2.md")).toBe("accept-delete");
    // The binary entry must NOT be forced to accept-delete by the delete group.
    expect(byPath.get("bin.png")).not.toBe("accept-delete");
  });

  test("group button '全部用远端' applies use-remote to all text-conflict entries", async () => {
    const confirmations = [
      { path: "t1.md", conflictType: "text-overlap", reason: "both-changed", local: { path: "t1.md" }, remote: { path: "t1.md" } },
      { path: "t2.md", conflictType: "text-no-base", reason: "both-changed", local: { path: "t2.md" }, remote: { path: "t2.md" } }
    ];
    const { plugin, submitted } = await buildGroupedConfirmationPlugin(confirmations);

    await (plugin as unknown as { syncNow: () => Promise<void> }).syncNow();
    modalHooks.click("全部用远端");

    const byPath = new Map(submitted.map((d) => [d.path, d.action]));
    expect(byPath.get("t1.md")).toBe("use-remote");
    expect(byPath.get("t2.md")).toBe("use-remote");
  });

  test("group button '全部自动合并' sets auto-merge only for merge candidates and keeps others at their default", async () => {
    // Mixed text group: one mergeable candidate (suggestedKind: "merge") and one
    // non-mergeable text conflict. "全部自动合并" must set auto-merge ONLY for the
    // mergeable one; the non-mergeable entry keeps its per-item default decision
    // (text-overlap defaults to "skip"), never auto-merge.
    const confirmations = [
      { path: "merge.md", conflictType: "text-auto-merge", reason: "both-changed", suggestedKind: "merge", local: { path: "merge.md" }, remote: { path: "merge.md" } },
      { path: "overlap.md", conflictType: "text-overlap", reason: "both-changed", local: { path: "overlap.md" }, remote: { path: "overlap.md" } }
    ];
    const { plugin, submitted } = await buildGroupedConfirmationPlugin(confirmations);

    await (plugin as unknown as { syncNow: () => Promise<void> }).syncNow();
    modalHooks.click("全部自动合并");

    const byPath = new Map(submitted.map((d) => [d.path, d.action]));
    expect(byPath.get("merge.md")).toBe("auto-merge");
    // The non-mergeable entry must NOT be forced to auto-merge.
    expect(byPath.get("overlap.md")).not.toBe("auto-merge");
    expect(byPath.get("overlap.md")).toBe("skip");
  });

  test("confirmation modal guard prevents concurrent opens", async () => {
    const { plugin } = await buildConfirmationPlugin();

    // Two automatic syncs while the modal is still open should only surface one
    // dialog, because the guard is set synchronously before .open().
    await (plugin as unknown as { syncAutomatically: () => Promise<unknown> }).syncAutomatically();
    await (plugin as unknown as { syncAutomatically: () => Promise<unknown> }).syncAutomatically();

    expect(modalHooks.openCount).toBe(1);
  });

  test("auto sync degrades to status bar after the user dismisses the modal", async () => {
    const { plugin, statusText } = await buildConfirmationPlugin();

    // First auto sync opens the confirmation modal.
    await (plugin as unknown as { syncAutomatically: () => Promise<unknown> }).syncAutomatically();
    expect(modalHooks.openCount).toBe(1);

    // The user closes the modal without making a decision (X / Esc).
    modalHooks.lastInstance?.close();

    // Subsequent automatic syncs must NOT reopen the modal; they degrade to a
    // status-bar hint instead.
    statusText.mockClear();
    await (plugin as unknown as { syncAutomatically: () => Promise<unknown> }).syncAutomatically();

    expect(modalHooks.openCount).toBe(1);
    expect(statusText).toHaveBeenCalledWith(
      expect.stringContaining("待确认 1 个，点击同步处理")
    );
  });

  test('"全部跳过" releases the guard so a later manual sync can reopen the modal', async () => {
    const { plugin } = await buildConfirmationPlugin();

    // First auto sync opens the confirmation modal.
    await (plugin as unknown as { syncAutomatically: () => Promise<unknown> }).syncAutomatically();
    expect(modalHooks.openCount).toBe(1);

    // The user clicks "全部跳过". This must release the open guard even though
    // no decision was submitted; otherwise confirmationModalOpen would stay
    // true forever and block every future confirmation modal.
    modalHooks.click("全部跳过");

    // A manual sync (confirmManually, NOT autoConfirm) clears the degraded
    // state and should be able to reopen the modal again.
    await (plugin as unknown as { syncNow: () => Promise<void> }).syncNow();

    expect(modalHooks.openCount).toBe(2);
  });

  test("degraded auto sync persists guidance into lastSyncLabel for onPendingChange fallback", async () => {
    const { plugin, statusText } = await buildConfirmationPlugin();

    // Open then dismiss the modal so automatic syncs degrade to the hint.
    await (plugin as unknown as { syncAutomatically: () => Promise<unknown> }).syncAutomatically();
    modalHooks.lastInstance?.close();

    // Degraded auto sync must persist the guidance into lastSyncLabel (not just
    // call updateStatus once), because onPendingChange falls back to
    // lastSyncLabel when pendingCount === 0. If it only called updateStatus,
    // the next vault change would overwrite the "how to resolve" hint.
    await (plugin as unknown as { syncAutomatically: () => Promise<unknown> }).syncAutomatically();

    const internals = plugin as unknown as {
      lastSyncLabel: string;
      updateStatus: (value: string) => void;
    };
    expect(internals.lastSyncLabel).toContain("待确认 1 个，点击同步处理");

    // Emulate registerAutoSync's onPendingChange(0): updateStatus(lastSyncLabel).
    // The status bar must still surface the guidance, not a generic label.
    statusText.mockClear();
    internals.updateStatus(internals.lastSyncLabel);
    expect(statusText).toHaveBeenCalledWith(
      expect.stringContaining("待确认 1 个，点击同步处理")
    );
  });
});
