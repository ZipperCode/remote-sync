import { requestUrl } from "obsidian";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { WebDavRemote } from "../src/webdav-remote";

describe("WebDavRemote", () => {
  beforeEach(() => {
    vi.mocked(requestUrl).mockReset();
  });

  test("merges custom headers while keeping built-in headers authoritative", async () => {
    vi.mocked(requestUrl)
      .mockResolvedValueOnce({
        status: 201,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        text: "",
        json: {}
      })
      .mockResolvedValueOnce({
        status: 207,
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
        text: "<d:multistatus xmlns:d=\"DAV:\" />",
        json: {}
      });

    const remote = new WebDavRemote({
      baseUrl: "https://dav.example.com/root",
      username: "alice",
      password: "secret",
      remoteRoot: "vault",
      customHeaders: {
        Depth: "0",
        "User-Agent": "RemoteSync"
      }
    });

    await remote.testConnection();

    const request = vi.mocked(requestUrl).mock.calls.at(-1)?.[0];
    expect(request?.headers).toMatchObject({
      Depth: "0",
      "Content-Type": "application/xml",
      "User-Agent": "RemoteSync",
      Authorization: expect.stringContaining("Basic ")
    });
  });
});
