import { describe, expect, it } from "vitest";

import { createDiffDocument } from "./diffDocument";
import { DiffSyntaxHighlighter } from "./syntax/diffHighlighter";
import { projectSearchOutput, projectSourceOutput } from "./toolOutputProjection";

describe("code presentation whitespace", () => {
  it.each(["", "  ", "      ", "              ", "\t", " \t"])(
    "preserves the exact source prefix %j across diffs, reads, and searches",
    (prefix) => {
      const content = `${prefix}clientHeight: currentViewport.clientHeight,`;
      const path = "sizing.ts";
      const diff = createDiffDocument(`@@ -0,0 +1 @@\n+${content}`);
      expect(diff.unifiedRows[0]?.content).toBe(content);
      expect(diff.splitProjection().rows[0]?.rightContent).toBe(content);
      expect(
        new DiffSyntaxHighlighter()
          .render(diff, path, 0)
          ?.map((token) => token.text)
          .join(""),
      ).toBe(content);

      const source = projectSourceOutput(`1958: ${content}`, path);
      expect(source?.lines[0]?.content).toBe(content);
      expect(
        source
          ?.tokensAt(0)
          ?.map((token) => token.text)
          .join(""),
      ).toBe(content);

      const match = projectSearchOutput(`${path}:1958:${content}`)[0];
      expect(match?.type).toBe("match");
      if (match?.type !== "match") throw new Error("The search fixture did not produce a match.");
      expect(match.content).toBe(content);
      expect(match.tokens?.map((token) => token.text).join("")).toBe(content);
    },
  );
});
