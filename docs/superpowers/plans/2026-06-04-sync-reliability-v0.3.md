# 同步可靠性 v0.3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复同步引擎四个可靠性缺陷——卡死无法手动恢复、待确认导致状态永不落盘、漏感知文件变化、大量待确认必须逐个处理。

**Architecture:** 四个改动相互关联但可分任务实现。Task D（逐文件落盘）是地基：让 `saveSuccessfulSync` 对"已成功"的路径推进基线、对"待确认/失败"的路径保留旧基线，打破"永远待确认"循环。Task B（分组批量菜单）依赖 D 的落盘，让用户一键处理大量同类冲突。Task A（重置同步状态命令）和 Task C（缩短轮询 + 窗口焦点触发）相对独立、风险低。执行顺序：D → B → A → C。

**Tech Stack:** TypeScript、esbuild（打包 main.js）、Vitest（`vi.fn`/`vi.mock`/`vi.hoisted`）、Obsidian Plugin API（Modal/Setting/addCommand/registerDomEvent/registerInterval）。

**沿用既有约束（不得违反）：** safe 模式语义不变；任何远端删除前必先备份到 trash；不新增 `SyncRemoteStore`/`SyncLocalStore` 接口方法；S3/WebDAV 签名逻辑不碰；测试库的 `data.json` 绝不读全、不动。

---

## File Structure

| 文件 | 职责 | 本次改动 |
|---|---|---|
| `src/sync-state-store.ts` | 同步状态持久化（previousEntries 基线） | `saveSuccessfulSync` 增加 `unresolvedPaths` 参数，逐文件落盘 |
| `src/sync-engine.ts` | 同步编排（计划→执行→落盘） | `syncOnce` 末尾改为总是落盘并传入 unresolvedPaths |
| `main.ts` | 插件入口、Modal、命令、自动同步注册 | `SyncConfirmationModal` 加分组按钮；加"重置同步状态"命令；缩短轮询 + 窗口焦点触发 |
| `test/sync-state-store.test.ts` | 状态存储单测 | +逐文件落盘测试 |
| `test/sync-engine.test.ts` | 引擎单测 | +待确认部分落盘测试 |
| `test/main.test.ts` | 插件/Modal 单测 | +分组按钮测试、+重置命令测试 |

---

## Task D: 逐文件落盘已成功项（地基）

**背景脉络：** 当前 `SyncStateStore.saveSuccessfulSync(local, remote, readText)` 用最新快照**全量重建** `previousEntries`，且 `syncOnce` 只在 `failures===0 && pendingConfirmations===0` 时才调用它。后果：只要有一个待确认未处理，整个状态就不落盘，下次 `planSync` 从旧基线重算，已处理的文件又被判为变更——"永远待确认"。本任务让落盘按路径区分：已成功的推进基线，待确认/失败的保留旧基线（绝不能用当前快照覆盖待确认路径的基线，否则冲突消失=丢数据）。

**Files:**
- Modify: `src/sync-state-store.ts:61-99`（`saveSuccessfulSync`）
- Modify: `src/sync-engine.ts:224-247`（`syncOnce` 落盘段）
- Test: `test/sync-state-store.test.ts`、`test/sync-engine.test.ts`

- [ ] **Step 1: Write the failing test (state store keeps old baseline for unresolved paths)**

在 `test/sync-state-store.test.ts` 的 `describe("SyncStateStore", ...)` 内，最后一个 test 之后添加：

```typescript
  test("preserves the previous baseline for unresolved paths and advances resolved ones", async () => {
    const adapter = new MemoryAdapter();
    const store = new SyncStateStore(adapter);

    // First sync: both a.md and b.md are clean and fully recorded.
    await store.saveSuccessfulSync(
      [entry("a.md", 100, 10), entry("b.md", 100, 20)],
      [entry("a.md", 100, 10), entry("b.md", 100, 20)],
      async () => "base"
    );

    // Second sync: a.md was resolved (advanced to mtime 200), but b.md is an
    // unresolved conflict this round. The snapshots reflect the *current* disk
    // state (b.md changed to 300), but because b.md is unresolved its baseline
    // MUST stay at the previous value (mtime 100) so the conflict is still
    // detected next time.
    await store.saveSuccessfulSync(
      [entry("a.md", 200, 11), entry("b.md", 300, 21)],
      [entry("a.md", 200, 11), entry("b.md", 100, 20)],
      async () => "base2",
      new Set(["b.md"])
    );

    const reloaded = new SyncStateStore(adapter);
    await reloaded.load();
    const entries = reloaded.getPreviousEntries();

    const a = entries.find((e) => e.path === "a.md");
    const b = entries.find((e) => e.path === "b.md");

    // a.md advanced to the new snapshot.
    expect(a?.local?.mtime).toBe(200);
    // b.md kept the OLD baseline (mtime 100 on both sides), not the new disk state.
    expect(b?.local?.mtime).toBe(100);
    expect(b?.remote?.mtime).toBe(100);
  });

  test("drops a first-seen unresolved path that has no previous baseline", async () => {
    const adapter = new MemoryAdapter();
    const store = new SyncStateStore(adapter);

    // c.md appears for the first time and is immediately unresolved (e.g. both
    // sides created it with different content). It has no previous baseline, so
    // it must NOT be written — otherwise next time it would look already-synced.
    await store.saveSuccessfulSync(
      [entry("c.md", 100, 10)],
      [entry("c.md", 100, 99)],
      async () => "x",
      new Set(["c.md"])
    );

    const reloaded = new SyncStateStore(adapter);
    await reloaded.load();
    expect(reloaded.getPreviousEntries()).toEqual([]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/sync-state-store.test.ts`
Expected: FAIL — `saveSuccessfulSync` 目前只接受 3 个参数，第 4 个 `unresolvedPaths` 被忽略，b.md 会被覆盖为 mtime 300/100（不是保留的 100/100），且 c.md 会被写入。

- [ ] **Step 3: Implement `unresolvedPaths` handling in `saveSuccessfulSync`**

把 `src/sync-state-store.ts` 的 `saveSuccessfulSync` 整体替换为：

```typescript
  async saveSuccessfulSync(
    local: FileEntry[],
    remote: FileEntry[],
    readTextContent?: (path: string) => Promise<string | undefined>,
    unresolvedPaths: Set<string> = new Set()
  ): Promise<void> {
    const localMap = new Map(local.map((entry) => [entry.path, entry]));
    const remoteMap = new Map(remote.map((entry) => [entry.path, entry]));
    const previousMap = new Map(
      this.state.previousEntries.map((entry) => [entry.path, entry])
    );

    // Resolved paths advance to the latest snapshot; unresolved ones are skipped
    // here and re-injected from the previous baseline below, so a pending
    // conflict's baseline is never clobbered with current disk state.
    const snapshotPaths = new Set<string>([...localMap.keys(), ...remoteMap.keys()]);
    const resolvedEntries = await Promise.all(
      [...snapshotPaths]
        .filter((path) => !unresolvedPaths.has(path))
        .sort()
        .map(async (path) => {
          const localEntry = localMap.get(path);
          const remoteEntry = remoteMap.get(path);
          const mergeBase =
            localEntry && remoteEntry && readTextContent && canStoreMergeBase(localEntry)
              ? await readTextContent(path).then((content) =>
                  typeof content === "string"
                    ? { source: "previous-sync-state" as const, content }
                    : undefined
                )
              : undefined;

          return {
            path,
            local: localEntry,
            remote: remoteEntry,
            mergeBase
          };
        })
    );

    // For every unresolved path, keep its previous baseline verbatim. If it has
    // no previous baseline (first-seen conflict), it is intentionally omitted so
    // it is not mistaken for already-synced next time.
    const preservedEntries: PreviousEntry[] = [];
    for (const path of unresolvedPaths) {
      const previous = previousMap.get(path);
      if (previous) {
        preservedEntries.push(previous);
      }
    }

    const previousEntries = [...resolvedEntries, ...preservedEntries].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0
    );

    this.state = {
      version: 1,
      lastSyncTime: Date.now(),
      previousEntries
    };

    await this.adapter.write(JSON.stringify(this.state, null, 2));
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/sync-state-store.test.ts`
Expected: PASS — 全部 5 个 test 通过（含原有 3 个，保证向后兼容：不传 `unresolvedPaths` 时默认空集，行为与旧的全量重建一致）。

- [ ] **Step 5: Write the failing engine test (sync persists resolved part while a confirmation is pending)**

先阅读 `test/sync-engine.test.ts` 顶部，复用其现有的 store/local/remote 测试搭建方式（已有 `executes safe operations but keeps state unchanged when manual confirmations are pending` 这个 test，命名约 line 239）。在该 test 之后添加一个新 test，验证**有待确认时仍落盘已成功项**。具体断言：构造一个计划，其中 `operations` 含一个可自动执行的 upload（已成功），`confirmations` 含一个待确认；同步后，断言 `stateStore` 落盘了该 upload 路径的新基线，但待确认路径保留旧基线。

由于本仓库 `test/sync-engine.test.ts` 使用内存 store 与可控的 local/remote stub，实现者**必须先读该文件**了解其 `createEngine`/stub 工厂，再仿照写测试。测试断言形如：

```typescript
  test("persists baseline for resolved operations even when a confirmation stays pending", async () => {
    // ... 仿照同文件既有 test 构造 engine：
    //   - localSnapshot: [resolved.md(新), conflict.md]
    //   - remoteSnapshot: [conflict.md(冲突)]
    //   - previousEntries: 让 resolved.md 判为 local-only(upload)，conflict.md 判为 binary 冲突
    const result = await engine.syncOnce();

    expect(result.summary.uploaded).toBe(1);
    expect(result.summary.pendingConfirmations).toBe(1);

    // 关键：已成功的 resolved.md 必须落盘（基线推进），否则下次重复上传。
    const saved = stateStore.getPreviousEntries();
    expect(saved.find((e) => e.path === "resolved.md")).toBeTruthy();
    // 待确认的 conflict.md 不应以"已同步"形态落盘（保留旧基线或缺失）。
  });
```

> 实现注记：如果同文件没有现成可复用的 engine 工厂，实现者可参照 `test/sync-engine.test.ts` 既有 setup（它一定已构造过 SyncEngine）。**不要新建 mock 体系**，复用现有的。

- [ ] **Step 6: Run the engine test to verify it fails**

Run: `npx vitest run test/sync-engine.test.ts`
Expected: FAIL — 当前 `syncOnce` 仅在 `pendingConfirmations === 0` 时落盘，故 `resolved.md` 不会落盘，断言失败。

- [ ] **Step 7: Rewrite the persistence block in `syncOnce` to always save with unresolvedPaths**

在 `src/sync-engine.ts` 中，把这段（约 line 224-247）：

```typescript
    if (summary.failures === 0 && summary.pendingConfirmations === 0) {
      const [updatedLocalSnapshot, updatedRemoteSnapshot] = await Promise.all([
        this.local.snapshot(),
        this.remote.snapshot()
      ]);
      try {
        await this.stateStore.saveSuccessfulSync(
          this.filterIgnoredEntries(updatedLocalSnapshot),
          this.filterIgnoredEntries(updatedRemoteSnapshot),
          async (path) => {
            try {
              return decodeTextContent(await this.local.readFile(path));
            } catch {
              return undefined;
            }
          }
        );
      } catch (error) {
        this.recordFailure(summary, { path: "<sync-state>" }, error, "save-state");
      }
    }
```

替换为：

```typescript
    // 即便存在待确认/失败，也要落盘已成功的部分：对已处理路径推进基线，对
    // 待确认与失败路径保留旧基线，避免"一个未决导致整体重算、永远待确认"。
    const unresolvedPaths = new Set<string>([
      ...pendingConfirmations.map((confirmation) => confirmation.path),
      ...summary.failureDetails.map((failure) => failure.path)
    ]);
    {
      const [updatedLocalSnapshot, updatedRemoteSnapshot] = await Promise.all([
        this.local.snapshot(),
        this.remote.snapshot()
      ]);
      try {
        await this.stateStore.saveSuccessfulSync(
          this.filterIgnoredEntries(updatedLocalSnapshot),
          this.filterIgnoredEntries(updatedRemoteSnapshot),
          async (path) => {
            try {
              return decodeTextContent(await this.local.readFile(path));
            } catch {
              return undefined;
            }
          },
          unresolvedPaths
        );
      } catch (error) {
        this.recordFailure(summary, { path: "<sync-state>" }, error, "save-state");
      }
    }
```

> 注记：`unresolvedPaths` 在调用 `saveSuccessfulSync` **之前**计算，因此即使落盘自身失败（`<sync-state>`）也不影响该集合。`<sync-state>` 这种伪路径只会在落盘失败后才加入 `failureDetails`，不会污染本集合。

- [ ] **Step 8: Run all tests to verify they pass**

Run: `npx vitest run`
Expected: PASS — 全量测试通过。特别确认原有 `executes safe operations but keeps state unchanged when manual confirmations are pending` 这个 test：它的语义现在变了（不再"完全不变"），实现者**必须更新该 test 的断言**以反映新行为（已成功操作落盘、待确认保留旧基线），并在 commit message 中说明这是有意的语义变更。若该 test 名称已不准确，改名为 `persists resolved operations but preserves baseline for pending confirmations`。

- [ ] **Step 9: Type-check and build**

Run: `npx tsc --noEmit && npm run build`
Expected: 0 errors，`main.js` 生成成功。

- [ ] **Step 10: Commit**

```bash
git add src/sync-state-store.ts src/sync-engine.ts test/sync-state-store.test.ts test/sync-engine.test.ts
git commit -m "fix: persist resolved sync state even when confirmations are pending"
```

---

## Task B: 确认窗按类型分组 + 组内一键批量

**背景脉络：** `SyncConfirmationModal`（`main.ts:35-196`）当前为每个待确认渲染一个 `Setting` + `dropdown`，底部只有"接受所有远端删除/全部跳过/执行选择"三个全局按钮。大量同类冲突（如 50 个删除）必须逐个下拉处理。本任务在保留逐项下拉（精细控制）的前提下，把待确认**按冲突类型分组**，每组顶部加一排批量按钮，点击后批量设置该组所有项的决策并刷新对应下拉显示。

**分组规则（基于 `SyncConflictType`，见 `src/sync-types.ts:72-78`）：**
- **删除类组** = `conflictType === "delete-vs-modify"`。批量按钮：`全部接受删除`(accept-delete)、`全部保留`(local 存在→use-local，否则 remote 存在→use-remote)、`全组跳过`(skip)。
- **文本冲突组** = `text-auto-merge` | `text-overlap` | `text-no-base` | `text-too-large`。批量按钮：`全部自动合并`(仅 `suggestedKind === "merge"` 的项设为 auto-merge，其余不变)、`全部用本地`(use-local)、`全部用远端`(use-remote)、`全组跳过`(skip)。
- **二进制组** = `conflictType === "binary"`。批量按钮：`全部用本地`(use-local)、`全部用远端`(use-remote)、`全组跳过`(skip)。

**Files:**
- Modify: `main.ts:35-196`（`SyncConfirmationModal`）
- Test: `test/main.test.ts`

- [ ] **Step 1: Extend the Obsidian mock so dropdown.setValue is observable per path**

在 `test/main.test.ts` 的 `vi.mock("obsidian", ...)` 里的 `Setting` 类中，当前 `addDropdown` 创建的 dropdown stub 的 `setValue` 只是 `vi.fn`。为了让分组批量按钮的测试能验证"下拉被刷新成了新值"，需要让 dropdown 记录最后设置的值。

把 `Setting` 的 `addDropdown` 替换为（保持链式不变，新增 `getValueForTest`）：

```typescript
    addDropdown(cb: (dropdown: unknown) => void): this {
      let current = "";
      const dropdown: any = {
        addOption: vi.fn(() => dropdown),
        setValue: vi.fn((value: string) => {
          current = value;
          return dropdown;
        }),
        getValue: vi.fn(() => current),
        onChange: vi.fn(() => dropdown)
      };
      cb(dropdown);
      return this;
    }
```

> 注记：这是测试基础设施的增强，不改变生产代码可见行为。现有依赖 `addDropdown` 的测试仍通过（`setValue`/`onChange` 仍是可链式调用的 `vi.fn`）。

- [ ] **Step 2: Write the failing test (group "全部接受删除" applies accept-delete to all delete-vs-modify entries)**

在 `test/main.test.ts` 的 `describe("RemoteSyncPlugin", ...)` 内，`buildConfirmationPlugin` 辅助函数之后添加一个新的辅助 + 测试。该测试构造 3 个待确认（2 个 delete-vs-modify + 1 个 binary），打开 Modal，点击删除组的"全部接受删除"按钮，断言提交的 decisions 中两个删除项都是 `accept-delete`、binary 项不受影响。

```typescript
  // Builds a plugin whose engine reports the given confirmations, captures the
  // decisions submitted by the modal so a test can assert what the group
  // buttons produced.
  async function buildGroupedConfirmationPlugin(confirmations: any[]) {
    const { Notice } = await import("obsidian");
    vi.mocked(Notice).mockClear();
    modalHooks.reset();

    const { default: RemoteSyncPlugin } = await import("../main.ts");
    const plugin = new RemoteSyncPlugin();
    const submitted: any[] = [];

    const result = {
      plan: {
        operations: [],
        confirmations,
        conflicts: [],
        skipped: [],
        initialSyncRequired: false
      },
      summary: {
        uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0,
        merged: 0, skipped: 0, conflicts: 0,
        pendingConfirmations: confirmations.length,
        backedUp: 0, failures: 0, initialSyncRequired: false, failureDetails: []
      }
    };
    // First call returns the confirmations; the resubmit (confirmManually:false)
    // call captures decisions and returns a clean result.
    const syncOnce = vi
      .fn()
      .mockResolvedValueOnce(result)
      .mockImplementation(async (decisions: any[]) => {
        if (decisions) submitted.push(...decisions);
        return { ...result, plan: { ...result.plan, confirmations: [] }, summary: { ...result.summary, pendingConfirmations: 0 } };
      });

    Object.assign(plugin, {
      manifest: { id: "obsidian-webdav-sync", version: "0.1.1" },
      statusBarItemEl: { setText: vi.fn() },
      settings: { provider: "webdav", baseUrl: "https://example.com/dav", customHeaders: "" },
      createEngine: () => ({ syncOnce })
    });

    return { plugin, submitted };
  }

  test("group button '全部接受删除' applies accept-delete to all delete-vs-modify entries only", async () => {
    const confirmations = [
      { path: "del1.md", conflictType: "delete-vs-modify", reason: "remote-deleted", local: { path: "del1.md" } },
      { path: "del2.md", conflictType: "delete-vs-modify", reason: "remote-deleted", local: { path: "del2.md" } },
      { path: "bin.png", conflictType: "binary", reason: "same-mtime-different-size", local: { path: "bin.png" }, remote: { path: "bin.png" } }
    ];
    const { plugin, submitted } = await buildGroupedConfirmationPlugin(confirmations);

    await (plugin as unknown as { syncNow: () => Promise<void> }).syncNow();
    expect(modalHooks.openCount).toBe(1);

    // Click the delete-group bulk button.
    modalHooks.click("全部接受删除");

    const byPath = new Map(submitted.map((d) => [d.path, d.action]));
    expect(byPath.get("del1.md")).toBe("accept-delete");
    expect(byPath.get("del2.md")).toBe("accept-delete");
    // The binary entry must NOT be forced to accept-delete by the delete group.
    expect(byPath.get("bin.png")).not.toBe("accept-delete");
  });

  test("group button '全部用远端' applies use-remote to all text-conflict entries", async () => {
    const confirmations = [
      { path: "t1.md", conflictType: "text-overlap", reason: "both-changed", local: { path: "t1.md" }, remote: { path: "t1.md" } },
      { path: "t2.md", conflictType: "text-no-base", reason: "both-changed", local: { path: "t2.md" }, remote: { path: "t2.md" } }
    ];
    const { plugin, submitted } = await buildGroupedConfirmationPlugin(confirmations);

    await (plugin as unknown as { syncNow: () => Promise<void> }).syncNow();
    modalHooks.click("全部用远端");

    const byPath = new Map(submitted.map((d) => [d.path, d.action]));
    expect(byPath.get("t1.md")).toBe("use-remote");
    expect(byPath.get("t2.md")).toBe("use-remote");
  });
```

> 注记：批量按钮点击后**直接提交**（与"执行选择"同语义：set decisions → close → onSubmit）。这样测试通过 `modalHooks.click(label)` 即可驱动，且符合用户"一键解决"的预期——点了组批量就直接执行该批，无需再点"执行选择"。

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/main.test.ts`
Expected: FAIL — 当前没有"全部接受删除"/"全部用远端"按钮，`modalHooks.click` 抛 `No button registered with label "全部接受删除"`。

- [ ] **Step 4: Rewrite `SyncConfirmationModal.onOpen` to render grouped bulk buttons**

把 `main.ts` 中 `SyncConfirmationModal` 的 `onOpen` 方法整体替换为以下实现（保留逐项下拉，新增分组与组按钮；新增私有方法 `groupOf`、`submitWith`）。同时在类顶部字段区把 `decisions` 之后加一个 dropdown 引用表。

先在类字段区（`private submitted = false;` 之后）添加：

```typescript
  // Per-path dropdown components so bulk buttons can refresh the visible value
  // after programmatically changing a decision.
  private readonly dropdowns = new Map<string, { setValue: (v: string) => unknown }>();
```

然后把 `onOpen` 替换为：

```typescript
  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "处理同步确认" });
    contentEl.createEl("p", {
      text: "以下文件存在需要人工介入的冲突。可自动合并的文本文件会优先尝试自动合并。"
    });

    // Group confirmations by coarse conflict category so users can resolve a
    // whole category (e.g. dozens of deletions) with one click.
    const groups: Array<{ key: "delete" | "text" | "binary"; title: string; items: SyncConfirmation[] }> = [
      { key: "delete", title: "删除类冲突", items: [] },
      { key: "text", title: "文本类冲突", items: [] },
      { key: "binary", title: "二进制/其它冲突", items: [] }
    ];
    for (const confirmation of this.confirmations) {
      const group = groups.find((g) => g.key === this.groupOf(confirmation));
      group?.items.push(confirmation);
    }

    for (const group of groups) {
      if (group.items.length === 0) {
        continue;
      }
      contentEl.createEl("h3", { text: `${group.title}（${group.items.length}）` });

      // Bulk-action row for this group.
      const bulkRow = new Setting(contentEl).setName("批量处理本组");
      if (group.key === "delete") {
        bulkRow
          .addButton((b) => b.setButtonText("全部接受删除").onClick(() =>
            this.submitWith(group.items, () => "accept-delete")))
          .addButton((b) => b.setButtonText("全部保留").onClick(() =>
            this.submitWith(group.items, (c) => (c.local ? "use-local" : "use-remote"))))
          .addButton((b) => b.setButtonText("全组跳过").onClick(() =>
            this.submitWith(group.items, () => "skip")));
      } else if (group.key === "text") {
        bulkRow
          .addButton((b) => b.setButtonText("全部自动合并").onClick(() =>
            this.submitWith(group.items, (c) => (c.suggestedKind === "merge" ? "auto-merge" : this.decisions.get(c.path) ?? "skip"))))
          .addButton((b) => b.setButtonText("全部用本地").onClick(() =>
            this.submitWith(group.items, () => "use-local")))
          .addButton((b) => b.setButtonText("全部用远端").onClick(() =>
            this.submitWith(group.items, () => "use-remote")))
          .addButton((b) => b.setButtonText("全组跳过").onClick(() =>
            this.submitWith(group.items, () => "skip")));
      } else {
        bulkRow
          .addButton((b) => b.setButtonText("全部用本地").onClick(() =>
            this.submitWith(group.items, () => "use-local")))
          .addButton((b) => b.setButtonText("全部用远端").onClick(() =>
            this.submitWith(group.items, () => "use-remote")))
          .addButton((b) => b.setButtonText("全组跳过").onClick(() =>
            this.submitWith(group.items, () => "skip")));
      }

      // Per-item dropdowns (unchanged behaviour, finer control).
      for (const confirmation of group.items) {
        const defaultAction = this.defaultAction(confirmation);
        this.decisions.set(confirmation.path, defaultAction);

        new Setting(contentEl)
          .setName(confirmation.path)
          .setDesc(this.describeConfirmation(confirmation))
          .addDropdown((dropdown) => {
            dropdown.addOption("skip", "跳过");
            if (confirmation.suggestedKind === "merge") {
              dropdown.addOption("auto-merge", "自动合并");
            }
            if (confirmation.local) {
              dropdown.addOption("use-local", "使用本地版本");
            }
            if (confirmation.remote) {
              dropdown.addOption("use-remote", "使用远端版本");
            }
            if ((confirmation.local && !confirmation.remote) || (confirmation.remote && !confirmation.local)) {
              dropdown.addOption("accept-delete", "接受删除");
            }
            dropdown.setValue(defaultAction).onChange((value) => {
              this.decisions.set(confirmation.path, value as SyncConfirmationDecision["action"]);
            });
            this.dropdowns.set(confirmation.path, dropdown);
          });
      }
    }

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("接受所有远端删除")
          .onClick(() => {
            const decisions = this.confirmations.map((confirmation) => ({
              path: confirmation.path,
              action: this.isRemoteDeleteConfirmation(confirmation)
                ? "accept-delete"
                : this.decisions.get(confirmation.path) ?? "skip"
            }));
            this.submitted = true;
            this.close();
            this.onSubmit(decisions);
          })
      )
      .addButton((button) =>
        button
          .setButtonText("全部跳过")
          .onClick(() => {
            this.close();
          })
      )
      .addButton((button) =>
        button
          .setButtonText("执行选择")
          .setCta()
          .onClick(() => {
            const decisions = this.confirmations.map((confirmation) => ({
              path: confirmation.path,
              action: this.decisions.get(confirmation.path) ?? "skip"
            }));
            this.submitted = true;
            this.close();
            this.onSubmit(decisions);
          })
      );
  }
```

在 `defaultAction` 方法**之前**插入两个新私有方法：

```typescript
  private groupOf(confirmation: SyncConfirmation): "delete" | "text" | "binary" {
    if (confirmation.conflictType === "delete-vs-modify") {
      return "delete";
    }
    if (confirmation.conflictType === "binary") {
      return "binary";
    }
    return "text";
  }

  // Apply a bulk decision to a group, refresh the visible dropdowns, then submit
  // immediately (the user explicitly chose a one-click bulk action). Decisions
  // for paths outside the group keep whatever the per-item dropdowns hold.
  private submitWith(
    items: SyncConfirmation[],
    pick: (confirmation: SyncConfirmation) => SyncConfirmationDecision["action"]
  ): void {
    for (const confirmation of items) {
      const action = pick(confirmation);
      this.decisions.set(confirmation.path, action);
      this.dropdowns.get(confirmation.path)?.setValue(action);
    }
    const decisions = this.confirmations.map((confirmation) => ({
      path: confirmation.path,
      action: this.decisions.get(confirmation.path) ?? "skip"
    }));
    this.submitted = true;
    this.close();
    this.onSubmit(decisions);
  }
```

> 注记：`submitWith` 的 `dropdowns.get(...).setValue(...)` 在提交前刷新仅为了"立即关闭前的一致性"与未来扩展（非立即提交模式）；当前因为立即 `close()`，视觉刷新意义不大，但保留它让逐项视图与决策始终同步，且便于测试 dropdown 值。`dropdown` 类型在生产 Obsidian 中是 `DropdownComponent`，存入 `Map` 时用结构最小类型 `{ setValue }` 即可，避免引入额外 import。

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/main.test.ts`
Expected: PASS — 新增 2 个分组按钮 test 通过；现有 4 个 confirmation 相关 test 仍通过（"全部跳过"/"执行选择"/"接受所有远端删除"行为不变）。

- [ ] **Step 6: Type-check and build**

Run: `npx tsc --noEmit && npm run build`
Expected: 0 errors，`main.js` 生成成功。

- [ ] **Step 7: Commit**

```bash
git add main.ts test/main.test.ts
git commit -m "feat: group sync confirmations by type with bulk one-click actions"
```

---

## Task A: 命令面板「重置同步状态」

**背景脉络：** 同步锁是裸时间戳 `this.syncStartedAt`（`main.ts`）。若网络请求 hang 死不超时，`syncStartedAt` 会卡满 `STALE_SYNC_THRESHOLD_MS`（2 分钟），期间手动点同步走 `runSync` 撞 `elapsed < threshold` → 弹"同步正在进行中" → 失效。本任务加一个命令，立即清锁并触发一次同步，让用户随时能手动救回。

**Files:**
- Modify: `main.ts`（命令注册区，约 line 338-368；新增 `resetSyncState` 方法）
- Test: `test/main.test.ts`

- [ ] **Step 1: Write the failing test (reset command clears the lock and triggers a sync)**

在 `test/main.test.ts` 的 `describe("RemoteSyncPlugin", ...)` 内添加：

```typescript
  test("registers a '重置同步状态' command that clears the stale lock and re-syncs", async () => {
    const { default: RemoteSyncPlugin } = await import("../main.ts");
    const plugin = new RemoteSyncPlugin();
    const addCommand = vi.fn();

    Object.assign(plugin, {
      app: { workspace: { on: vi.fn(() => ({})) }, vault: { getName: vi.fn(() => "V") } },
      loadData: vi.fn(async () => ({ settings: {} })),
      saveData: vi.fn(async () => {}),
      registerView: vi.fn(),
      registerExtensions: vi.fn(),
      registerEvent: vi.fn(),
      register: vi.fn(),
      addRibbonIcon: vi.fn(),
      addCommand,
      addStatusBarItem: vi.fn(() => ({ setText: vi.fn() })),
      addSettingTab: vi.fn(),
      registerAutoSync: vi.fn()
    });

    await plugin.onload();

    const resetCommand = addCommand.mock.calls
      .map(([command]) => command)
      .find((command) => command.id === "reset-sync-state");
    expect(resetCommand?.name).toBe("重置同步状态");

    // Simulate a stuck lock, then invoke the command callback.
    const internals = plugin as unknown as { syncStartedAt: number | null; syncNow: () => Promise<void> };
    internals.syncStartedAt = 123;
    const syncNow = vi.fn(async () => {});
    internals.syncNow = syncNow;

    resetCommand!.callback();

    expect(internals.syncStartedAt).toBeNull();
    expect(syncNow).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/main.test.ts -t "重置同步状态"`
Expected: FAIL — 没有 `reset-sync-state` 命令，`resetCommand` 为 `undefined`。

- [ ] **Step 3: Register the command and add `resetSyncState`**

在 `main.ts` 命令注册区（`check-plugin-update` 那个 `addCommand` 之后，约 line 368 之后、`addCommand` 块结束前）添加：

```typescript
    this.addCommand({
      id: "reset-sync-state",
      name: "重置同步状态",
      callback: () => {
        this.resetSyncState();
      }
    });
```

在 `resolveSyncConfirmations` 方法之后（约 line 459 之后）添加新方法：

```typescript
  resetSyncState(): void {
    // Force-release a stuck sync lock so a hung request (that never timed out)
    // can no longer block manual syncs, then immediately retry.
    this.syncStartedAt = null;
    new Notice("已重置同步状态，正在重新同步…");
    void this.syncNow();
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/main.test.ts -t "重置同步状态"`
Expected: PASS。

- [ ] **Step 5: Type-check, build, full test**

Run: `npx tsc --noEmit && npm run build && npx vitest run`
Expected: 0 errors，build 成功，全量测试通过。

- [ ] **Step 6: Commit**

```bash
git add main.ts test/main.test.ts
git commit -m "feat: add '重置同步状态' command to recover from a stuck sync lock"
```

---

## Task C: 缩短轮询间隔 + 窗口重获焦点触发

**背景脉络：** 自动同步靠 vault 事件（create/modify/delete/rename）+ 5 分钟轮询兜底（`AUTO_SYNC_POLL_INTERVAL_MS`，`main.ts:28`）。但 Obsidian 关闭期间或外部程序改的文件无本地事件，5 分钟窗口内漏感知。本任务：①轮询 5min→2min；②在窗口重获焦点（从后台切回前台、从休眠唤醒）时触发一次同步，覆盖"切回设备立刻拉取"的场景。`syncAutomatically` 已有 stale 守卫（2 分钟内重复调用返回 busy），且全量对比逻辑已存在，故焦点触发不会引发重复执行风暴。

**Files:**
- Modify: `main.ts:28`（`AUTO_SYNC_POLL_INTERVAL_MS`）、`main.ts:654-690`（`registerAutoSync` 的 `onLayoutReady` 块）
- Test: `test/main.test.ts`

- [ ] **Step 1: Write the failing test (window focus triggers an automatic sync)**

`registerAutoSync` 通过 `this.registerDomEvent(window, "focus", ...)` 注册焦点监听。测试用一个捕获 handler 的 `registerDomEvent` stub，触发它，断言 `syncAutomatically` 被调用。

在 `test/main.test.ts` 的 `describe("RemoteSyncPlugin", ...)` 内添加：

```typescript
  test("registers a window focus handler that triggers an automatic sync", async () => {
    const { default: RemoteSyncPlugin } = await import("../main.ts");
    const plugin = new RemoteSyncPlugin();

    // Capture the focus handler registered via registerDomEvent(window, "focus").
    let focusHandler: (() => void) | null = null;
    const registerDomEvent = vi.fn((_target: unknown, event: string, handler: () => void) => {
      if (event === "focus") {
        focusHandler = handler;
      }
    });

    const syncAutomatically = vi.fn(async () => "completed");

    Object.assign(plugin, {
      app: {
        workspace: {
          on: vi.fn(() => ({})),
          onLayoutReady: (cb: () => void) => cb()
        },
        vault: { on: vi.fn(() => ({})), getName: vi.fn(() => "V") }
      },
      settings: { ignorePatterns: [] },
      manifest: { id: "obsidian-webdav-sync" },
      registerEvent: vi.fn(),
      register: vi.fn(),
      registerDomEvent,
      registerInterval: vi.fn(),
      syncAutomatically
    });

    // Call the real registerAutoSync.
    (plugin as unknown as { registerAutoSync: () => void }).registerAutoSync();

    // onLayoutReady runs synchronously in the stub; the startup sync fires once.
    expect(syncAutomatically).toHaveBeenCalledTimes(1);

    // Firing the window focus event triggers another automatic sync.
    expect(focusHandler).toBeTypeOf("function");
    focusHandler!();
    expect(syncAutomatically).toHaveBeenCalledTimes(2);
  });
```

> 注记：`syncAutomatically` 已含 stale 守卫，焦点频繁触发不会真重复执行；测试只验证"焦点事件确实驱动了一次 syncAutomatically 调用"。

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/main.test.ts -t "window focus"`
Expected: FAIL — `registerAutoSync` 当前未注册 `registerDomEvent(window, "focus", ...)`，`focusHandler` 为 null，最后断言抛错。

- [ ] **Step 3: Shorten poll interval and add focus handler**

把 `main.ts:28`：

```typescript
const AUTO_SYNC_POLL_INTERVAL_MS = 5 * 60 * 1000;
```

改为：

```typescript
const AUTO_SYNC_POLL_INTERVAL_MS = 2 * 60 * 1000;
```

在 `registerAutoSync` 的 `onLayoutReady` 回调内，启动同步 `void this.syncAutomatically();` 之后、`registerInterval(...)` 之前，插入焦点监听：

```typescript
      // 窗口从后台切回前台/从休眠唤醒时，立即补一次同步，覆盖关闭期间其它设备
      // 或外部程序改动了文件但本地没有 vault 事件的漏感知场景。syncAutomatically
      // 自带 stale 守卫，频繁 focus 不会引发重复执行。
      this.registerDomEvent(window, "focus", () => {
        void this.syncAutomatically();
      });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/main.test.ts -t "window focus"`
Expected: PASS。

- [ ] **Step 5: Type-check, build, full test**

Run: `npx tsc --noEmit && npm run build && npx vitest run`
Expected: 0 errors，build 成功，全量测试通过。

- [ ] **Step 6: Commit**

```bash
git add main.ts test/main.test.ts
git commit -m "feat: shorten auto-sync poll to 2min and sync on window focus"
```

---

## Self-Review（计划完成后自查记录）

- **Spec 覆盖：** A（重置命令）=Task A；B（分组批量菜单）=Task B；C（漏感知补偿：缩轮询+焦点）=Task C；D（待确认落盘）=Task D。四项全覆盖。✓
- **依赖顺序：** D 在最前（B 的落盘依赖它），B 次之，A/C 独立殿后。✓
- **类型一致性：** `saveSuccessfulSync` 第 4 参数 `unresolvedPaths: Set<string>`（默认 `new Set()`）在 Task D Step 3（定义）与 Step 7（调用）一致；`SyncConfirmationDecision["action"]` 取值（use-local/use-remote/accept-delete/auto-merge/skip）与 `src/sync-types.ts:92-97` 一致；`groupOf` 返回值 "delete"|"text"|"binary" 在 Step 4 内自洽。✓
- **占位符扫描：** 唯一非完整代码处为 Task D Step 5 的引擎测试（要求实现者先读 `test/sync-engine.test.ts` 复用既有 stub，给出断言骨架而非整段）。这是**有意为之**——该文件的 engine 工厂细节未在本会话读取，强行写死整段会与真实 setup 冲突，反而误导。已用醒目注记标明"先读文件、复用现有 mock、不要新建体系"。其余所有步骤均含完整可粘贴代码。✓
- **既有约束：** 不新增 Store 接口方法（仅扩展既有 `saveSuccessfulSync` 签名）；不碰 S3/WebDAV 签名；safe 语义不变；trash 备份契约不变（Task 不涉及删除执行路径）。✓
