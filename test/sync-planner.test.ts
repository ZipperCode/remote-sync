import { describe, expect, test } from "vitest";
import { FileEntry, PreviousEntry, planSync } from "../src/sync-planner";
import { MAX_MERGE_BASE_BYTES } from "../src/text-merge";

const file = (
  path: string,
  mtime: number,
  size = 10,
  etag?: string
): FileEntry => ({
  path,
  type: "file",
  mtime,
  size,
  etag
});

const previous = (entry: FileEntry, baseContent?: string): PreviousEntry => ({
  path: entry.path,
  local: entry,
  remote: entry,
  mergeBase: baseContent
    ? {
        source: "previous-sync-state",
        content: baseContent
      }
    : undefined
});

describe("SyncPlanner", () => {
  test("uploads local-only files and downloads remote-only files", () => {
    const plan = planSync({
      local: [file("local.md", 100)],
      remote: [file("remote.md", 100)],
      previous: [],
      ignorePatterns: []
    });

    expect(plan.operations.map((op) => op.kind)).toEqual(["upload", "download"]);
    expect(plan.conflicts).toEqual([]);
  });

  test("requires confirmation before deleting remote file when local deletion is detected", () => {
    const old = file("deleted.md", 100);
    const plan = planSync({
      local: [],
      remote: [old],
      previous: [previous(old)],
      ignorePatterns: []
    });

    expect(plan.operations).toEqual([]);
    expect(plan.confirmations).toEqual([
      expect.objectContaining({
        path: "deleted.md",
        reason: "local-deleted",
        conflictType: "delete-vs-modify"
      })
    ]);
  });

  test("requires confirmation before deleting local file when remote deletion is detected", () => {
    const old = file("deleted.md", 100);
    const plan = planSync({
      local: [old],
      remote: [],
      previous: [previous(old)],
      ignorePatterns: []
    });

    expect(plan.operations).toEqual([]);
    expect(plan.confirmations).toEqual([
      expect.objectContaining({
        path: "deleted.md",
        reason: "remote-deleted",
        conflictType: "delete-vs-modify"
      })
    ]);
  });

  test("auto-propagates simple deletes in balanced mode", () => {
    const oldLocal = file("local-deleted.md", 100);
    const oldRemote = file("remote-deleted.md", 100);
    const plan = planSync({
      local: [oldRemote],
      remote: [oldLocal],
      previous: [previous(oldLocal), previous(oldRemote)],
      ignorePatterns: [],
      syncSafetyMode: "balanced",
      maxAutoDeleteRatio: 1
    });

    expect(plan.confirmations).toEqual([]);
    expect(plan.operations).toEqual([
      expect.objectContaining({
        kind: "delete-remote",
        path: "local-deleted.md",
        reason: "local-deleted"
      }),
      expect.objectContaining({
        kind: "delete-local",
        path: "remote-deleted.md",
        reason: "remote-deleted"
      })
    ]);
  });

  test("keeps delete-vs-modify conflicts manual in balanced mode", () => {
    const old = file("deleted.md", 100, 10);
    const plan = planSync({
      local: [file("deleted.md", 300, 12)],
      remote: [],
      previous: [previous(old)],
      ignorePatterns: [],
      syncSafetyMode: "balanced",
      maxAutoDeleteRatio: 1
    });

    expect(plan.operations).toEqual([]);
    expect(plan.confirmations).toEqual([
      expect.objectContaining({
        path: "deleted.md",
        reason: "remote-deleted-local-changed",
        conflictType: "delete-vs-modify"
      })
    ]);
  });

  test("downgrades large balanced delete batches to confirmations", () => {
    const deletedA = file("deleted-a.md", 100);
    const deletedB = file("deleted-b.md", 100);
    const kept = file("kept.md", 100);
    const plan = planSync({
      local: [deletedA, deletedB, kept],
      remote: [kept],
      previous: [previous(deletedA), previous(deletedB), previous(kept)],
      ignorePatterns: [],
      syncSafetyMode: "balanced",
      maxAutoDeleteRatio: 0.3
    });

    expect(plan.operations).toEqual([]);
    expect(plan.confirmations).toEqual([
      expect.objectContaining({ path: "deleted-b.md", reason: "remote-deleted" }),
      expect.objectContaining({ path: "deleted-a.md", reason: "remote-deleted" })
    ]);
  });

  test("marks mergeable text conflicts as auto-merge candidates", () => {
    const old = file("note.md", 100, 10);
    const plan = planSync({
      local: [file("note.md", 300, 12)],
      remote: [file("note.md", 200, 12)],
      previous: [previous(old, "base\n")],
      ignorePatterns: []
    });

    expect(plan.operations).toEqual([]);
    expect(plan.confirmations).toEqual([
      expect.objectContaining({
        path: "note.md",
        reason: "both-changed",
        conflictType: "text-auto-merge",
        suggestedKind: "merge"
      })
    ]);
  });

  test("downgrades oversized text conflicts to manual review", () => {
    const old = file("big.md", 100, 10);
    const plan = planSync({
      local: [file("big.md", 300, MAX_MERGE_BASE_BYTES + 1)],
      remote: [file("big.md", 200, MAX_MERGE_BASE_BYTES + 1)],
      previous: [previous(old, "base\n")],
      ignorePatterns: []
    });

    expect(plan.operations).toEqual([]);
    expect(plan.confirmations).toEqual([
      expect.objectContaining({
        path: "big.md",
        reason: "both-changed",
        conflictType: "text-too-large"
      })
    ]);
  });

  test("keeps binary conflicts manual", () => {
    const old = file("image.png", 100, 10);
    const plan = planSync({
      local: [file("image.png", 300, 12)],
      remote: [file("image.png", 200, 12)],
      previous: [previous(old)],
      ignorePatterns: []
    });

    expect(plan.operations).toEqual([]);
    expect(plan.confirmations).toEqual([
      expect.objectContaining({
        path: "image.png",
        conflictType: "binary"
      })
    ]);
  });

  test("requires confirmation when both sides changed since the previous sync", () => {
    const old = file("note.md", 100, 10, "old");
    const plan = planSync({
      local: [file("note.md", 300, 12, "local")],
      remote: [file("note.md", 200, 12, "remote")],
      previous: [previous(old)],
      ignorePatterns: []
    });

    expect(plan.operations).toEqual([]);
    expect(plan.confirmations).toEqual([
      expect.objectContaining({
        path: "note.md",
        reason: "both-changed",
        conflictType: "text-no-base"
      })
    ]);
  });

  test("marks delete-vs-modify conflicts for manual resolution", () => {
    const old = file("deleted.md", 100, 10);
    const plan = planSync({
      local: [file("deleted.md", 300, 12)],
      remote: [],
      previous: [previous(old)],
      ignorePatterns: []
    });

    expect(plan.operations).toEqual([]);
    expect(plan.confirmations).toEqual([
      expect.objectContaining({
        path: "deleted.md",
        reason: "remote-deleted-local-changed",
        conflictType: "delete-vs-modify"
      })
    ]);
  });

  test("records conflict when mtimes match but sizes differ", () => {
    const old = file("note.md", 100, 10);
    const plan = planSync({
      local: [file("note.md", 200, 11)],
      remote: [file("note.md", 200, 12)],
      previous: [previous(old)],
      ignorePatterns: []
    });

    expect(plan.operations).toEqual([]);
    expect(plan.confirmations).toEqual([
      expect.objectContaining({
        path: "note.md",
        reason: "same-mtime-different-size",
        conflictType: "text-no-base"
      })
    ]);
  });

  test("skips ignored paths before planning", () => {
    const plan = planSync({
      local: [file(".obsidian/workspace.json", 100), file("Notes/public.md", 100)],
      remote: [file("Notes/private/secret.md", 100)],
      previous: [],
      ignorePatterns: ["Notes/private/**"]
    });

    expect(plan.operations).toEqual([
      expect.objectContaining({ kind: "upload", path: "Notes/public.md" })
    ]);
    expect(plan.skipped.map((entry) => entry.path).sort()).toEqual([
      ".obsidian/workspace.json",
      "Notes/private/secret.md"
    ]);
  });

  test("applies gitignore-like ignore rules in order", () => {
    const plan = planSync({
      local: [
        file("dist/app.js", 100),
        file("dist/keep.js", 100),
        file("Notes/draft.md", 100),
        file("Notes/public.md", 100),
        file(".remote-sync-trash/20260518/old.md", 100)
      ],
      remote: [],
      previous: [],
      ignorePatterns: [
        "",
        "# generated output",
        "dist/",
        "!dist/keep.js",
        "Notes/*.md",
        "!Notes/public.md"
      ]
    });

    expect(plan.operations.map((op) => op.path).sort()).toEqual([
      "Notes/public.md",
      "dist/keep.js"
    ]);
    expect(plan.skipped.map((entry) => entry.path).sort()).toEqual([
      "Notes/draft.md",
      "dist/app.js"
    ]);
  });
});
