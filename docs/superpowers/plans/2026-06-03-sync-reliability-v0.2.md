# 同步可靠性重构 v0.2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 obsidian-webdav-sync 插件的同步永不卡死、卡住能自愈，多设备内容冲突能自动合并或安全留存，并通过定时轮询 + 启动同步 + 状态栏可观测性补齐"漏感知"问题。

**Architecture:** 分三层修复，按依赖顺序推进。① 网络请求层用 `Promise.race` 加 30s 超时，插件层给 `isSyncing` 加时间戳作僵尸自愈兜底（2 分钟阈值）。② 同步引擎层把"无法自动合并的文本冲突（text-overlap）"从死循环改为"远端版另存为 conflict 副本、本地保留、state 照常推进"。③ 插件层加 `onLayoutReady` 启动同步 + `registerInterval` 5 分钟轮询 + 状态栏显示待同步变更数/距上次同步。

**Tech Stack:** TypeScript, esbuild, Obsidian Plugin API (`requestUrl`/`registerInterval`/`onLayoutReady`), Vitest（`vi.useFakeTimers`）。

---

## 背景：代码现状关键事实（实现者必读）

实现前请先理解这些已确认的代码事实，它们决定了改动的精确注入点：

1. **两层同步标志**：
   - `RemoteSyncPlugin.isSyncing`（`main.ts:274`，内存属性）—— 手动同步和自动同步都检查它。
   - `AutoSyncController.syncInProgress`（`src/auto-sync-controller.ts:13`）—— 仅自动同步路径用。
   - `isSyncing` **不持久化**（`SyncStateData` 只有 `version/lastSyncTime/previousEntries`），所以重启 Obsidian 会自动回到 `false`。卡死场景是"不重启、当前会话反复点同步"。

2. **卡死真凶**：`SyncEngine.syncOnce`（`src/sync-engine.ts:90`）内部 `await this.remote.snapshot()` 等网络请求经由 `WebDavRemote.request`（`src/webdav-remote.ts:112`）/ `S3Remote.request`（`src/s3-remote.ts:94`）的 `requestUrl`，**无超时**。请求 hang 住 → `await` 永不返回 → `runSync` 的 `finally`（`main.ts:493`）永不执行 → `isSyncing` 永久 `true` → 后续手动同步全部命中 `main.ts:446` 的 `if (this.isSyncing) return false`。
   - **硬约束**：Obsidian 的 `requestUrl` **不支持 `AbortController`/`signal`**。超时只能用 `Promise.race` 让上层放弃等待，底层连接后台仍挂着（可接受）。

3. **冲突死循环真凶**：
   - `syncSafetyMode` 默认 `"balanced"`（`settings.ts:50`）。
   - `SyncEngine.defaultAction`（`src/sync-engine.ts:470`）对 `text-auto-merge`（`suggestedKind==="merge"`）返回 `"auto-merge"`，对 `binary`/`text-no-base`/`text-too-large` 在 `newer-wins` 下返回 `use-local`/`use-remote`。
   - **但 `text-overlap` 类型不被 `defaultAction` 处理 → 返回 `undefined`**。
   - 链路：文本三路合并失败 → `executeOperation` 的 merge 分支抛 `AutoMergeConflictError`（`src/sync-engine.ts:425`/`:438`）→ `syncOnce` 捕获后转 `createManualMergeConfirmation`（`:175`、`:510`）生成 `conflictType: "text-overlap"` 的 confirmation → 进 `pendingConfirmations`。
   - `syncOnce` 末尾 `if (summary.failures === 0 && summary.pendingConfirmations === 0)`（`:185`）才保存 state。**有 pending → 永不保存 state → 下次重新规划又是同一冲突 → 死循环卡住**。自动同步 `confirmManually: false`（`main.ts:434`）也不弹窗，用户无出口。

4. **漏感知真凶**：`main.ts`/`settings.ts` **无任何 `setInterval`/`registerInterval`**（已 Grep 确认）。`registerAutoSync`（`main.ts:538`）的 `create/modify/delete/rename` 四个 vault 事件**都已注册**（`:553-571`），只监听本设备变化，无法感知其他设备的远端改动。`AUTO_SYNC_DEBOUNCE_MS = 3000`（3 秒，不是主因）。

5. **设备标识**：无持久化 deviceId。`vault.getName()` 可用（`settings.ts:311` 已引用），但同名 vault 在多设备上会撞名。需要一个稳定的本地 deviceId。

6. **测试基础设施**：Vitest，`test/auto-sync-controller.test.ts` 用 `vi.useFakeTimers()` + mock `sync`。`test/sync-state-store.test.ts`、`test/webdav-remote.test.ts` 存在。运行命令：`npm test`（vitest）。

---

## 文件结构（改动地图）

| 文件 | 责任 | 改动类型 |
|---|---|---|
| `src/with-timeout.ts` | **新增**。提供 `withTimeout` 工具 + `TimeoutError`，用 `Promise.race` 给任意 Promise 加超时 | Create |
| `test/with-timeout.test.ts` | **新增**。`withTimeout` 的单元测试 | Create |
| `src/webdav-remote.ts` | `request` 私有方法用 `withTimeout` 包裹 `requestUrl`（`:112-128`） | Modify |
| `src/s3-remote.ts` | `request` 私有方法用 `withTimeout` 包裹 `requestUrl`（`:94-114`） | Modify |
| `src/device-id.ts` | **新增**。生成/读取稳定 deviceId，构造冲突副本路径 | Create |
| `test/device-id.test.ts` | **新增**。deviceId 与冲突副本命名测试 | Create |
| `src/sync-engine.ts` | merge 失败时不再无脑抛错回 pending；改为"远端另存 conflict 副本 + 本地保留 + 标记已处理"，使 state 能推进 | Modify |
| `test/sync-engine.test.ts` | **新增**（当前无此测试文件）。覆盖 text-overlap 冲突收尾 | Create |
| `main.ts` | `isSyncing` 改为带时间戳的僵尸自愈；`registerAutoSync` 加启动同步 + 5 分钟轮询；状态栏加待同步计数/距上次同步 | Modify |

---

## Task 1：新增 `withTimeout` 工具（痛点① 地基）

**Files:**
- Create: `src/with-timeout.ts`
- Test: `test/with-timeout.test.ts`

- [ ] **Step 1: 写失败测试**

Create `test/with-timeout.test.ts`：

```typescript
import { afterEach, describe, expect, test, vi } from "vitest";
import { TimeoutError, withTimeout } from "../src/with-timeout";

describe("withTimeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test("resolves with the value when the promise settles before the timeout", async () => {
    vi.useFakeTimers();
    const promise = withTimeout(Promise.resolve("ok"), 1000, "test-op");
    await expect(promise).resolves.toBe("ok");
  });

  test("rejects with TimeoutError when the promise exceeds the timeout", async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {
      /* never settles */
    });
    const promise = withTimeout(never, 1000, "snapshot");

    const assertion = expect(promise).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  test("TimeoutError message includes the operation label", async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {
      /* never settles */
    });
    const promise = withTimeout(never, 500, "PROPFIND /notes");

    const assertion = expect(promise).rejects.toThrow("PROPFIND /notes");
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  test("clears the timer when the promise resolves to avoid dangling timers", async () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    await withTimeout(Promise.resolve(42), 1000, "op");
    expect(clearSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- with-timeout`
Expected: FAIL，报 `Cannot find module '../src/with-timeout'` 或 `withTimeout is not a function`。

- [ ] **Step 3: 写最小实现**

Create `src/with-timeout.ts`：

```typescript
export class TimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`操作超时（${label}，超过 ${timeoutMs}ms）`);
    this.name = "TimeoutError";
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(label, timeoutMs));
    }, timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- with-timeout`
Expected: PASS，4 个测试全绿。

- [ ] **Step 5: 提交**

```bash
git add src/with-timeout.ts test/with-timeout.test.ts
git commit -m "feat: add withTimeout utility for request timeout (Promise.race)"
```

---

## Task 2：WebDAV 请求层接入超时（痛点①）

**Files:**
- Modify: `src/webdav-remote.ts:112-128`（`request` 方法）

**约定常量**：单请求超时 = **30000ms（30 秒）**。在文件顶部定义并导出，便于测试和复用。

- [ ] **Step 1: 在文件顶部加超时常量**

查看 `src/webdav-remote.ts:1`，当前第一行是：

```typescript
import { requestUrl, RequestUrlResponse } from "obsidian";
```

在该 import 之后、其余代码之前，插入：

```typescript
import { withTimeout } from "./with-timeout";

export const WEBDAV_REQUEST_TIMEOUT_MS = 30000;
```

- [ ] **Step 2: 用 withTimeout 包裹 requestUrl**

定位 `src/webdav-remote.ts:112-128` 的 `request` 方法，当前实现：

```typescript
  private async request(
    method: string,
    path: string,
    body?: string | ArrayBuffer,
    extraHeaders: Record<string, string> = {}
  ): Promise<RequestUrlResponse> {
    return requestUrl({
      url: this.buildUrl(path),
      method,
      body,
      headers: mergeCustomHeaders(this.options.customHeaders ?? {}, {
        ...this.authHeaders(),
        ...extraHeaders
      }),
      throw: false
    });
  }
```

替换为：

```typescript
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
```

- [ ] **Step 3: 运行全量测试确认无回归**

Run: `npm test -- webdav`
Expected: PASS，现有 `test/webdav-remote.test.ts` 全部仍绿（未改变请求行为，仅加超时包裹）。

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无 `webdav-remote.ts` 相关错误。

- [ ] **Step 5: 提交**

```bash
git add src/webdav-remote.ts
git commit -m "feat: add 30s timeout to WebDAV requests"
```

---

## Task 3：S3 请求层接入超时（痛点①）

**Files:**
- Modify: `src/s3-remote.ts:94-114`（`request` 方法）

- [ ] **Step 1: 加导入与常量**

查看 `src/s3-remote.ts` 顶部 import 区。在现有 import 之后插入（与 WebDAV 共用同一个 `withTimeout`）：

```typescript
import { withTimeout } from "./with-timeout";

export const S3_REQUEST_TIMEOUT_MS = 30000;
```

> 注意：若 `s3-remote.ts` 已 import 了 `./with-timeout` 中其它符号，则合并到同一行；否则新增一行。`S3_REQUEST_TIMEOUT_MS` 放在文件内既有顶层常量附近即可。

- [ ] **Step 2: 用 withTimeout 包裹 requestUrl**

定位 `src/s3-remote.ts:94-114` 的 `request` 方法，当前实现：

```typescript
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
```

把末尾的 `return requestUrl({...})` 替换为：

```typescript
    return withTimeout(
      requestUrl({
        url,
        method,
        body,
        headers: signedHeaders,
        throw: false
      }),
      S3_REQUEST_TIMEOUT_MS,
      `S3 ${method} ${path}`
    );
```

（方法前半段计算 `url`/`headers`/`signedHeaders` 的代码保持不变。）

- [ ] **Step 3: 类型检查 + 全量测试**

Run: `npx tsc --noEmit && npm test`
Expected: 无类型错误；全部测试通过。

- [ ] **Step 4: 提交**

```bash
git add src/s3-remote.ts
git commit -m "feat: add 30s timeout to S3 requests"
```

---

## Task 4：isSyncing 僵尸自愈兜底（痛点①）

**Files:**
- Modify: `main.ts`（`isSyncing` 属性 `:274`、`runSync` 入口 `:446-451`、`finally` `:493-495`）

**设计：** 把 `isSyncing: boolean` 替换为时间戳语义。`runSync` 入口检查"若已在同步中，但开始时间超过 `STALE_SYNC_THRESHOLD_MS`（2 分钟），视为僵尸，强制放行并重置"。正常情况下 30s 请求超时会让同步快速结束，此兜底几乎不触发，是"超时机制万一失效"的最后保险。

- [ ] **Step 1: 改属性声明**

定位 `main.ts:273-275`：

```typescript
  private autoSyncController: AutoSyncController | null = null;
  private isSyncing = false;
  private isUpdatingPlugin = false;
```

替换为：

```typescript
  private autoSyncController: AutoSyncController | null = null;
  private syncStartedAt: number | null = null;
  private isUpdatingPlugin = false;
```

- [ ] **Step 2: 在文件顶部加僵尸阈值常量**

定位 `main.ts:27` 的 `interface PluginData` 之前（import 区之后）。插入：

```typescript
const STALE_SYNC_THRESHOLD_MS = 2 * 60 * 1000;
```

- [ ] **Step 3: 改 `runSync` 的"已在同步中"判断**

定位 `main.ts:446-451`，当前：

```typescript
    if (this.isSyncing) {
      if (options.showBusyNotice) {
        new Notice("同步正在进行中。");
      }
      return false;
    }
```

替换为：

```typescript
    if (this.syncStartedAt !== null) {
      const elapsed = Date.now() - this.syncStartedAt;
      if (elapsed < STALE_SYNC_THRESHOLD_MS) {
        if (options.showBusyNotice) {
          new Notice("同步正在进行中。");
        }
        return false;
      }
      console.warn("[Remote Sync] Detected a stale sync, forcing reset.", {
        elapsedMs: elapsed,
        threshold: STALE_SYNC_THRESHOLD_MS
      });
      this.syncStartedAt = null;
    }
```

- [ ] **Step 4: 改设置标志处**

定位 `main.ts:467`：

```typescript
    this.isSyncing = true;
    this.updateStatus("同步中...");
```

替换为：

```typescript
    this.syncStartedAt = Date.now();
    this.updateStatus("同步中...");
```

- [ ] **Step 5: 改 finally 处**

定位 `main.ts:493-495`：

```typescript
    } finally {
      this.isSyncing = false;
    }
```

替换为：

```typescript
    } finally {
      this.syncStartedAt = null;
    }
```

- [ ] **Step 6: 改 `syncAutomatically` 的 isSyncing 引用**

定位 `main.ts:426-429`：

```typescript
  private async syncAutomatically(): Promise<AutoSyncRunResult> {
    if (this.isSyncing) {
      return "busy";
    }
```

替换为：

```typescript
  private async syncAutomatically(): Promise<AutoSyncRunResult> {
    if (this.syncStartedAt !== null && Date.now() - this.syncStartedAt < STALE_SYNC_THRESHOLD_MS) {
      return "busy";
    }
```

> 说明：自动同步路径下，僵尸的真正放行交给 `runSync` 入口（Step 3）统一处理。这里只是避免正常进行中的同步被并发触发。

- [ ] **Step 7: 检查其它 isSyncing 引用**

Run: `npx tsc --noEmit`
Expected: 若仍有 `this.isSyncing` 残留引用会报 `Property 'isSyncing' does not exist`。逐一定位并改为基于 `this.syncStartedAt`。日志对象里出现的 `isSyncing: this.isSyncing`（如 `main.ts:458`、`:488`）改为 `syncStartedAt: this.syncStartedAt`。

- [ ] **Step 8: 全量测试**

Run: `npm test`
Expected: PASS。

- [ ] **Step 9: 提交**

```bash
git add main.ts
git commit -m "feat: self-heal stale sync via timestamp guard (2min threshold)"
```

---

## Task 5：新增 deviceId 与冲突副本命名（痛点② 前置）

**Files:**
- Create: `src/device-id.ts`
- Test: `test/device-id.test.ts`

**设计：** deviceId 持久化在插件数据里（与 settings 同级）。冲突副本路径形如 `foo.conflict-<deviceId>-<timestamp>.md`，与原文件同目录，保留原扩展名。deviceId 在调用方（`main.ts`）首次生成后通过 `SyncEngineOptions` 传入引擎。

- [ ] **Step 1: 写失败测试**

Create `test/device-id.test.ts`：

```typescript
import { describe, expect, test } from "vitest";
import { buildConflictCopyPath } from "../src/device-id";

describe("buildConflictCopyPath", () => {
  test("inserts conflict marker before the extension in the same directory", () => {
    const result = buildConflictCopyPath("notes/todo.md", "laptop", 1717000000000);
    expect(result).toBe("notes/todo.conflict-laptop-1717000000000.md");
  });

  test("handles files at vault root", () => {
    const result = buildConflictCopyPath("todo.md", "phone", 1717000000000);
    expect(result).toBe("todo.conflict-phone-1717000000000.md");
  });

  test("handles files without extension", () => {
    const result = buildConflictCopyPath("notes/draft", "laptop", 1717000000000);
    expect(result).toBe("notes/draft.conflict-laptop-1717000000000");
  });

  test("handles dotfiles by appending the marker", () => {
    const result = buildConflictCopyPath("notes/.keep", "laptop", 1717000000000);
    expect(result).toBe("notes/.keep.conflict-laptop-1717000000000");
  });

  test("sanitizes unsafe characters in deviceId", () => {
    const result = buildConflictCopyPath("a.md", "my/device name", 1717000000000);
    expect(result).toBe("a.conflict-my-device-name-1717000000000.md");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm test -- device-id`
Expected: FAIL，`Cannot find module '../src/device-id'`。

- [ ] **Step 3: 写最小实现**

Create `src/device-id.ts`：

```typescript
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm test -- device-id`
Expected: PASS，5 个测试全绿。

- [ ] **Step 5: 提交**

```bash
git add src/device-id.ts test/device-id.test.ts
git commit -m "feat: add deviceId sanitizer and conflict copy path builder"
```

---

## Task 6：引擎层 — text-overlap 冲突安全收尾（痛点②核心）

**Files:**
- Modify: `src/sync-engine.ts`（`SyncEngineOptions` `:34-40`、`executeOperation` merge 分支 `:425-466`、新增私有方法）
- Test: `test/sync-engine.test.ts`（新建）

**设计：** 当 `mergeTextContent` 返回 `ok:false`（文本三路合并存在重叠冲突）时，**不再抛 `AutoMergeConflictError` 回到 pending 死循环**。改为：
1. 把**远端版本内容**写到 `buildConflictCopyPath(path, deviceId, mtime)` 的 conflict 副本（落在本地 vault，用户可见）。
2. 把**本地版本上传到远端**（本地视为权威，远端原内容已被救进 conflict 副本）。
3. 该 operation 计为成功（不进 pending），使 `syncOnce` 末尾的 `pendingConfirmations === 0` 成立，**state 正常推进**，打破死循环。

> 仅 `text-auto-merge`（有 base 的文本）会走 merge 分支。`binary`/`text-no-base`/`text-too-large` 仍由 `defaultAction` 的 `newer-wins` 处理，不受本 Task 影响。

- [ ] **Step 1: 给 SyncEngineOptions 加 deviceId**

定位 `src/sync-engine.ts:34-40`：

```typescript
export interface SyncEngineOptions {
  ignorePatterns: string[];
  pluginId?: string;
  syncSafetyMode?: SyncSafetyMode;
  maxAutoDeleteRatio?: number;
  nonMergeableConflictPolicy?: NonMergeableConflictPolicy;
}
```

替换为：

```typescript
export interface SyncEngineOptions {
  ignorePatterns: string[];
  pluginId?: string;
  syncSafetyMode?: SyncSafetyMode;
  maxAutoDeleteRatio?: number;
  nonMergeableConflictPolicy?: NonMergeableConflictPolicy;
  deviceId?: string;
}
```

- [ ] **Step 2: 加 import**

定位 `src/sync-engine.ts:12`（`import { decodeTextContent, ... } from "./text-merge";` 一行）。在其后插入：

```typescript
import { buildConflictCopyPath } from "./device-id";
```

- [ ] **Step 3: 写失败测试**

Create `test/sync-engine.test.ts`：

```typescript
import { describe, expect, test } from "vitest";
import { SyncEngine, SyncLocalStore, SyncRemoteStore } from "../src/sync-engine";
import { SyncStateStore, SyncStateStoreAdapter } from "../src/sync-state-store";
import { FileEntry } from "../src/sync-types";
import { encodeTextContent } from "../src/text-merge";

function entry(path: string, content: string, mtime: number): FileEntry {
  return { path, type: "file", size: encodeTextContent(content).byteLength, mtime };
}

class MemoryStore implements SyncLocalStore, SyncRemoteStore {
  files = new Map<string, { content: string; mtime: number }>();

  constructor(initial: Record<string, { content: string; mtime: number }> = {}) {
    for (const [path, value] of Object.entries(initial)) {
      this.files.set(path, value);
    }
  }

  async snapshot(): Promise<FileEntry[]> {
    return [...this.files.entries()].map(([path, v]) => entry(path, v.content, v.mtime));
  }
  async readFile(path: string): Promise<ArrayBuffer> {
    const v = this.files.get(path);
    if (!v) throw new Error(`missing ${path}`);
    return encodeTextContent(v.content);
  }
  async writeFile(path: string, content: ArrayBuffer): Promise<void> {
    this.files.set(path, {
      content: new TextDecoder().decode(new Uint8Array(content)),
      mtime: 1
    });
  }
  async deleteFile(path: string): Promise<void> {
    this.files.delete(path);
  }
}

class MemoryStateAdapter implements SyncStateStoreAdapter {
  value: string | null;
  constructor(value: string | null) {
    this.value = value;
  }
  async read(): Promise<string | null> {
    return this.value;
  }
  async write(value: string): Promise<void> {
    this.value = value;
  }
}

describe("SyncEngine text-overlap conflict resolution", () => {
  test("on unmergeable text conflict: saves remote as conflict copy, keeps local, advances state", async () => {
    // 共同祖先："base"。本地改成 "local edit"，远端改成 "remote edit"（重叠冲突）。
    const base = "line1\nline2\n";
    const localContent = "line1\nLOCAL\n";
    const remoteContent = "line1\nREMOTE\n";

    const previousState = JSON.stringify({
      version: 1,
      lastSyncTime: 1000,
      previousEntries: [
        {
          path: "note.md",
          local: entry("note.md", base, 1000),
          remote: entry("note.md", base, 1000),
          mergeBase: { source: "previous-sync-state", content: base }
        }
      ]
    });

    const local = new MemoryStore({ "note.md": { content: localContent, mtime: 2000 } });
    const remote = new MemoryStore({ "note.md": { content: remoteContent, mtime: 3000 } });
    const stateStore = new SyncStateStore(new MemoryStateAdapter(previousState));

    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      syncSafetyMode: "balanced",
      deviceId: "laptop"
    });

    const result = await engine.syncOnce([]);

    // 不再有未决冲突（死循环已打破）
    expect(result.summary.pendingConfirmations).toBe(0);
    expect(result.summary.failures).toBe(0);

    // 本地保留了本地版本
    expect(local.files.get("note.md")?.content).toBe(localContent);

    // 远端原内容被救到 conflict 副本（落在本地）
    const conflictKeys = [...local.files.keys()].filter((k) => k.includes(".conflict-laptop-"));
    expect(conflictKeys).toHaveLength(1);
    expect(local.files.get(conflictKeys[0])?.content).toBe(remoteContent);

    // 远端被本地版本覆盖（本地权威）
    expect(remote.files.get("note.md")?.content).toBe(localContent);
  });
});
```

- [ ] **Step 4: 运行测试确认失败**

Run: `npm test -- sync-engine`
Expected: FAIL。当前 merge 失败会抛 `AutoMergeConflictError` → 转 pending，`pendingConfirmations` 会是 1，断言 `toBe(0)` 失败。

- [ ] **Step 5: 改 executeOperation 的 merge 分支**

定位 `src/sync-engine.ts:425-466` 的 `case "merge":` 块。当前实现（关键部分）：

```typescript
      case "merge": {
        if (!operation.local || !operation.remote || !operation.previous?.mergeBase) {
          throw new AutoMergeConflictError();
        }

        let mergeResult: ReturnType<typeof mergeTextContent>;
        const [localContent, remoteContent] = await this.runStage(operation.path, "merge", () =>
          Promise.all([
            this.local.readFile(operation.path),
            this.remote.readFile(operation.path)
          ])
        );
        mergeResult = mergeTextContent(
          operation.previous.mergeBase.content,
          decodeTextContent(localContent),
          decodeTextContent(remoteContent)
        );

        if (!mergeResult.ok) {
          throw new AutoMergeConflictError();
        }

        let backups = 0;
        backups += await this.backupLocalFile(operation.path, operation.local, trashBatch);
        backups += await this.backupRemoteFileToLocal(operation.path, operation.remote, trashBatch);

        operation.merge = {
          baseSource: operation.previous.mergeBase.source,
          mergedContent: mergeResult.mergedContent
        };

        const mergedBuffer = encodeTextContent(mergeResult.mergedContent);
        const mergedEntry = this.createMergedEntry(operation, mergedBuffer.byteLength);
        await this.runStage(operation.path, "merge", () =>
          Promise.all([
            this.local.writeFile(operation.path, mergedBuffer, mergedEntry),
            this.remote.writeFile(operation.path, mergedBuffer, mergedEntry)
          ])
        );
        return backups;
      }
```

把其中 `if (!mergeResult.ok) { throw new AutoMergeConflictError(); }` 这一段替换为：

```typescript
        if (!mergeResult.ok) {
          return await this.resolveUnmergeableTextConflict(
            operation,
            remoteContent,
            trashBatch
          );
        }
```

（merge 分支的其余代码——成功路径——保持不变。）

- [ ] **Step 6: 新增 resolveUnmergeableTextConflict 私有方法**

在 `src/sync-engine.ts` 的 `createMergedEntry` 方法（`:523-530`）之后插入新方法：

```typescript
  private async resolveUnmergeableTextConflict(
    operation: SyncOperation,
    remoteContent: ArrayBuffer,
    trashBatch: string
  ): Promise<number> {
    if (!operation.local || !operation.remote) {
      throw new AutoMergeConflictError();
    }

    let backups = 0;
    // 远端原内容备份到隐藏目录（兜底）
    backups += await this.backupRemoteFileToLocal(operation.path, operation.remote, trashBatch);

    // 远端版本另存为用户可见的 conflict 副本（本地保留原文件不动）
    const conflictPath = buildConflictCopyPath(
      operation.path,
      this.options.deviceId ?? "device",
      operation.remote.mtime
    );
    const conflictEntry: FileEntry = {
      path: conflictPath,
      type: "file",
      size: remoteContent.byteLength,
      mtime: operation.remote.mtime
    };
    await this.runStage(conflictPath, "merge", () =>
      this.local.writeFile(conflictPath, remoteContent, conflictEntry)
    );

    // 本地版本视为权威，上传覆盖远端
    const localContent = await this.runStage(operation.path, "upload", () =>
      this.local.readFile(operation.path)
    );
    await this.runStage(operation.path, "upload", () =>
      this.remote.writeFile(operation.path, localContent, operation.local)
    );

    return backups;
  }
```

> 说明：返回 `backups` 计数，与 merge 成功分支一致。`incrementSummary` 仍按 `kind: "merge"` 把这次计入 `summary.merged`（语义为"冲突已收敛"），不会进 pending。

- [ ] **Step 7: 运行测试确认通过**

Run: `npm test -- sync-engine`
Expected: PASS。

- [ ] **Step 8: 全量测试 + 类型检查**

Run: `npx tsc --noEmit && npm test`
Expected: 无类型错误；全部通过（含原有 sync-state-store / webdav 测试）。

- [ ] **Step 9: 提交**

```bash
git add src/sync-engine.ts test/sync-engine.test.ts
git commit -m "feat: resolve unmergeable text conflicts via conflict copy instead of deadlock"
```

---

## Task 7：插件层注入 deviceId（衔接 Task 5/6）

**Files:**
- Modify: `main.ts`（`PluginData` 接口 `:27-30`、`createEngine` `:574-587`、新增 deviceId 读写）

**设计：** deviceId 持久化在插件数据里。首次加载时若无则生成（用时间戳 + 随机片段），之后稳定不变。`createEngine` 把它放进 `SyncEngineOptions.deviceId`。

> 注意：本环境脚本中 `Math.random()`/`Date.now()` 在 workflow 脚本里受限，但**这是插件运行时代码（main.ts），不是 workflow 脚本**，可正常使用 `Date.now()`/`Math.random()`。

- [ ] **Step 1: 扩展 PluginData 接口**

定位 `main.ts:27-30`：

```typescript
interface PluginData {
  settings?: Partial<RemoteSyncSettings>;
  syncState?: unknown;
}
```

替换为：

```typescript
interface PluginData {
  settings?: Partial<RemoteSyncSettings>;
  syncState?: unknown;
  deviceId?: string;
}
```

- [ ] **Step 2: 加 deviceId 属性与懒加载方法**

定位 `main.ts:270-271`（类字段区开头）：

```typescript
  settings: RemoteSyncSettings = { ...DEFAULT_SETTINGS };
  private statusBarItemEl: HTMLElement | null = null;
```

在其后插入字段：

```typescript
  private deviceId = "";
```

然后在 `readPluginData` 方法（`main.ts:679-681`）之后插入：

```typescript
  private async ensureDeviceId(): Promise<string> {
    if (this.deviceId) {
      return this.deviceId;
    }
    const data = await this.readPluginData();
    if (typeof data.deviceId === "string" && data.deviceId.length > 0) {
      this.deviceId = data.deviceId;
      return this.deviceId;
    }
    const generated = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.deviceId = generated;
    await this.saveData({ ...data, deviceId: generated });
    return generated;
  }
```

- [ ] **Step 3: 在 onload 里初始化 deviceId**

定位 `main.ts:278`（`onload` 内 `await this.loadSettings();` 之后）：

```typescript
    await this.loadSettings();
```

在其后插入：

```typescript
    await this.ensureDeviceId();
```

- [ ] **Step 4: createEngine 注入 deviceId**

定位 `main.ts:574-587` 的 `createEngine`：

```typescript
  private createEngine(): SyncEngine {
    return new SyncEngine(
      new ObsidianLocalStore(this.app, this.settings.ignorePatterns, this.manifest.id),
      this.createRemote(),
```

该方法完整体（`main.ts:575-587`）当前为：

```typescript
  private createEngine(): SyncEngine {
    return new SyncEngine(
      new ObsidianLocalStore(this.app, this.settings.ignorePatterns, this.manifest.id),
      this.createRemote(),
      new SyncStateStore(new PluginSyncStateAdapter(this)),
      {
        ignorePatterns: this.settings.ignorePatterns,
        pluginId: this.manifest.id,
        syncSafetyMode: this.settings.syncSafetyMode,
        maxAutoDeleteRatio: this.settings.maxAutoDeleteRatio,
        nonMergeableConflictPolicy: this.settings.nonMergeableConflictPolicy
      }
    );
  }
```

把第 4 个构造参数（`SyncEngineOptions` 对象字面量）的最后一行 `nonMergeableConflictPolicy: this.settings.nonMergeableConflictPolicy` 加上尾逗号并追加 `deviceId`：

```typescript
      {
        ignorePatterns: this.settings.ignorePatterns,
        pluginId: this.manifest.id,
        syncSafetyMode: this.settings.syncSafetyMode,
        maxAutoDeleteRatio: this.settings.maxAutoDeleteRatio,
        nonMergeableConflictPolicy: this.settings.nonMergeableConflictPolicy,
        deviceId: this.deviceId
      }
```

- [ ] **Step 5: 类型检查 + 全量测试**

Run: `npx tsc --noEmit && npm test`
Expected: 无类型错误；全部通过。

- [ ] **Step 6: 提交**

```bash
git add main.ts
git commit -m "feat: persist and inject deviceId into sync engine"
```

---

## Task 8：启动同步 + 定时轮询（痛点③）

**Files:**
- Modify: `main.ts`（`registerAutoSync` `:538-573`）

**设计：** 在 `onLayoutReady` 回调里（已存在，`:546`）——四个 vault 事件注册之后——追加：① 立即触发一次启动同步；② `registerInterval` 每 5 分钟轮询一次。两者都调 `syncAutomatically`（静默、不弹窗），并复用 Task 4 的僵尸自愈：若上次同步卡住超 2 分钟，下次轮询/启动同步会经 `runSync` 入口强制放行。

- [ ] **Step 1: 加轮询间隔常量**

定位 `main.ts` 顶部 Task 4 添加的 `STALE_SYNC_THRESHOLD_MS` 常量旁。插入：

```typescript
const AUTO_SYNC_POLL_INTERVAL_MS = 5 * 60 * 1000;
```

- [ ] **Step 2: 在 onLayoutReady 回调里加启动同步 + 轮询**

定位 `main.ts:546-572` 的 `this.app.workspace.onLayoutReady(() => { ... })` 块。当前末尾是第 4 个 `registerEvent`（rename）之后、回调闭合 `});` 之前。在 rename 的 `registerEvent(...)` 之后、回调闭合之前，插入：

```typescript
      // 启动同步：拉取其它设备在本设备离线期间的远端改动
      void this.syncAutomatically();

      // 定时轮询：补齐"本地无文件事件但远端已变"的漏感知场景
      this.registerInterval(
        window.setInterval(() => {
          void this.syncAutomatically();
        }, AUTO_SYNC_POLL_INTERVAL_MS)
      );
```

> 说明：`registerInterval` 是 Obsidian `Plugin` 基类方法，会在插件卸载时自动 `clearInterval`，无需手动清理。`window.setInterval` 返回 number，符合 `registerInterval(id: number)` 签名。

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无错误。`registerInterval`/`window.setInterval` 类型正确。

- [ ] **Step 4: 全量测试**

Run: `npm test`
Expected: PASS（本 Task 改的是插件装配逻辑，无独立单测；由现有测试保证未破坏其它模块）。

- [ ] **Step 5: 提交**

```bash
git add main.ts
git commit -m "feat: add startup sync and 5-minute polling for remote change detection"
```

---

## Task 9：状态栏可观测性 — 待同步变更数 + 距上次同步（痛点④）

**Files:**
- Modify: `src/auto-sync-controller.ts`（暴露待处理计数）、`test/auto-sync-controller.test.ts`（加测试）、`main.ts`（状态栏渲染）

**设计：** 用户反复觉得"没触发"，根因是状态栏只显示"空闲/同步中/成功"，无法看到"变更已被探测、正在 debounce"。本 Task 让 `AutoSyncController` 暴露"自上次同步以来探测到的变更路径数"，并在 `handleVaultChange`/`handleVaultRename` 时回调通知插件刷新状态栏。

- [ ] **Step 1: 给 AutoSyncControllerOptions 加 onPendingChange 回调**

定位 `src/auto-sync-controller.ts:5-9`：

```typescript
export interface AutoSyncControllerOptions {
  sync: () => Promise<void | AutoSyncRunResult>;
  shouldIgnorePath: (path: string) => boolean;
  debounceMs?: number;
}
```

替换为：

```typescript
export interface AutoSyncControllerOptions {
  sync: () => Promise<void | AutoSyncRunResult>;
  shouldIgnorePath: (path: string) => boolean;
  debounceMs?: number;
  onPendingChange?: (pendingCount: number) => void;
}
```

- [ ] **Step 2: 写失败测试**

在 `test/auto-sync-controller.test.ts` 的 `describe` 块内末尾（`:80` 之前，最后一个 `test` 之后）追加：

```typescript
  test("reports pending change count via onPendingChange and resets after sync", async () => {
    vi.useFakeTimers();
    const counts: number[] = [];
    const sync = vi.fn().mockResolvedValue(undefined);
    const controller = new AutoSyncController({
      sync,
      shouldIgnorePath: () => false,
      onPendingChange: (n) => counts.push(n)
    });

    controller.handleVaultChange("a.md");
    controller.handleVaultChange("b.md");
    controller.handleVaultRename("c.md", "old.md");

    // 探测到 3 个不同路径的变更
    expect(counts[counts.length - 1]).toBe(3);

    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS);
    expect(sync).toHaveBeenCalledTimes(1);

    // 同步发起后计数归零
    expect(counts[counts.length - 1]).toBe(0);
  });

  test("ignored paths do not increase pending count", async () => {
    vi.useFakeTimers();
    const counts: number[] = [];
    const sync = vi.fn().mockResolvedValue(undefined);
    const controller = new AutoSyncController({
      sync,
      shouldIgnorePath: (p) => p.startsWith(".obsidian/"),
      onPendingChange: (n) => counts.push(n)
    });

    controller.handleVaultChange(".obsidian/workspace.json");
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_DEBOUNCE_MS);

    expect(counts).toEqual([]);
    expect(sync).not.toHaveBeenCalled();
  });
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npm test -- auto-sync-controller`
Expected: FAIL，`onPendingChange` 未被调用 / `counts` 为空。

- [ ] **Step 4: 实现待处理计数**

定位 `src/auto-sync-controller.ts:10-83` 的 `AutoSyncController` 类。

(a) 在私有字段区（`:11-14`，`pendingAfterCurrentSync = false;` 之后）加：

```typescript
  private pendingPaths = new Set<string>();
```

(b) 改 `handleVaultChange`（`:19-25`）：

```typescript
  handleVaultChange(path: string): void {
    if (this.options.shouldIgnorePath(path)) {
      return;
    }

    this.pendingPaths.add(path);
    this.options.onPendingChange?.(this.pendingPaths.size);
    this.requestSync();
  }
```

(c) 改 `handleVaultRename`（`:27-33`）：

```typescript
  handleVaultRename(path: string, oldPath: string): void {
    if (this.options.shouldIgnorePath(path) && this.options.shouldIgnorePath(oldPath)) {
      return;
    }

    this.pendingPaths.add(path);
    this.options.onPendingChange?.(this.pendingPaths.size);
    this.requestSync();
  }
```

(d) 在 `runSync`（`:55`）方法体内，紧接 `this.syncInProgress = true;` 之后插入计数清零（变更已被本次同步纳入）：

```typescript
    this.syncInProgress = true;
    this.pendingPaths.clear();
    this.options.onPendingChange?.(0);
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npm test -- auto-sync-controller`
Expected: PASS，含新增 2 个测试和原有 3 个测试。

- [ ] **Step 6: main.ts 接入 onPendingChange 刷新状态栏**

定位 `main.ts:538-543` 的 `registerAutoSync`：

```typescript
    this.autoSyncController = new AutoSyncController({
      sync: () => this.syncAutomatically(),
      shouldIgnorePath: (path) =>
        shouldIgnorePath(path, this.settings.ignorePatterns, this.manifest.id)
    });
```

替换为：

```typescript
    this.autoSyncController = new AutoSyncController({
      sync: () => this.syncAutomatically(),
      shouldIgnorePath: (path) =>
        shouldIgnorePath(path, this.settings.ignorePatterns, this.manifest.id),
      onPendingChange: (pendingCount) => {
        if (this.syncStartedAt !== null) {
          return;
        }
        if (pendingCount > 0) {
          this.updateStatus(`待同步 ${pendingCount} 个变更`);
        }
      }
    });
```

- [ ] **Step 7: 类型检查 + 全量测试**

Run: `npx tsc --noEmit && npm test`
Expected: 无类型错误；全部通过。

- [ ] **Step 8: 提交**

```bash
git add src/auto-sync-controller.ts test/auto-sync-controller.test.ts main.ts
git commit -m "feat: show pending change count in status bar for sync observability"
```

---

## Task 10：状态栏显示"距上次同步"（痛点④收尾）

**Files:**
- Modify: `main.ts`（`handleSyncResult` `:617-650` 的状态文案）

**设计：** 同步成功后，状态栏除了显示结果，额外记录"上次成功同步时间"，让用户能判断"上次同步是多久前"。简单做法：成功时把状态文案改为带相对时间锚点的时间戳（已有 `new Date().toLocaleTimeString()`），并在空闲态由轮询/事件刷新时保留该信息。本 Task 做最小增量：成功后状态栏显示"成功 HH:MM:SS"已存在（`:623`），无需新增定时刷新（YAGNI）。仅补一条：当 `pendingCount===0` 且非同步中时，若已有过成功同步，状态栏回落显示"上次同步 HH:MM:SS"而非空白。

> 评估：现有 `handleSyncResult` 已显示 `${status} ${时间}`（`main.ts:623`），`onPendingChange`（Task 9）在 `pendingCount>0` 时覆盖为"待同步 N"。唯一缺口是"待同步计数归零后状态栏停留在旧的待同步文案"。本 Task 修这个回落。

- [ ] **Step 1: 加 lastSuccessLabel 字段**

定位 `main.ts` 类字段区（Task 7 加的 `private deviceId = "";` 旁）。插入：

```typescript
  private lastSyncLabel = "空闲";
```

- [ ] **Step 2: handleSyncResult 记录成功标签**

定位 `main.ts:623`：

```typescript
    this.updateStatus(`${status} ${new Date().toLocaleTimeString()}`);
```

替换为：

```typescript
    this.lastSyncLabel = `${status} ${new Date().toLocaleTimeString()}`;
    this.updateStatus(this.lastSyncLabel);
```

- [ ] **Step 3: onPendingChange 归零时回落到 lastSyncLabel**

定位 Task 9 Step 6 在 `registerAutoSync` 里加的 `onPendingChange` 回调，当前：

```typescript
      onPendingChange: (pendingCount) => {
        if (this.syncStartedAt !== null) {
          return;
        }
        if (pendingCount > 0) {
          this.updateStatus(`待同步 ${pendingCount} 个变更`);
        }
      }
```

替换为：

```typescript
      onPendingChange: (pendingCount) => {
        if (this.syncStartedAt !== null) {
          return;
        }
        this.updateStatus(
          pendingCount > 0 ? `待同步 ${pendingCount} 个变更` : this.lastSyncLabel
        );
      }
```

- [ ] **Step 4: 类型检查 + 全量测试**

Run: `npx tsc --noEmit && npm test`
Expected: 无类型错误；全部通过。

- [ ] **Step 5: 提交**

```bash
git add main.ts
git commit -m "feat: fall back status bar to last sync label after pending clears"
```

---

## Task 11：构建验证 + 收尾

**Files:** 无新增，仅验证。

- [ ] **Step 1: 完整类型检查**

Run: `npx tsc --noEmit`
Expected: 0 错误。

- [ ] **Step 2: 完整测试套件**

Run: `npm test`
Expected: 全部通过，包括新增的 `with-timeout`、`device-id`、`sync-engine` 测试与扩展的 `auto-sync-controller` 测试。

- [ ] **Step 3: 生产构建**

Run: `npm run build`（esbuild 打包到 `main.js`）
Expected: 构建成功，无报错。

- [ ] **Step 4: 人工验证清单（在 Obsidian 中）**

无法自动化，建议手测：
1. **卡死自愈**：断网触发同步 → 30s 后状态栏显示"同步失败"而非永久"同步中"；恢复网络后点同步可正常工作。
2. **冲突收尾**：A/B 两设备对同一笔记不同段落改动 → 同步后本地保留本设备版本，出现 `xxx.conflict-<id>-<ts>.md` 副本，不再卡住。
3. **轮询**：A 设备改文件，B 设备不动 → B 设备 5 分钟内自动出现 A 的改动。
4. **可观测性**：新增/重命名/删除文件 → 状态栏立即显示"待同步 N 个变更"，3 秒后变"同步中→成功"。

- [ ] **Step 5: 最终提交（若有构建产物变更）**

```bash
git add main.js
git commit -m "build: rebuild bundle for sync reliability v0.2"
```

---

## 自检结果（writing-plans Self-Review）

**1. 决策覆盖：**
- 痛点① 卡死自愈 → Task 1-4 ✓（withTimeout + 30s + 两端接入 + 2min 僵尸兜底）
- 痛点② 冲突收尾 → Task 5-7 ✓（deviceId + conflict 副本 + 本地权威上传 + state 推进 + 注入）
- 痛点③ 漏感知 → Task 8 ✓（启动同步 + 5min 轮询，onLayoutReady）
- 痛点④ 触发可观测 → Task 9-10 ✓（待同步计数 + 距上次同步回落）

**2. 占位符扫描：** 无 TODO/TBD；每个代码步骤都有完整代码与精确行号。

**3. 类型一致性：**
- `withTimeout(promise, ms, label)` 签名在 Task 1 定义，Task 2/3 调用一致 ✓
- `buildConflictCopyPath(path, deviceId, timestamp)` 在 Task 5 定义，Task 6 调用一致 ✓
- `SyncEngineOptions.deviceId` 在 Task 6 加，Task 7 注入一致 ✓
- `onPendingChange(pendingCount)` 在 Task 9 定义，main.ts 与 Task 10 引用一致 ✓
- `syncStartedAt` 在 Task 4 引入，Task 9/10 引用一致 ✓

**已知风险/实现者注意：**
- Task 7 Step 4 的 `SyncEngineOptions` 对象字面量当前内容需以实际 `main.ts:574-587` 为准（计划给出了最可能的形态，实现者应先读该段再改）。
- `text-overlap` 收尾把本地设为权威，对端设备同步后也会各得一份 conflict 副本——这是设计预期（双方主文件最终一致，各保留对方版本副本）。
