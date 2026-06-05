import { describe, expect, test } from "vitest";
import { normalizeRemoteSyncSettings } from "../settings";

describe("settings compatibility", () => {
  test("defaults legacy settings without provider to WebDAV", () => {
    const settings = normalizeRemoteSyncSettings(
      {
        baseUrl: "https://dav.example.com",
        username: "alice",
        password: "secret",
        ignorePatterns: ["tmp/**"]
      },
      "My Vault"
    );

    expect(settings.provider).toBe("webdav");
    expect(settings.remoteRoot).toBe("My Vault");
    expect(settings.baseUrl).toBe("https://dav.example.com");
    expect(settings.customHeaders).toBe("");
    expect(settings.syncSafetyMode).toBe("auto");
    expect(settings.maxAutoDeleteRatio).toBe(0.3);
    expect(settings.nonMergeableConflictPolicy).toBe("newer-wins");
  });

  test("normalizes invalid sync safety settings", () => {
    const settings = normalizeRemoteSyncSettings(
      {
        syncSafetyMode: "invalid" as never,
        maxAutoDeleteRatio: 2,
        nonMergeableConflictPolicy: "invalid" as never
      },
      "My Vault"
    );

    expect(settings.syncSafetyMode).toBe("auto");
    expect(settings.maxAutoDeleteRatio).toBe(1);
    expect(settings.nonMergeableConflictPolicy).toBe("newer-wins");
  });

  test("migrates legacy 'safe' mode to 'auto'", () => {
    const settings = normalizeRemoteSyncSettings(
      { syncSafetyMode: "safe" as never },
      "My Vault"
    );
    expect(settings.syncSafetyMode).toBe("auto");
  });

  test("migrates legacy 'balanced' mode to 'auto'", () => {
    const settings = normalizeRemoteSyncSettings(
      { syncSafetyMode: "balanced" as never },
      "My Vault"
    );
    expect(settings.syncSafetyMode).toBe("auto");
  });
});
