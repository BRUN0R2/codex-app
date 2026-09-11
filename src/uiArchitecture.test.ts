import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SOURCE_IMPORT = /(?:from\s+|import\s*)["'][^"']*infrastructure\//u;

describe("UI architecture", () => {
  it("keeps IPC infrastructure outside presentation modules", async () => {
    const uiDirectory = path.join(process.cwd(), "src", "ui");
    const sourceFiles = [
      ...(await collectTypeScriptFiles(uiDirectory)),
      path.join(process.cwd(), "src", "App.tsx"),
      path.join(process.cwd(), "src", "NotificationOverlayApp.tsx"),
    ];
    const violations: string[] = [];

    for (const sourceFile of sourceFiles) {
      const source = await readFile(sourceFile, "utf8");
      if (SOURCE_IMPORT.test(source)) {
        violations.push(path.relative(process.cwd(), sourceFile));
      }
    }

    expect(violations).toEqual([]);
  });
});

async function collectTypeScriptFiles(directory: string): Promise<readonly string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) return collectTypeScriptFiles(entryPath);
      return entry.isFile() && /\.tsx?$/u.test(entry.name) ? [entryPath] : [];
    }),
  );
  return nested.flat();
}
