import { requestUrl, RequestUrlResponse } from "obsidian";
import { withTimeout } from "./with-timeout";
import { mergeCustomHeaders } from "./custom-headers";
import { parentPath, splitPath, normalizeRemoteRoot, normalizeVaultPath } from "./path-utils";
import { SyncRemoteStore } from "./sync-engine";
import { FileEntry } from "./sync-planner";

export const WEBDAV_REQUEST_TIMEOUT_MS = 30000;

export interface WebDavRemoteOptions {
  baseUrl: string;
  username: string;
  password: string;
  remoteRoot: string;
  customHeaders?: Record<string, string>;
}

interface WebDavResponseEntry {
  href: string;
  isCollection: boolean;
  size: number;
  mtime: number;
  etag?: string;
}

export class WebDavRemote implements SyncRemoteStore {
  private readonly remoteRoot: string;

  constructor(private readonly options: WebDavRemoteOptions) {
    this.remoteRoot = normalizeRemoteRoot(options.remoteRoot);
  }

  async snapshot(): Promise<FileEntry[]> {
    const files: FileEntry[] = [];
    await this.walkFolder("", files);
    return files;
  }

  async readFile(path: string): Promise<ArrayBuffer> {
    const response = await this.request("GET", normalizeVaultPath(path));
    this.assertOk(response, [200, 206], `读取远程文件 ${path}`);
    return response.arrayBuffer;
  }

  async writeFile(path: string, content: ArrayBuffer): Promise<void> {
    const normalized = normalizeVaultPath(path);
    await this.ensureDirectory(parentPath(normalized));
    const response = await this.request("PUT", normalized, content);
    this.assertOk(response, [200, 201, 204], `写入远程文件 ${path}`);
  }

  async deleteFile(path: string): Promise<void> {
    const response = await this.request("DELETE", normalizeVaultPath(path));
    this.assertOk(response, [200, 202, 204, 404], `删除远程文件 ${path}`);
  }

  async testConnection(): Promise<void> {
    await this.ensureDirectory("");
    const response = await this.propfind("", "0");
    this.assertOk(response, [207], "测试 WebDAV 连接");
  }

  private async walkFolder(path: string, files: FileEntry[]): Promise<void> {
    const response = await this.propfind(path, "1");
    if (response.status === 404) {
      return;
    }
    this.assertOk(response, [207], `列出远程目录 ${path || this.remoteRoot || "/"}`);

    const entries = parseWebDavMultistatus(response.text);
    for (const entry of entries) {
      const relativePath = this.hrefToRelativePath(entry.href);
      if (relativePath === null || relativePath === normalizeVaultPath(path)) {
        continue;
      }

      if (entry.isCollection) {
        await this.walkFolder(relativePath, files);
        continue;
      }

      files.push({
        path: relativePath,
        type: "file",
        size: entry.size,
        mtime: entry.mtime,
        etag: entry.etag
      });
    }
  }

  private async ensureDirectory(path: string): Promise<void> {
    const segments = splitPath(path);
    const prefixes = [""];
    let current = "";

    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      prefixes.push(current);
    }

    for (const prefix of prefixes) {
      const response = await this.request("MKCOL", prefix);
      this.assertOk(response, [200, 201, 204, 301, 405, 409], `创建远程目录 ${prefix}`);
    }
  }

  private async propfind(path: string, depth: "0" | "1"): Promise<RequestUrlResponse> {
    return this.request("PROPFIND", normalizeVaultPath(path), PROPFIND_BODY, {
      Depth: depth,
      "Content-Type": "application/xml"
    });
  }

  private async request(
    method: string,
    path: string,
    body?: string | ArrayBuffer,
    extraHeaders: Record<string, string> = {}
  ): Promise<RequestUrlResponse> {
    return withTimeout(
      requestUrl({
        url: this.buildUrl(path),
        method,
        body,
        headers: mergeCustomHeaders(this.options.customHeaders ?? {}, {
          ...this.authHeaders(),
          ...extraHeaders
        }),
        throw: false
      }),
      WEBDAV_REQUEST_TIMEOUT_MS,
      `WebDAV ${method} ${path}`
    );
  }

  private buildUrl(path: string): string {
    const url = new URL(this.options.baseUrl);
    const baseSegments = splitDecodedPath(url.pathname);
    const targetSegments = [
      ...baseSegments,
      ...splitPath(this.remoteRoot),
      ...splitPath(path)
    ];

    url.pathname = `/${targetSegments.map(encodeURIComponent).join("/")}`;
    return url.toString();
  }

  private hrefToRelativePath(href: string): string | null {
    const url = new URL(href, this.options.baseUrl);
    const targetSegments = splitDecodedPath(url.pathname);
    const prefixSegments = [
      ...splitDecodedPath(new URL(this.options.baseUrl).pathname),
      ...splitPath(this.remoteRoot)
    ];

    if (!startsWithSegments(targetSegments, prefixSegments)) {
      return null;
    }

    return targetSegments.slice(prefixSegments.length).join("/");
  }

  private authHeaders(): Record<string, string> {
    if (!this.options.username) {
      return {};
    }

    return {
      Authorization: `Basic ${btoa(`${this.options.username}:${this.options.password}`)}`
    };
  }

  private assertOk(response: RequestUrlResponse, okStatuses: number[], action: string): void {
    if (!okStatuses.includes(response.status)) {
      throw new Error(`WebDAV 操作失败：${action}，HTTP ${response.status}`);
    }
  }
}

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype />
    <d:getcontentlength />
    <d:getlastmodified />
    <d:getetag />
  </d:prop>
</d:propfind>`;

export function parseWebDavMultistatus(xml: string): WebDavResponseEntry[] {
  return matchAll(xml, /<(?:\w+:)?response\b[^>]*>([\s\S]*?)<\/(?:\w+:)?response>/gi).map(
    (responseXml) => {
      const href = firstTagValue(responseXml, "href");
      const resourceType = firstTagValue(responseXml, "resourcetype");
      const length = Number.parseInt(firstTagValue(responseXml, "getcontentlength"), 10);
      const modified = Date.parse(firstTagValue(responseXml, "getlastmodified"));
      const etag = firstTagValue(responseXml, "getetag").replace(/^"|"$/g, "");

      return {
        href,
        isCollection: /<(?:\w+:)?collection\b/i.test(resourceType),
        size: Number.isFinite(length) ? length : 0,
        mtime: Number.isFinite(modified) ? modified : 0,
        etag: etag || undefined
      };
    }
  );
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

function splitDecodedPath(path: string): string[] {
  return normalizeVaultPath(path)
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
}

function startsWithSegments(value: string[], prefix: string[]): boolean {
  if (prefix.length > value.length) {
    return false;
  }

  return prefix.every((segment, index) => value[index] === segment);
}
