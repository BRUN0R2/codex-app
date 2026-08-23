import { describe, expect, it } from "vitest";

import { projectSearchOutput, projectSourceOutput } from "./ToolOutputContent";

describe("tool output content", () => {
  it("preserves read_file line numbers, indentation and multiline syntax state", () => {
    const lines = projectSourceOutput(
      [
        "20:     const LIMIT: usize = 1_024;",
        "21:     /* comentário",
        "22:        continua */",
      ].join("\n"),
      "src/main.rs",
    );

    expect(lines?.map((line) => [line.number, line.content])).toEqual([
      [20, "    const LIMIT: usize = 1_024;"],
      [21, "    /* comentário"],
      [22, "       continua */"],
    ]);
    expect(lines?.[0]?.tokens?.some((token) => token.kind === "keyword")).toBe(true);
    expect(lines?.[1]?.tokens?.some((token) => token.kind === "comment")).toBe(true);
    expect(lines?.[2]?.tokens?.map((token) => token.kind)).toEqual(["comment"]);
  });

  it("rejects malformed numbered source instead of guessing its structure", () => {
    expect(projectSourceOutput("source without a line number", "src/main.rs")).toBeNull();
  });

  it("uses each search result path to select its syntax language", () => {
    const lines = projectSearchOutput(
      [
        "src/main.rs:42:const LIMIT: usize = 1_024;",
        "src/App.tsx:18:export const ready = true;",
        "No matches found.",
      ].join("\n"),
    );

    expect(lines[0]?.type).toBe("match");
    expect(
      lines[0]?.type === "match"
        ? lines[0].tokens?.some((token) => token.kind === "keyword")
        : false,
    ).toBe(true);
    expect(lines[1]?.type).toBe("match");
    expect(lines[2]).toEqual({ content: "No matches found.", type: "text" });
  });
});
