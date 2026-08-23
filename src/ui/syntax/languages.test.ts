import { describe, expect, it } from "vitest";

import { syntaxLanguageFromAlias, syntaxLanguageFromPath } from "./languages";

describe("syntax language registry", () => {
  it("resolves paths and exact filenames deterministically", () => {
    expect(
      [
        "src/main.rs",
        "src/App.tsx",
        "scripts/release.ps1",
        "Cargo.toml",
        "Dockerfile",
        "unknown.asset",
      ].map(syntaxLanguageFromPath),
    ).toEqual(["rust", "typescript", "powershell", "toml", "bash", "plainText"]);
  });

  it("normalizes Markdown fence aliases without language detection", () => {
    expect(
      ["rs", "typescript no_run", "jsonc", "shell", "unknown"].map(syntaxLanguageFromAlias),
    ).toEqual(["rust", "typescript", "json", "bash", "plainText"]);
  });
});
