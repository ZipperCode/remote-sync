import { describe, expect, test } from "vitest";
import { FileEntry, PreviousEntry, planSync } from "../src/sync-planner";

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

const previous = (entry: FileEntry): PreviousEntry => ({
  path: entry.path,
  local: entry,
  remote: entry
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

  test("deletes remote file when local deletion is detected", () => {
    const old = file("deleted.md", 100);
    const plan = planSync({
      local: [],
      remote: [old],
      previous: [previous(old)],
      ignorePatterns: []
    });

    expect(plan.operations).toEqual([
      expect.objectContaining({ kind: "delete-remote", path: "deleted.md" })
    ]);
  });

  test("deletes local file when remote deletion is detected", () => {
    const old = file("deleted.md", 100);
    const plan = planSync({
      local: [old],
      remote: [],
      previous: [previous(old)],
      ignorePatterns: []
    });

    expect(plan.operations).toEqual([
      expect.objectContaining({ kind: "delete-local", path: "deleted.md" })
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
        suggestedKind: "upload"
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
      expect.objectContaining({ path: "note.md", reason: "same-mtime-different-size" })
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
      ".remote-sync-trash/20260518/old.md",
      "Notes/draft.md",
      "dist/app.js"
    ]);
  });
});
