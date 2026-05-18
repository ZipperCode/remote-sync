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
  });
});
