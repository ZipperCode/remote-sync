import { describe, expect, test } from "vitest";
import {
  joinRemotePath,
  normalizeRemoteRoot,
  normalizeVaultPath,
  shouldIgnorePath
} from "../src/path-utils";

describe("path utilities", () => {
  test("normalizes vault paths without leading slashes or duplicate separators", () => {
    expect(normalizeVaultPath("/Notes//Daily.md")).toBe("Notes/Daily.md");
    expect(normalizeVaultPath("Attachments\\image.png")).toBe("Attachments/image.png");
    expect(normalizeVaultPath("./Folder/../Folder/File.md")).toBe("Folder/File.md");
  });

  test("joins encoded WebDAV paths under the configured remote root", () => {
    expect(joinRemotePath("Vault Name", "Folder/hello world.md")).toBe(
      "/Vault%20Name/Folder/hello%20world.md"
    );
    expect(joinRemotePath("/Vault//", "/Folder/汉字.md")).toBe(
      "/Vault/Folder/%E6%B1%89%E5%AD%97.md"
    );
  });

  test("normalizes remote root to a relative path", () => {
    expect(normalizeRemoteRoot("/Vault//Sub/")).toBe("Vault/Sub");
    expect(normalizeRemoteRoot("")).toBe("");
  });

  test("ignores Obsidian config, hidden folders, temporary files, and custom patterns", () => {
    expect(shouldIgnorePath(".obsidian/workspace.json", [])).toBe(true);
    expect(shouldIgnorePath("Notes/.trash/deleted.md", [])).toBe(true);
    expect(shouldIgnorePath("Notes/draft.tmp", [])).toBe(true);
    expect(shouldIgnorePath("Notes/private/file.md", ["Notes/private/**"])).toBe(true);
    expect(shouldIgnorePath("Notes/public/file.md", ["Notes/private/**"])).toBe(false);
  });
});
