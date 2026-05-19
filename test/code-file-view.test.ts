import { describe, expect, it } from "vitest";

import {
  getCodeLanguageLabel,
  isSupportedCodeExtension,
  SUPPORTED_CODE_EXTENSIONS
} from "../src/code-file-view";

describe("code file view extension mapping", () => {
  it("registers the expected code extensions without taking over markdown", () => {
    expect(SUPPORTED_CODE_EXTENSIONS).toEqual([
      "css",
      "html",
      "js",
      "json",
      "jsx",
      "py",
      "ts",
      "tsx",
      "xml",
      "yaml",
      "yml"
    ]);
    expect(SUPPORTED_CODE_EXTENSIONS).not.toContain("md");
  });

  it("matches supported extensions case-insensitively", () => {
    expect(isSupportedCodeExtension("ts")).toBe(true);
    expect(isSupportedCodeExtension("TSX")).toBe(true);
    expect(isSupportedCodeExtension("Md")).toBe(false);
  });

  it("returns a readable language label and falls back to plain text", () => {
    expect(getCodeLanguageLabel("json")).toBe("JSON");
    expect(getCodeLanguageLabel("yml")).toBe("YAML");
    expect(getCodeLanguageLabel(null)).toBe("Plain text");
    expect(getCodeLanguageLabel("txt")).toBe("Plain text");
  });
});
