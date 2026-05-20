import { describe, expect, test, vi } from "vitest";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("plugin-updater", () => {
  test("downloads latest release assets when a newer version is available", async () => {
    const module = await import("../src/plugin-updater.ts").catch(() => null);
    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const request = vi
      .fn()
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
        arrayBuffer: encoder.encode(
          JSON.stringify({
            id: "obsidian-webdav-sync",
            version: "0.1.2"
          })
        ).buffer
      })
      .mockResolvedValueOnce({
        status: 200,
        arrayBuffer: encoder.encode("console.log('updated');").buffer
      })
      .mockResolvedValueOnce({
        status: 200,
        arrayBuffer: encoder.encode(".status { color: green; }").buffer
      });

    const result = await module.checkForPluginUpdate({
      currentVersion: "0.1.1",
      pluginId: "obsidian-webdav-sync",
      request
    });

    expect(result.status).toBe("update-available");
    expect(result.release).toMatchObject({
      tag: "v0.1.2",
      version: "0.1.2"
    });
    expect(decoder.decode(result.release.files["manifest.json"])).toContain("\"version\":\"0.1.2\"");
    expect(decoder.decode(result.release.files["main.js"])).toContain("updated");
    expect(request).toHaveBeenCalledTimes(4);
  });

  test("restores previous plugin files if applying an update fails midway", async () => {
    const module = await import("../src/plugin-updater.ts").catch(() => null);
    expect(module).not.toBeNull();
    if (!module) {
      return;
    }

    const pluginDir = ".obsidian/plugins/obsidian-webdav-sync";
    const storedFiles = new Map<string, ArrayBuffer>([
      [`${pluginDir}/manifest.json`, encoder.encode('{"version":"0.1.1"}').buffer],
      [`${pluginDir}/main.js`, encoder.encode("console.log('old');").buffer],
      [`${pluginDir}/styles.css`, encoder.encode(".status { color: blue; }").buffer]
    ]);

    const writeBinary = vi.fn(async (path: string, content: ArrayBuffer) => {
      if (path.endsWith("/main.js")) {
        throw new Error("disk full");
      }
      storedFiles.set(path, content);
    });

    await expect(
      module.applyPluginUpdate({
        pluginDir,
        release: {
          tag: "v0.1.2",
          version: "0.1.2",
          files: {
            "manifest.json": encoder.encode('{"version":"0.1.2"}').buffer,
            "main.js": encoder.encode("console.log('new');").buffer,
            "styles.css": encoder.encode(".status { color: green; }").buffer
          }
        },
        adapter: {
          exists: vi.fn(async (path: string) => storedFiles.has(path)),
          readBinary: vi.fn(async (path: string) => storedFiles.get(path) ?? new ArrayBuffer(0)),
          writeBinary,
          mkdir: vi.fn(async () => {})
        }
      })
    ).rejects.toThrow("disk full");

    expect(decoder.decode(storedFiles.get(`${pluginDir}/manifest.json`))).toContain("0.1.1");
    expect(decoder.decode(storedFiles.get(`${pluginDir}/main.js`))).toContain("old");
    expect(decoder.decode(storedFiles.get(`${pluginDir}/styles.css`))).toContain("blue");
  });
});
