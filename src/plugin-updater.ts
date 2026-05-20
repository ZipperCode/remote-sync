const GITHUB_RELEASE_URL =
  "https://api.github.com/repos/ZipperCode/remote-sync/releases/latest";

const REQUIRED_ASSET_NAMES = ["manifest.json", "main.js", "styles.css"] as const;

type RequiredAssetName = (typeof REQUIRED_ASSET_NAMES)[number];

interface GithubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GithubReleaseResponse {
  tag_name?: string;
  assets?: GithubReleaseAsset[];
}

interface PluginManifestData {
  id?: string;
  version?: string;
}

export interface RequestLikeResponse {
  status: number;
  json?: unknown;
  arrayBuffer?: ArrayBuffer;
}

export type RequestLike = (request: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  throw?: boolean;
}) => Promise<RequestLikeResponse>;

export interface AvailablePluginUpdate {
  tag: string;
  version: string;
  files: Record<RequiredAssetName, ArrayBuffer>;
}

export interface PluginFileAdapter {
  exists(path: string): Promise<boolean>;
  readBinary(path: string): Promise<ArrayBuffer>;
  writeBinary(path: string, content: ArrayBuffer): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export type PluginUpdateCheckResult =
  | {
      status: "up-to-date";
    }
  | {
      status: "update-available";
      release: AvailablePluginUpdate;
    };

export async function checkForPluginUpdate(options: {
  currentVersion: string;
  pluginId: string;
  request: RequestLike;
}): Promise<PluginUpdateCheckResult> {
  const releaseResponse = await options.request({
    url: GITHUB_RELEASE_URL,
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json"
    },
    throw: false
  });

  if (releaseResponse.status !== 200) {
    throw new Error(`读取 GitHub Release 失败，HTTP ${releaseResponse.status}`);
  }

  const release = asGithubReleaseResponse(releaseResponse.json);
  const tag = assertTagName(release.tag_name);
  const version = tag.slice(1);
  if (compareVersions(version, options.currentVersion) <= 0) {
    return { status: "up-to-date" };
  }

  const assetMap = new Map(
    (release.assets ?? []).map((asset) => [asset.name, asset.browser_download_url])
  );
  const files = await downloadRequiredAssets(assetMap, options.request);
  const manifest = parseManifest(files["manifest.json"]);

  if (manifest.id !== options.pluginId) {
    throw new Error(`GitHub Release 插件 ID 不匹配：${manifest.id ?? "unknown"}`);
  }
  if (manifest.version !== version) {
    throw new Error(
      `GitHub Release 版本不一致：tag ${tag} 与 manifest ${manifest.version ?? "unknown"}`
    );
  }

  return {
    status: "update-available",
    release: {
      tag,
      version,
      files
    }
  };
}

export async function applyPluginUpdate(options: {
  pluginDir: string;
  release: AvailablePluginUpdate;
  adapter: PluginFileAdapter;
}): Promise<void> {
  await ensureDirectory(options.adapter, options.pluginDir);

  const previousFiles = new Map<string, ArrayBuffer>();
  for (const assetName of REQUIRED_ASSET_NAMES) {
    const path = joinPath(options.pluginDir, assetName);
    if (await options.adapter.exists(path)) {
      previousFiles.set(path, await options.adapter.readBinary(path));
    }
  }

  try {
    for (const assetName of REQUIRED_ASSET_NAMES) {
      await options.adapter.writeBinary(
        joinPath(options.pluginDir, assetName),
        options.release.files[assetName]
      );
    }
  } catch (error) {
    for (const [path, content] of previousFiles) {
      await options.adapter.writeBinary(path, content);
    }
    throw error;
  }
}

async function downloadRequiredAssets(
  assets: Map<string, string>,
  request: RequestLike
): Promise<Record<RequiredAssetName, ArrayBuffer>> {
  const files = {} as Record<RequiredAssetName, ArrayBuffer>;

  for (const assetName of REQUIRED_ASSET_NAMES) {
    const downloadUrl = assets.get(assetName);
    if (!downloadUrl) {
      throw new Error(`GitHub Release 缺少更新文件：${assetName}`);
    }

    const response = await request({
      url: downloadUrl,
      method: "GET",
      throw: false
    });
    if (response.status !== 200 || !response.arrayBuffer) {
      throw new Error(`下载更新文件失败：${assetName}，HTTP ${response.status}`);
    }

    files[assetName] = response.arrayBuffer;
  }

  return files;
}

function parseManifest(buffer: ArrayBuffer): PluginManifestData {
  const raw = new TextDecoder().decode(buffer);
  return JSON.parse(raw) as PluginManifestData;
}

function assertTagName(tagName: string | undefined): string {
  if (!tagName || !/^v\d+\.\d+\.\d+$/.test(tagName)) {
    throw new Error(`GitHub Release tag 格式无效：${tagName ?? "unknown"}`);
  }

  return tagName;
}

function asGithubReleaseResponse(value: unknown): GithubReleaseResponse {
  if (!value || typeof value !== "object") {
    throw new Error("GitHub Release 响应格式无效。");
  }

  return value as GithubReleaseResponse;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
  const total = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < total; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue - rightValue;
    }
  }

  return 0;
}

async function ensureDirectory(adapter: PluginFileAdapter, path: string): Promise<void> {
  const segments = path.split("/").filter(Boolean);
  let current = "";

  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    try {
      await adapter.mkdir(current);
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "Folder already exists." || error.message === "EEXIST")
      ) {
        continue;
      }
      throw error;
    }
  }
}

function joinPath(base: string, name: string): string {
  return `${base.replace(/\/+$/u, "")}/${name}`;
}
