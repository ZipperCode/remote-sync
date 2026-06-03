export function sanitizeDeviceId(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "device";
}

export function buildConflictCopyPath(
  path: string,
  deviceId: string,
  timestamp: number
): string {
  const safeId = sanitizeDeviceId(deviceId);
  const marker = `.conflict-${safeId}-${timestamp}`;

  const slashIndex = path.lastIndexOf("/");
  const dir = slashIndex >= 0 ? path.slice(0, slashIndex + 1) : "";
  const name = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;

  // 仅当存在"非开头的点"时才视为扩展名分隔符，避免 dotfile（如 .keep）被误拆
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex > 0) {
    const stem = name.slice(0, dotIndex);
    const ext = name.slice(dotIndex);
    return `${dir}${stem}${marker}${ext}`;
  }

  return `${dir}${name}${marker}`;
}
