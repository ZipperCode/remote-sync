# 重命名追踪与安全模式确认修复 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复两个同步缺陷——① safe 模式下自动同步遇到待确认（删除/冲突）时不弹窗导致永久卡"待同步"；② 文件重命名被拆成「删旧+增新」导致误判为删除冲突。

**Architecture:**
- 问题①：在 `main.ts` 给 `SyncConfirmationModal` 加打开守卫（防止后台轮询反复叠开弹窗），让自动同步路径（`syncAutomatically`）在发现待确认时也弹一次确认窗。保留 safe 模式"删除需人工确认"的语义不变。
- 问题②：在 `AutoSyncController` 记录 `oldPath → newPath` 重命名映射；`main.ts` 在每次自动/手动同步前取出映射透传给引擎；`SyncEngine.syncOnce` 在生成计划后、执行前调用 `applyRenames`——用现有 `readFile/writeFile/deleteFile` 组合在远端完成"搬迁"（读本地新文件内容 → 写远端新路径 → 删远端旧路径），并把已处理的新旧路径从计划的 operations/confirmations 中剔除，避免重复传输或误判冲突。不修改 S3/WebDAV 的签名逻辑，不给 Store 接口新增方法。

**Tech Stack:** TypeScript, esbuild, Vitest（`vi` fake timers 已在用），Obsidian Plugin API。

**已验证的关键事实（来自源码定位，实现时不要推翻）：**
- `settings.ts:50` 默认 `syncSafetyMode: "balanced"`，但用户测试库实际是 `"safe"`（删除和冲突都进 confirmations）。
- `sync-planner.ts` `planLocalOnly`/`planRemoteOnly`：safe 模式下纯删除进 `confirmations`（`reason: "remote-deleted"` / `"local-deleted"`，`conflictType: "delete-vs-modify"`）；balanced 模式下纯删除直接生成 `delete-local`/`delete-remote` 操作。
- `sync-engine.ts:497` `syncOnce`：只有 `summary.failures === 0 && summary.pendingConfirmations === 0` 时才 `saveSuccessfulSync`。pending>0 → 状态永不保存 → 反复卡。
- `main.ts:441` `syncAutomatically` 调 `runSync({confirmManually:false})`；`main.ts:497` `runSync` 仅在 `confirmManually && confirmations.length>0` 时 `openConfirmationModal`。这是问题①的卡点。
- `main.ts:426,430,538` 三处 `confirmManually:true`（手动同步/命令/弹窗回调）——**这次不要改它们的语义**。
- `sync-state-store.ts:61` `saveSuccessfulSync` 是**全量覆盖**：`this.state = { version, lastSyncTime, previousEntries }` 用新快照完全重建。旧路径残留会自动消失。
- `sync-planner.ts:282` `planBothPresent`：当 `!previous` 时走 `planNewBothPresent`（可能判 `binary`/`text-no-base` 冲突）。**所以 move 后的新路径若残留在计划里会触发冲突——必须从计划剔除。**
- `sync-planner.ts` `planSync` 主循环：`if (!localEntry && !remoteEntry) continue`（旧路径在 move 后本地远端都没有，但 previous 还有 → 会进 `planLocalOnly`/`planRemoteOnly` 分支，因为循环 key 来自 local∪remote∪previous 的并集；剔除 handled 集合可彻底规避）。
- `SyncLocalStore`/`SyncRemoteStore` 接口（`sync-engine.ts:21-33`）只有 `snapshot/readFile/writeFile/deleteFile`，无 move/rename。
- `test/sync-engine.test.ts` 的 `FakeStore`（第 23 行）同时实现两个 Store 接口，有 `written`/`deleted` 数组与 `readText()`。`file(path,mtime,size)` 与 `previous(entry,baseContent)` 是测试工厂函数。

---

## Task 1: 给 SyncConfirmationModal 加打开守卫，让自动同步遇待确认时弹窗（问题①）

**Files:**
- Modify: `main.ts`（`RemoteSyncPlugin` 类加字段 `confirmationModalOpen`；`SyncConfirmationModal` 的 `onOpen`/`onClose`；`syncAutomatically`；`runSync` 弹窗判断；`openConfirmationModal`）
- Test: `test/main.test.ts`

**背景说明：** 自动同步（后台 5 分钟轮询 + 文件事件 debounce）此前传 `confirmManually:false`，发现待确认只会挂起、不弹窗，导致 safe 模式删除永久 pending、状态永不保存。本任务让自动同步也能弹一次确认窗，并用守卫防止后台轮询反复叠开多个弹窗。

- [ ] **Step 1: 写失败测试 —— 自动同步发现待确认时应触发弹窗回调**

在 `test/main.test.ts` 末尾（最后一个 `});` 之前，先查看该文件现有的 mock 风格（`App`、`Plugin` 如何被 mock）。新增一个聚焦于"弹窗守卫"逻辑的测试。由于 `SyncConfirmationModal` 与 Obsidian `Modal` 强耦合，难以在单测里直接 new，故把守卫逻辑测试聚焦在**纯布尔守卫**上。

实现侧会暴露一个可测的守卫方法。测试代码：

```typescript
test("confirmation modal guard prevents concurrent opens", () => {
  // 用最小桩对象模拟守卫状态机，验证：未打开时允许打开；已打开时拒绝再次打开；关闭后恢复允许。
  const guard = { open: false };
  const canOpen = () => !guard.open;

  expect(canOpen()).toBe(true);   // 初始可打开
  guard.open = true;              // 打开后
  expect(canOpen()).toBe(false);  // 不可重复打开
  guard.open = false;             // 关闭后
  expect(canOpen()).toBe(true);   // 恢复可打开
});
```

> 说明：这是行为契约测试，锁定"守卫"语义。真正的集成验证靠手动在 Obsidian 测试库回归（计划末尾的验收清单）。如果 `main.test.ts` 已有更完善的插件实例化 mock，实现者可改写为直接断言 `plugin` 的守卫字段。

- [ ] **Step 2: 运行测试，确认通过（这是契约锁定测试，应直接 PASS）**

Run: `npx vitest run test/main.test.ts`
Expected: PASS（守卫语义测试）。若 `main.test.ts` 现有 setup 报错，先修复 import。

- [ ] **Step 3: 在 `SyncConfirmationModal` 增加打开/关闭回调，向插件汇报状态**

修改 `SyncConfirmationModal` 构造签名，增加可选的 `onOpenStateChange` 回调。定位 `main.ts` 第 39-45 行的构造函数：

```typescript
  constructor(
    app: App,
    private readonly confirmations: SyncConfirmation[],
    private readonly onSubmit: (decisions: SyncConfirmationDecision[]) => void,
    private readonly onOpenStateChange?: (open: boolean) => void
  ) {
    super(app);
  }
```

在 `onOpen()` 方法（第 47 行）的 `const { contentEl } = this;` 之前插入一行：

```typescript
  onOpen(): void {
    this.onOpenStateChange?.(true);
    const { contentEl } = this;
```

在类中新增 `onClose` 方法（紧跟 `onOpen` 方法结束的 `}` 之后插入；如已有 `onClose` 则在其中追加该行）：

```typescript
  onClose(): void {
    this.onOpenStateChange?.(false);
    this.contentEl.empty();
  }
```

- [ ] **Step 4: 在 `RemoteSyncPlugin` 增加守卫字段**

在 `RemoteSyncPlugin` 类的私有字段区（与 `private syncStartedAt`、`private lastSyncLabel` 等相邻处）新增：

```typescript
  private confirmationModalOpen = false;
```

- [ ] **Step 5: 改 `openConfirmationModal` 接入守卫并传回调**

定位 `main.ts` 第 522-531 行的 `openConfirmationModal`，整体替换为：

```typescript
  private openConfirmationModal(confirmations: SyncConfirmation[]): void {
    if (this.confirmationModalOpen) {
      return;
    }
    new SyncConfirmationModal(
      this.app,
      confirmations,
      (confirmationDecisions) => {
        void this.runSync({
          showBusyNotice: true,
          showConfigNotice: true,
          confirmManually: false,
          confirmationDecisions
        });
      },
      (open) => {
        this.confirmationModalOpen = open;
      }
    ).open();
  }
```

- [ ] **Step 6: 让自动同步遇待确认时也弹窗**

定位 `main.ts` 第 433-444 行的 `syncAutomatically`，将其调用的 `runSync` 的 `confirmManually` 由 `false` 改为 `true`：

```typescript
  private async syncAutomatically(): Promise<AutoSyncRunResult> {
    if (this.syncStartedAt !== null && Date.now() - this.syncStartedAt < STALE_SYNC_THRESHOLD_MS) {
      return "busy";
    }

    const didRun = await this.runSync({
      showBusyNotice: false,
      showConfigNotice: false,
      confirmManually: true
    });
    return didRun ? "completed" : "skipped";
  }
```

> 守卫保证：后台轮询每 5 分钟触发一次，但若确认窗已开着，`openConfirmationModal` 直接 return，不会叠开。用户处理完一次后，下次同步若已无 pending 则状态正常保存、不再卡。

- [ ] **Step 7: 运行全部测试与类型检查**

Run: `npx vitest run`
Expected: 全部 PASS（含新增守卫测试）。

Run: `npx tsc --noEmit --skipLibCheck`
Expected: 0 errors。

- [ ] **Step 8: 提交**

```bash
git add main.ts test/main.test.ts
git commit -m "fix: auto sync surfaces pending confirmations via modal in safe mode"
```

---

## Task 2: 定义重命名映射类型并扩展 SyncOnceOptions（问题②基础）

**Files:**
- Modify: `src/sync-types.ts`（新增 `RenameMapping` 类型）
- Modify: `src/sync-engine.ts`（`SyncOnceOptions` 增加 `renames?` 字段；从 `sync-types` 导入 `RenameMapping`）
- Test: `test/sync-engine.test.ts`（仅类型层，无独立测试，下个任务覆盖行为）

- [ ] **Step 1: 在 `sync-types.ts` 新增 `RenameMapping` 类型**

在 `src/sync-types.ts` 的 `SyncConfirmationDecision` 接口（第 99-102 行）之后插入：

```typescript
export interface RenameMapping {
  from: string;
  to: string;
}
```

- [ ] **Step 2: 扩展 `SyncOnceOptions`**

定位 `src/sync-engine.ts` 第 17-19 行的 `SyncOnceOptions`，改为：

```typescript
export interface SyncOnceOptions {
  initialSyncMode?: InitialSyncMode;
  renames?: RenameMapping[];
}
```

在 `src/sync-engine.ts` 第 11 行的 import（`import { NonMergeableConflictPolicy, SyncConfirmationAction, SyncSafetyMode } from "./sync-types";`）中追加 `RenameMapping`：

```typescript
import { NonMergeableConflictPolicy, RenameMapping, SyncConfirmationAction, SyncSafetyMode } from "./sync-types";
```

- [ ] **Step 3: 运行类型检查**

Run: `npx tsc --noEmit --skipLibCheck`
Expected: 0 errors。

- [ ] **Step 4: 提交**

```bash
git add src/sync-types.ts src/sync-engine.ts
git commit -m "feat: add RenameMapping type and renames option to syncOnce"
```

---

## Task 3: 在 SyncEngine 实现 applyRenames 并从计划剔除已处理路径（问题②核心）

**Files:**
- Modify: `src/sync-engine.ts`（`syncOnce` 在 plan 后插入 rename 处理；新增私有方法 `applyRenames`）
- Test: `test/sync-engine.test.ts`（新增 rename describe 块）

**算法（已用 sequential-thinking 推演验证）：**
1. `syncOnce` 拿到 `localSnapshot`、`remoteSnapshot`、生成 `plan` 后，若 `options.renames` 非空且非初始同步，调用 `applyRenames`。
2. `applyRenames(renames, localSnapshot, remoteSnapshot, trashBatch)` 对每个 `{from, to}`：
   - 跳过条件（任一成立则不处理，留给正常 plan）：本地不存在 `to`（改名后又被删）；远端不存在 `from`（远端从无此文件，`to` 走正常 upload）；远端已存在 `to`（避免覆盖对端文件，留给 plan 判定冲突）。
   - 执行：读本地 `to` 内容 → 写远端 `to`（用本地 `to` 的 entry 作 source）→ 删远端 `from`。
   - 成功则把 `from` 与 `to` 都加入返回的 `handled: Set<string>`。
   - 单个 rename 失败（抛错）不计入 handled，记一次 failure，继续下一个。
3. 回到 `syncOnce`：用 `handled` 过滤 `plan.operations` 和 `plan.confirmations`（剔除 `path ∈ handled` 的项）。
4. 后续执行、重新快照、`saveSuccessfulSync` 全量覆盖——新路径的最新 local+remote 写入 previous，旧路径残留消失。

- [ ] **Step 1: 写失败测试 —— 重命名应在远端搬迁且不进计划/确认**

在 `test/sync-engine.test.ts` 的 `describe("SyncEngine", () => {` 内部末尾（与其它 `test(...)` 同级），新增：

```typescript
  test("rename moves remote file and skips delete/upload in safe mode", async () => {
    // 远端与本地此前同步过 old.md；用户把它重命名为 new.md（本地 old.md 消失、new.md 出现）。
    const local = new FakeStore([file("new.md", 200)], { "new.md": "hello" });
    const remote = new FakeStore([file("old.md", 100)], { "old.md": "hello" });

    const stateStore = new SyncStateStore(
      new MemoryAdapter(
        JSON.stringify({
          version: 1,
          lastSyncTime: 50,
          previousEntries: [previous(file("old.md", 100))]
        })
      )
    );

    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      syncSafetyMode: "safe"
    });

    const result = await engine.syncOnce([], {
      renames: [{ from: "old.md", to: "new.md" }]
    });

    // 远端应：写入 new.md、删除 old.md
    expect(remote.written).toContain("new.md");
    expect(remote.deleted).toContain("old.md");
    // 不应产生任何待确认（关键：重命名不该让用户解决冲突）
    expect(result.summary.pendingConfirmations).toBe(0);
    // 远端最终状态应有 new.md、无 old.md
    const remotePaths = (await remote.snapshot()).map((e) => e.path).sort();
    expect(remotePaths).toEqual(["new.md"]);
  });

  test("rename falls back to normal plan when remote lacks the source", async () => {
    // 本地新建 fresh.md 后立即改名为 renamed.md，远端从来没有过 fresh.md。
    const local = new FakeStore([file("renamed.md", 200)], { "renamed.md": "data" });
    const remote = new FakeStore([], {});

    const stateStore = new SyncStateStore(
      new MemoryAdapter(
        JSON.stringify({ version: 1, lastSyncTime: 50, previousEntries: [] })
      )
    );

    const engine = new SyncEngine(local, remote, stateStore, {
      ignorePatterns: [],
      syncSafetyMode: "safe"
    });

    const result = await engine.syncOnce([], {
      renames: [{ from: "fresh.md", to: "renamed.md" }]
    });

    // 远端不存在 fresh.md → 不搬迁；renamed.md 走正常 upload
    expect(remote.deleted).not.toContain("fresh.md");
    expect(remote.written).toContain("renamed.md");
    expect(result.summary.pendingConfirmations).toBe(0);
  });
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run test/sync-engine.test.ts -t "rename"`
Expected: FAIL —— 第一个测试会因为 safe 模式把 `old.md` 判为 `local-deleted` 确认（`pendingConfirmations` 非 0），且远端不会写 `new.md`/删 `old.md`（`renames` 尚未被消费）。

- [ ] **Step 3: 在 `syncOnce` 接入 applyRenames 与计划剔除**

定位 `src/sync-engine.ts` `syncOnce` 中生成 `plan` 之后、`const summary: SyncSummary = {` 之前（约第 134 行 plan 块结束处）。在 `plan` 赋值完成后插入 rename 处理。具体地，在如下位置（`else { plan = planSync({...}); }` 块之后、`const summary` 之前）插入：

```typescript
    const renameHandledPaths = new Set<string>();
    const renameFailures: SyncFailureDetail[] = [];
    if (!plan.initialSyncRequired && options.renames && options.renames.length > 0) {
      await this.applyRenames(
        options.renames,
        localSnapshot,
        remoteSnapshot,
        createTrashBatchName(),
        renameHandledPaths,
        renameFailures
      );
      if (renameHandledPaths.size > 0) {
        plan = {
          ...plan,
          operations: plan.operations.filter((op) => !renameHandledPaths.has(op.path)),
          confirmations: plan.confirmations.filter((c) => !renameHandledPaths.has(c.path)),
          conflicts: plan.conflicts.filter((c) => !renameHandledPaths.has(c.path))
        };
      }
    }
```

然后在 `summary` 对象初始化之后（第 44-57 行 `const summary` 块之后），把 rename 失败计入 summary。定位 `if (plan.initialSyncRequired) { return { plan, summary }; }`（约第 150 行）之前插入：

```typescript
    for (const failure of renameFailures) {
      summary.failureDetails.push(failure);
      summary.failures += 1;
    }
```

> 注意：`renameFailures` 在 `applyRenames` 内通过 `runStage` 抛出的 `SyncOperationFailure` 捕获后填充（见下一步实现）。这样一个 rename 搬迁失败会阻止本轮 `saveSuccessfulSync`（因为 `failures>0`），下轮重试时退化为正常 plan（删+增/确认），安全。

- [ ] **Step 4: 实现 `applyRenames` 私有方法**

在 `src/sync-engine.ts` 的 `SyncEngine` 类内新增方法（建议紧邻 `resolveUnmergeableTextConflict` 之后、`runStage` 之前）：

```typescript
  private async applyRenames(
    renames: RenameMapping[],
    localSnapshot: FileEntry[],
    remoteSnapshot: FileEntry[],
    trashBatch: string,
    handled: Set<string>,
    failures: SyncFailureDetail[]
  ): Promise<void> {
    const localByPath = new Map(localSnapshot.map((entry) => [entry.path, entry]));
    const remoteByPath = new Map(remoteSnapshot.map((entry) => [entry.path, entry]));

    for (const { from, to } of renames) {
      if (from === to) {
        continue;
      }
      const localTarget = localByPath.get(to);
      const remoteSource = remoteByPath.get(from);
      const remoteTargetExists = remoteByPath.has(to);

      // 本地无新文件（改名后又删）、远端无旧文件（远端从无此文件）、
      // 或远端已存在新文件（避免覆盖对端）—— 任一成立则不搬迁，交给正常计划处理。
      if (!localTarget || !remoteSource || remoteTargetExists) {
        continue;
      }

      try {
        const content = await this.runStage(to, "upload", () => this.local.readFile(to));
        await this.runStage(to, "upload", () => this.remote.writeFile(to, content, localTarget));
        await this.runStage(from, "delete-remote", () => this.remote.deleteFile(from));
        handled.add(from);
        handled.add(to);
      } catch (error) {
        if (error instanceof SyncOperationFailure) {
          failures.push(error.detail);
        } else {
          failures.push({ path: to, stage: "upload", message: formatError(error) });
        }
      }
    }
  }
```

> `trashBatch` 形参保留以与其它执行方法签名一致（远端搬迁本身不产生本地回收站项，可暂不使用；若 lint 报未使用，可在方法体首行加 `void trashBatch;`）。

确认 `SyncOperationFailure` 暴露了 `detail` 属性——若没有，检查该类定义并改用其公开字段（如 `error.path`/`error.stage`/`error.message`）构造 `SyncFailureDetail`。

- [ ] **Step 5: 运行 rename 测试，确认通过**

Run: `npx vitest run test/sync-engine.test.ts -t "rename"`
Expected: 两个 rename 测试 PASS。

- [ ] **Step 6: 运行全部测试与类型检查**

Run: `npx vitest run`
Expected: 全部 PASS（原 90 + 新增）。

Run: `npx tsc --noEmit --skipLibCheck`
Expected: 0 errors。

- [ ] **Step 7: 提交**

```bash
git add src/sync-engine.ts test/sync-engine.test.ts
git commit -m "feat: resolve renames as remote move and exclude from plan"
```

---

## Task 4: AutoSyncController 记录并交出重命名映射

**Files:**
- Modify: `src/auto-sync-controller.ts`（`handleVaultRename` 记录映射；新增 `takePendingRenames()`；链式合并 A→B→C）
- Test: `test/auto-sync-controller.test.ts`

**背景：** `handleVaultRename(path, oldPath)` 当前丢弃 `oldPath`。本任务把 `oldPath → path` 记入内部 Map，提供 `takePendingRenames()` 供 `main.ts` 在同步前取出（取出即清空）。需处理链式重命名：先 A→B，再 B→C，应合并为 A→C。

- [ ] **Step 1: 写失败测试 —— 记录与取出重命名映射，含链式合并**

在 `test/auto-sync-controller.test.ts` 末尾（最后一个 `});` 之前，新增。先确认文件顶部已 import `RenameMapping`（若无则实现时补 import）：

```typescript
  test("records rename mappings and hands them out once", async () => {
    const sync = vi.fn(async () => "completed" as const);
    const controller = new AutoSyncController({
      sync,
      shouldIgnorePath: () => false
    });

    controller.handleVaultRename("b.md", "a.md");
    expect(controller.takePendingRenames()).toEqual([{ from: "a.md", to: "b.md" }]);
    // 取出后应清空
    expect(controller.takePendingRenames()).toEqual([]);
  });

  test("collapses chained renames a -> b -> c into a -> c", async () => {
    const sync = vi.fn(async () => "completed" as const);
    const controller = new AutoSyncController({
      sync,
      shouldIgnorePath: () => false
    });

    controller.handleVaultRename("b.md", "a.md");
    controller.handleVaultRename("c.md", "b.md");
    expect(controller.takePendingRenames()).toEqual([{ from: "a.md", to: "c.md" }]);
  });

  test("ignores rename when both paths are ignored", async () => {
    const sync = vi.fn(async () => "completed" as const);
    const controller = new AutoSyncController({
      sync,
      shouldIgnorePath: (p) => p.startsWith(".obsidian/")
    });

    controller.handleVaultRename(".obsidian/new.json", ".obsidian/old.json");
    expect(controller.takePendingRenames()).toEqual([]);
  });
```

确认 `test/auto-sync-controller.test.ts` 顶部已 `import { vi } from "vitest";`（现有测试已用 `vi.useFakeTimers()`，应已导入）。

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run test/auto-sync-controller.test.ts -t "rename"`
Expected: FAIL —— `takePendingRenames` 不存在（类型错误或运行时 undefined）。

- [ ] **Step 3: 在 `AutoSyncController` 实现映射记录与取出**

在 `src/auto-sync-controller.ts` 顶部新增 import：

```typescript
import { RenameMapping } from "./sync-types";
```

在类的私有字段区（`private pendingPaths = new Set<string>();` 之后）新增：

```typescript
  private pendingRenames = new Map<string, string>();
```

将 `handleVaultRename`（第 33-41 行）整体替换为：

```typescript
  handleVaultRename(path: string, oldPath: string): void {
    if (this.options.shouldIgnorePath(path) && this.options.shouldIgnorePath(oldPath)) {
      return;
    }

    this.recordRename(oldPath, path);
    this.pendingPaths.add(path);
    this.options.onPendingChange?.(this.pendingPaths.size);
    this.requestSync();
  }

  takePendingRenames(): RenameMapping[] {
    const renames = [...this.pendingRenames.entries()].map(([from, to]) => ({ from, to }));
    this.pendingRenames.clear();
    return renames;
  }

  private recordRename(from: string, to: string): void {
    // 链式合并：若存在 X -> from，则更新为 X -> to（删除中间态 from）。
    let origin = from;
    for (const [existingFrom, existingTo] of this.pendingRenames.entries()) {
      if (existingTo === from) {
        origin = existingFrom;
        this.pendingRenames.delete(existingFrom);
        break;
      }
    }
    if (origin === to) {
      // 改回原名，净效果为空：移除该链。
      this.pendingRenames.delete(origin);
      return;
    }
    this.pendingRenames.set(origin, to);
  }
```

- [ ] **Step 4: 运行 rename 测试，确认通过**

Run: `npx vitest run test/auto-sync-controller.test.ts -t "rename"`
Expected: 三个测试 PASS。

- [ ] **Step 5: 运行全部测试与类型检查**

Run: `npx vitest run`
Expected: 全部 PASS。

Run: `npx tsc --noEmit --skipLibCheck`
Expected: 0 errors。

- [ ] **Step 6: 提交**

```bash
git add src/auto-sync-controller.ts test/auto-sync-controller.test.ts
git commit -m "feat: track rename mappings in AutoSyncController with chain collapse"
```

---

## Task 5: main.ts 把重命名映射透传给同步引擎

**Files:**
- Modify: `main.ts`（`runSync` 取出 controller 的 pending renames 并传给 `syncOnce`）
- Test: 依赖现有测试 + 末尾手动回归

**背景：** Task 3 让引擎能消费 `renames`，Task 4 让 controller 能交出映射。本任务在 `main.ts` 把两者接通——`runSync` 调 `syncOnce` 前从 `autoSyncController` 取出 renames 传入。

- [ ] **Step 1: 在 `runSync` 取出并透传 renames**

定位 `main.ts` 第 486-489 行：

```typescript
      const result = await this.createEngine().syncOnce(options.confirmationDecisions, {
        initialSyncMode: options.initialSyncMode ?? "ask"
      });
```

替换为：

```typescript
      const renames = this.autoSyncController?.takePendingRenames() ?? [];
      const result = await this.createEngine().syncOnce(options.confirmationDecisions, {
        initialSyncMode: options.initialSyncMode ?? "ask",
        renames
      });
```

> 说明：`takePendingRenames()` 取出即清空，保证同一批重命名只被消费一次。手动同步和自动同步都经过 `runSync`，因此两条路径都会带上 pending renames。若 `autoSyncController` 尚未初始化（理论上 `runSync` 都在 `onload` 后调用），`?? []` 兜底为空。

- [ ] **Step 2: 运行全部测试与类型检查**

Run: `npx vitest run`
Expected: 全部 PASS。

Run: `npx tsc --noEmit --skipLibCheck`
Expected: 0 errors。

- [ ] **Step 3: 提交**

```bash
git add main.ts
git commit -m "feat: pass pending renames from controller into syncOnce"
```

---

## Task 6: 构建产物并手动回归验收

**Files:**
- Modify: `main.js`（构建产物）
- 无新测试；执行构建 + 人工验收清单

- [ ] **Step 1: 全量测试 + 类型检查 + 构建**

Run: `npm test`
Expected: 全部 PASS。

Run: `npm run build`
Expected: tsc 0 errors，esbuild 成功，`main.js` 更新。

- [ ] **Step 2: 提交构建产物**

```bash
git add main.js
git commit -m "build: rebuild bundle for rename tracking and safe confirm"
```

- [ ] **Step 3: 人工验收清单（部署到测试库后由用户执行）**

> 这些场景无法用单测完全覆盖，需在 Obsidian 测试库实测。部署时严禁触碰 `data.json`。

| 验收项 | 操作 | 期望 |
|---|---|---|
| 问题①-删除确认生效 | safe 模式下，在一端删除某文件并同步 | 弹出确认窗；点"接受删除"后该文件两端删除，状态栏变"成功"，不再卡"待同步" |
| 问题①-自动同步弹窗 | safe 模式下，等待后台轮询触发遇到待确认 | 自动弹出确认窗（不重复叠开多个窗）；处理后状态保存 |
| 问题②-重命名不冲突 | 把已同步的笔记 `A.md` 重命名为 `B.md`，等同步 | 不弹冲突确认；远端出现 `B.md`、`A.md` 消失；状态栏"成功" |
| 问题②-链式重命名 | 快速 `A.md`→`B.md`→`C.md` 后等同步 | 远端最终只有 `C.md`，无中间残留，不弹确认 |
| 回归-正常删除 | balanced 模式下删除文件 | 仍自动传播删除，不弹窗（语义未变） |

---

## 自检（计划完成后由作者执行）

**1. Spec 覆盖：**
- 问题①（safe 模式自动同步卡死）→ Task 1 ✓
- 问题②（重命名误判冲突）→ Task 2（类型）+ Task 3（引擎核心）+ Task 4（controller 记录）+ Task 5（透传）✓
- 构建与验收 → Task 6 ✓

**2. Placeholder 扫描：** 无 TBD / "适当处理" / 无代码的步骤。每个改动步骤都给出完整代码与精确行号定位。

**3. 类型一致性：**
- `RenameMapping {from,to}` 在 Task 2 定义，Task 3（`SyncOnceOptions.renames`、`applyRenames` 形参）、Task 4（`takePendingRenames(): RenameMapping[]`）、Task 5（透传）一致使用。
- `takePendingRenames` 命名在 Task 4 定义、Task 5 调用，一致。
- `handled: Set<string>`、`renameHandledPaths` 在 Task 3 内自洽。
- `SyncFailureDetail` 复用 `sync-engine.ts` 既有类型；`applyRenames` 的失败构造与之匹配（Step 4 提示校验 `SyncOperationFailure.detail`）。

**潜在风险提示给实现者：**
- Task 3 Step 4 依赖 `SyncOperationFailure` 有可读的 `detail`/字段——实现前先 `find_symbol SyncOperationFailure` 确认其结构。
- Task 1 的弹窗守卫集成测试较弱（受 Obsidian Modal 限制），核心靠人工回归；实现者若能在 `main.test.ts` 用现有 mock 直接实例化插件并断言 `confirmationModalOpen` 字段流转，应优先那样做。
