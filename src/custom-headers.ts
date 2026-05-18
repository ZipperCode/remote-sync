const RESERVED_HEADER_NAMES = new Set(["authorization", "host", "content-length"]);

export function parseCustomHeaders(value: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const lines = value.split(/\r?\n/);

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line) {
      return;
    }

    const separatorIndex = line.indexOf(":");
    if (separatorIndex <= 0) {
      throw new Error(`第 ${index + 1} 行请求头格式错误，请使用 Header-Name: value`);
    }

    const name = line.slice(0, separatorIndex).trim();
    const headerValue = line.slice(separatorIndex + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) {
      throw new Error(`第 ${index + 1} 行请求头名称无效：${name}`);
    }

    if (isReservedHeader(name)) {
      throw new Error(`第 ${index + 1} 行请求头不允许覆盖内置头：${name}`);
    }

    headers[name] = headerValue;
  });

  return headers;
}

export function mergeCustomHeaders(
  customHeaders: Record<string, string>,
  builtInHeaders: Record<string, string>
): Record<string, string> {
  return {
    ...customHeaders,
    ...builtInHeaders
  };
}

function isReservedHeader(name: string): boolean {
  const lowerName = name.toLowerCase();
  return RESERVED_HEADER_NAMES.has(lowerName) || lowerName.startsWith("x-amz-");
}
