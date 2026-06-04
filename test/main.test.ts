import { describe, expect, test, vi } from "vitest";

const modalHooks = vi.hoisted(() => {
  return {
    openCount: 0,
    // The most recently opened modal instance, so tests can drive its
    // close() to emulate the user dismissing the dialog.
    lastInstance: null as null | { close: () => void },
    reset(): void {
      this.openCount = 0;
      this.lastInstance = null;
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
      const dropdown: any = {
        addOption: vi.fn(() => dropdown),
        setValue: vi.fn(() => dropdown),
        onChange: vi.fn(() => dropdown)
      };
      cb(dropdown);
      return this;
    }
    addButton(cb: (button: unknown) => void): this {
      const button: any = {
        setButtonText: vi.fn(() => button),
        setCta: vi.fn(() => button),
        onClick: vi.fn(() => button)
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
});
