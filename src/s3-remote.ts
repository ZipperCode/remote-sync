import { requestUrl, RequestUrlResponse } from "obsidian";
import { mergeCustomHeaders } from "./custom-headers";
import { normalizeVaultPath, splitPath } from "./path-utils";
import { SyncRemoteStore } from "./sync-engine";
import { FileEntry } from "./sync-planner";

export type S3Preset = "aws" | "r2" | "custom";
export type S3AddressingStyle = "path" | "virtual-hosted";

export interface S3RemoteOptions {
  preset: S3Preset;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  addressingStyle: S3AddressingStyle;
  customHeaders: Record<string, string>;
}

interface S3RequestToSign {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | ArrayBuffer;
}

interface ListObjectsV2Result {
  entries: FileEntry[];
  isTruncated: boolean;
  nextContinuationToken?: string;
}

export class S3Remote implements SyncRemoteStore {
  constructor(private readonly options: S3RemoteOptions) {}

  async snapshot(): Promise<FileEntry[]> {
    const files: FileEntry[] = [];
    let continuationToken: string | undefined;

    do {
      const query: Record<string, string> = {
        "list-type": "2"
      };
      const prefix = normalizedPrefix(this.options.prefix);
      if (prefix) {
        query.prefix = `${prefix}/`;
      }
      if (continuationToken) {
        query["continuation-token"] = continuationToken;
      }

      const response = await this.request("GET", "", undefined, query);
      this.assertOk(response, [200], "列出 S3 对象");

      const result = parseListObjectsV2Result(response.text, this.options.prefix);
      files.push(...result.entries);
      continuationToken = result.nextContinuationToken;
      if (!result.isTruncated) {
        continuationToken = undefined;
      }
    } while (continuationToken);

    return files;
  }

  async readFile(path: string): Promise<ArrayBuffer> {
    const response = await this.request("GET", normalizeVaultPath(path));
    this.assertOk(response, [200, 206], `读取远程文件 ${path}`);
    return response.arrayBuffer;
  }

  async writeFile(path: string, content: ArrayBuffer): Promise<void> {
    const response = await this.request("PUT", normalizeVaultPath(path), content);
    this.assertOk(response, [200, 201, 204], `写入远程文件 ${path}`);
  }

  async deleteFile(path: string): Promise<void> {
    const response = await this.request("DELETE", normalizeVaultPath(path));
    this.assertOk(response, [200, 202, 204, 404], `删除远程文件 ${path}`);
  }

  async testConnection(): Promise<void> {
    const response = await this.request("GET", "", undefined, {
      "list-type": "2",
      "max-keys": "1",
      ...(normalizedPrefix(this.options.prefix) ? { prefix: `${normalizedPrefix(this.options.prefix)}/` } : {})
    });
    this.assertOk(response, [200], "测试 S3 连接");
  }

  private async request(
    method: string,
    path: string,
    body?: string | ArrayBuffer,
    query: Record<string, string> = {}
  ): Promise<RequestUrlResponse> {
    const url = buildS3Url(this.options, normalizeVaultPath(path), query).toString();
    const headers = mergeCustomHeaders(this.options.customHeaders, {
      "x-amz-content-sha256": await sha256Hex(body ?? ""),
      "x-amz-date": formatAmzDate(new Date())
    });
    const signedHeaders = await signS3Request(this.options, { method, url, headers, body });

    return requestUrl({
      url,
      method,
      body,
      headers: signedHeaders,
      throw: false
    });
  }

  private assertOk(response: RequestUrlResponse, okStatuses: number[], action: string): void {
    if (!okStatuses.includes(response.status)) {
      throw new Error(`S3 操作失败：${action}，HTTP ${response.status}`);
    }
  }
}

export function getDefaultS3Options(
  preset: S3Preset
): Pick<S3RemoteOptions, "region" | "addressingStyle"> {
  if (preset === "aws") {
    return {
      region: "us-east-1",
      addressingStyle: "virtual-hosted"
    };
  }

  if (preset === "r2") {
    return {
      region: "auto",
      addressingStyle: "path"
    };
  }

  return {
    region: "us-east-1",
    addressingStyle: "path"
  };
}

export function buildS3Url(
  options: Pick<S3RemoteOptions, "endpoint" | "bucket" | "prefix" | "addressingStyle">,
  path: string,
  query: Record<string, string> = {}
): URL {
  const url = new URL(options.endpoint);
  const baseSegments = splitDecodedPath(url.pathname);
  const keySegments = path ? [...splitPath(options.prefix), ...splitPath(path)] : [];
  const pathSegments =
    options.addressingStyle === "virtual-hosted"
      ? [...baseSegments, ...keySegments]
      : [...baseSegments, ...splitPath(options.bucket), ...keySegments];

  if (options.addressingStyle === "virtual-hosted") {
    url.hostname = `${options.bucket}.${url.hostname}`;
  }

  url.pathname = `/${pathSegments.map(encodeURIComponent).join("/")}`;
  url.search = "";
  for (const [name, value] of Object.entries(query).sort(([left], [right]) => left.localeCompare(right))) {
    url.searchParams.set(name, value);
  }

  return url;
}

export async function signS3Request(
  options: Pick<S3RemoteOptions, "accessKeyId" | "secretAccessKey" | "sessionToken" | "region">,
  request: S3RequestToSign,
  now = new Date()
): Promise<Record<string, string>> {
  const url = new URL(request.url);
  const headers: Record<string, string> = { ...request.headers };
  headers["x-amz-date"] = headers["x-amz-date"] ?? formatAmzDate(now);
  headers["x-amz-content-sha256"] =
    headers["x-amz-content-sha256"] ?? (await sha256Hex(request.body ?? ""));
  if (options.sessionToken) {
    headers["x-amz-security-token"] = options.sessionToken;
  }

  const amzDate = headers["x-amz-date"];
  const dateStamp = amzDate.slice(0, 8);
  const normalizedHeaders = normalizeHeadersForSigning(url, headers);
  const signedHeaders = Object.keys(normalizedHeaders).sort();
  const canonicalHeaders = signedHeaders
    .map((name) => `${name}:${normalizedHeaders[name]}\n`)
    .join("");
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalUri(url),
    canonicalQueryString(url),
    canonicalHeaders,
    signedHeaders.join(";"),
    headers["x-amz-content-sha256"]
  ].join("\n");
  const scope = `${dateStamp}/${options.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest)
  ].join("\n");
  const signingKey = await getSigningKey(options.secretAccessKey, dateStamp, options.region);
  const signature = bytesToHex(await hmacSha256(signingKey, stringToSign));

  return {
    ...headers,
    Authorization: [
      `AWS4-HMAC-SHA256 Credential=${options.accessKeyId}/${scope}`,
      `SignedHeaders=${signedHeaders.join(";")}`,
      `Signature=${signature}`
    ].join(", ")
  };
}

export function parseListObjectsV2(xml: string, prefix: string): FileEntry[] {
  return parseListObjectsV2Result(xml, prefix).entries;
}

function parseListObjectsV2Result(xml: string, prefix: string): ListObjectsV2Result {
  const normalized = normalizedPrefix(prefix);
  const prefixWithSlash = normalized ? `${normalized}/` : "";
  const entries = matchAll(xml, /<Contents\b[^>]*>([\s\S]*?)<\/Contents>/gi)
    .map((contentXml): FileEntry | null => {
      const key = firstTagValue(contentXml, "Key");
      if (!key || (prefixWithSlash && !key.startsWith(prefixWithSlash))) {
        return null;
      }

      const path = normalizeVaultPath(prefixWithSlash ? key.slice(prefixWithSlash.length) : key);
      if (!path) {
        return null;
      }

      const modified = Date.parse(firstTagValue(contentXml, "LastModified"));
      const size = Number.parseInt(firstTagValue(contentXml, "Size"), 10);
      const etag = firstTagValue(contentXml, "ETag").replace(/^"|"$/g, "");
      return {
        path,
        type: "file",
        mtime: Number.isFinite(modified) ? modified : 0,
        size: Number.isFinite(size) ? size : 0,
        etag: etag || undefined
      };
    })
    .filter((entry): entry is FileEntry => entry !== null);

  return {
    entries,
    isTruncated: firstTagValue(xml, "IsTruncated").toLowerCase() === "true",
    nextContinuationToken: firstTagValue(xml, "NextContinuationToken") || undefined
  };
}

function normalizeHeadersForSigning(url: URL, headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {
    host: url.host
  };

  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (lowerName === "authorization" || lowerName === "user-agent") {
      continue;
    }
    normalized[lowerName] = value.trim().replace(/\s+/g, " ");
  }

  return normalized;
}

function canonicalUri(url: URL): string {
  return url.pathname
    .split("/")
    .map((segment) => encodeRfc3986(decodeURIComponent(segment)))
    .join("/");
}

function canonicalQueryString(url: URL): string {
  return [...url.searchParams.entries()]
    .sort(([leftName, leftValue], [rightName, rightValue]) =>
      leftName === rightName ? leftValue.localeCompare(rightValue) : leftName.localeCompare(rightName)
    )
    .map(([name, value]) => `${encodeRfc3986(name)}=${encodeRfc3986(value)}`)
    .join("&");
}

async function getSigningKey(secretAccessKey: string, dateStamp: string, region: string): Promise<ArrayBuffer> {
  const dateKey = await hmacSha256(`AWS4${secretAccessKey}`, dateStamp);
  const dateRegionKey = await hmacSha256(dateKey, region);
  const dateRegionServiceKey = await hmacSha256(dateRegionKey, "s3");
  return hmacSha256(dateRegionServiceKey, "aws4_request");
}

async function sha256Hex(value: string | ArrayBuffer): Promise<string> {
  const bytes = toUint8Array(value);
  if (globalThis.crypto?.subtle) {
    return bytesToHex(await globalThis.crypto.subtle.digest("SHA-256", toArrayBuffer(bytes)));
  }

  const { createHash } = await import("crypto");
  return createHash("sha256").update(bytes).digest("hex");
}

async function hmacSha256(key: string | ArrayBuffer, value: string): Promise<ArrayBuffer> {
  const keyBytes = toUint8Array(key);
  const valueBytes = toUint8Array(value);
  if (globalThis.crypto?.subtle) {
    const cryptoKey = await globalThis.crypto.subtle.importKey(
      "raw",
      toArrayBuffer(keyBytes),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    return globalThis.crypto.subtle.sign("HMAC", cryptoKey, toArrayBuffer(valueBytes));
  }

  const { createHmac } = await import("crypto");
  const digest = createHmac("sha256", keyBytes).update(valueBytes).digest();
  return digest.buffer.slice(digest.byteOffset, digest.byteOffset + digest.byteLength);
}

function toUint8Array(value: string | ArrayBuffer): Uint8Array {
  if (typeof value === "string") {
    return new TextEncoder().encode(value);
  }
  return new Uint8Array(value);
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function bytesToHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function formatAmzDate(value: Date): string {
  return value.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function normalizedPrefix(prefix: string): string {
  return normalizeVaultPath(prefix);
}

function splitDecodedPath(path: string): string[] {
  return normalizeVaultPath(path)
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
}

function firstTagValue(xml: string, tagName: string): string {
  const regex = new RegExp(
    `<(?:\\w+:)?${tagName}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tagName}>`,
    "i"
  );
  const match = xml.match(regex);
  return match ? decodeXml(match[1].trim()) : "";
}

function matchAll(value: string, regex: RegExp): string[] {
  const matches: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) {
    matches.push(match[1]);
  }
  return matches;
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}
