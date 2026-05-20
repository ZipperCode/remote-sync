import { describe, expect, test, vi } from "vitest";

vi.mock("obsidian", () => ({
  App: class {},
  Modal: class {},
  Notice: vi.fn(),
  Platform: { isMobile: false },
  Plugin: class {},
  PluginSettingTab: class {},
  Setting: class {},
  TextFileView: class {},
  requestUrl: vi.fn()
}));

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
});
