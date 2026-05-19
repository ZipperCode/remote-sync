export const REMOTE_SYNC_TRASH_DIR = ".remote-sync-trash";
export const DEFAULT_IGNORE_PATTERNS = [".obsidian/**", `${REMOTE_SYNC_TRASH_DIR}/**`];

const TEMPORARY_FILE_SUFFIXES = [".tmp", ".temp", ".swp", ".part", "~"];

export function normalizeVaultPath(path: string): string {
  const parts: string[] = [];
  const normalized = path.replace(/\\/g, "/");

  for (const rawPart of normalized.split("/")) {
    const part = rawPart.trim();
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }

  return parts.join("/");
}

export function normalizeRemoteRoot(root: string): string {
  return normalizeVaultPath(root);
}

export function joinRemotePath(remoteRoot: string, vaultPath = ""): string {
  const fullPath = normalizeVaultPath(
    [normalizeRemoteRoot(remoteRoot), normalizeVaultPath(vaultPath)]
      .filter(Boolean)
      .join("/")
  );

  if (!fullPath) {
    return "/";
  }

  return `/${fullPath.split("/").map(encodeURIComponent).join("/")}`;
}

export function shouldIgnorePath(
  path: string,
  customPatterns: string[],
  pluginId = "obsidian-webdav-sync"
): boolean {
  const normalized = normalizeVaultPath(path);
  if (!normalized) {
    return true;
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment.startsWith("."))) {
    return true;
  }

  if (normalized === `.obsidian/plugins/${pluginId}`) {
    return true;
  }
  if (normalized.startsWith(`.obsidian/plugins/${pluginId}/`)) {
    return true;
  }

  const fileName = segments[segments.length - 1].toLowerCase();
  if (
    TEMPORARY_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix)) ||
    fileName.startsWith("~$") ||
    fileName.startsWith(".~") ||
    fileName.startsWith("#")
  ) {
    return true;
  }

  return matchesIgnoreRules(normalized, customPatterns);
}

export function isRemoteSyncTrashPath(path: string): boolean {
  const normalized = normalizeVaultPath(path);
  return normalized === REMOTE_SYNC_TRASH_DIR || normalized.startsWith(`${REMOTE_SYNC_TRASH_DIR}/`);
}

export function parentPath(path: string): string {
  const normalized = normalizeVaultPath(path);
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
}

export function splitPath(path: string): string[] {
  return normalizeVaultPath(path).split("/").filter(Boolean);
}

function matchesIgnoreRules(path: string, customPatterns: string[]): boolean {
  let ignored = false;

  for (const rule of customPatterns) {
    const parsed = parseIgnoreRule(rule);
    if (!parsed) {
      continue;
    }
    if (matchesIgnoreRule(path, parsed.pattern)) {
      ignored = !parsed.negated;
    }
  }

  return ignored;
}

function parseIgnoreRule(rule: string): { negated: boolean; pattern: string } | null {
  const trimmed = rule.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const negated = trimmed.startsWith("!");
  const rawPattern = negated ? trimmed.slice(1).trim() : trimmed;
  if (!rawPattern || rawPattern.startsWith("#")) {
    return null;
  }

  return { negated, pattern: rawPattern };
}

function matchesIgnoreRule(path: string, pattern: string): boolean {
  const isDirectoryRule = pattern.endsWith("/");
  const normalizedPattern = normalizeVaultPath(pattern.replace(/\/+$/, ""));
  if (!normalizedPattern) {
    return false;
  }

  if (isDirectoryRule) {
    return path === normalizedPattern || path.startsWith(`${normalizedPattern}/`);
  }

  if (!normalizedPattern.includes("/")) {
    const fileName = path.split("/").pop() ?? path;
    if (matchesGlob(fileName, normalizedPattern)) {
      return true;
    }
  }

  const regex = new RegExp(`^${globToRegex(normalizedPattern)}$`);
  return regex.test(path);
}

function matchesGlob(path: string, pattern: string): boolean {
  const regex = new RegExp(`^${globToRegex(pattern)}$`);
  return regex.test(path);
}

function globToRegex(pattern: string): string {
  let output = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*" && next === "*") {
      output += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      output += "[^/]*";
      continue;
    }

    if (char === "?") {
      output += "[^/]";
      continue;
    }

    output += escapeRegex(char);
  }

  return output;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&");
}
