import { requestUrl } from "obsidian";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  S3Remote,
  buildS3Url,
  getDefaultS3Options,
  parseListObjectsV2,
  signS3Request
} from "../src/s3-remote";

const baseOptions = {
  preset: "custom" as const,
  endpoint: "https://s3.example.com/root",
  region: "us-east-1",
  bucket: "notes",
  prefix: "vault",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  sessionToken: "",
  addressingStyle: "path" as const,
  customHeaders: {}
};

describe("S3-compatible remote", () => {
  beforeEach(() => {
    vi.mocked(requestUrl).mockReset();
  });

  test("signs a fixed request with stable SigV4 authorization", async () => {
    const signed = await signS3Request(
      baseOptions,
      {
        method: "GET",
        url: "https://s3.example.com/notes/vault/a.txt?list-type=2",
        headers: {
          "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          "x-amz-date": "20130524T000000Z"
        }
      },
      new Date("2013-05-24T00:00:00Z")
    );

    expect(signed.Authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=0b5d526182a5fef49da111caf44d26a3636f5fe5c3abfa24f0e87bd28173911d"
    );
  });

  test("builds path-style and virtual-hosted URLs", () => {
    expect(buildS3Url(baseOptions, "folder/a b.md").toString()).toBe(
      "https://s3.example.com/root/notes/vault/folder/a%20b.md"
    );
    expect(
      buildS3Url(
        {
          ...baseOptions,
          endpoint: "https://s3.amazonaws.com",
          addressingStyle: "virtual-hosted"
        },
        "folder/a b.md"
      ).toString()
    ).toBe("https://notes.s3.amazonaws.com/vault/folder/a%20b.md");
  });

  test("uses R2 defaults", () => {
    expect(getDefaultS3Options("r2")).toEqual({
      region: "auto",
      addressingStyle: "path"
    });
  });

  test("parses ListObjectsV2 XML", () => {
    const entries = parseListObjectsV2(
      `<?xml version="1.0"?>
      <ListBucketResult>
        <Contents>
          <Key>vault/folder/a.md</Key>
          <LastModified>2026-05-18T01:02:03.000Z</LastModified>
          <ETag>"abc"</ETag>
          <Size>42</Size>
        </Contents>
      </ListBucketResult>`,
      "vault"
    );

    expect(entries).toEqual([
      {
        path: "folder/a.md",
        type: "file",
        mtime: Date.parse("2026-05-18T01:02:03.000Z"),
        size: 42,
        etag: "abc"
      }
    ]);
  });

  test("ignores directory placeholder objects in ListObjectsV2 XML", () => {
    const entries = parseListObjectsV2(
      `<?xml version="1.0"?>
      <ListBucketResult>
        <Contents>
          <Key>vault/99-归档/</Key>
          <LastModified>2026-05-18T01:02:03.000Z</LastModified>
          <ETag>"placeholder"</ETag>
          <Size>0</Size>
        </Contents>
        <Contents>
          <Key>vault/99-归档/note.md</Key>
          <LastModified>2026-05-18T01:02:04.000Z</LastModified>
          <ETag>"file"</ETag>
          <Size>12</Size>
        </Contents>
      </ListBucketResult>`,
      "vault"
    );

    expect(entries).toEqual([
      {
        path: "99-归档/note.md",
        type: "file",
        mtime: Date.parse("2026-05-18T01:02:04.000Z"),
        size: 12,
        etag: "file"
      }
    ]);
  });

  test("GET, PUT, DELETE, and list requests use expected methods, URLs, and headers", async () => {
    vi.mocked(requestUrl).mockResolvedValue({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
      text: "<ListBucketResult />",
      json: {}
    });

    const remote = new S3Remote({
      ...baseOptions,
      customHeaders: {
        "User-Agent": "RemoteSync",
        "X-Trace": "abc"
      }
    });

    await remote.snapshot();
    await remote.readFile("a.md");
    await remote.writeFile("a.md", new TextEncoder().encode("hello").buffer);
    await remote.deleteFile("a.md");

    const calls = vi.mocked(requestUrl).mock.calls.map(([request]) => request);
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET", "PUT", "DELETE"]);
    expect(calls[0].url).toBe("https://s3.example.com/root/notes?list-type=2&prefix=vault%2F");
    expect(calls[1].url).toBe("https://s3.example.com/root/notes/vault/a.md");
    expect(calls[2].url).toBe("https://s3.example.com/root/notes/vault/a.md");
    expect(calls[3].url).toBe("https://s3.example.com/root/notes/vault/a.md");
    expect(calls[2].headers).toMatchObject({
      "User-Agent": "RemoteSync",
      "X-Trace": "abc",
      "x-amz-content-sha256": expect.any(String),
      "x-amz-date": expect.any(String),
      Authorization: expect.stringContaining("AWS4-HMAC-SHA256")
    });
  });
});
