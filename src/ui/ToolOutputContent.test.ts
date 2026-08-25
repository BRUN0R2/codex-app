import { describe, expect, it } from "vitest";

import {
  projectImageToolOutput,
  projectSearchOutput,
  projectSourceOutput,
} from "./toolOutputProjection";

describe("tool output content", () => {
  it("preserves read_file line numbers, indentation and multiline syntax state", () => {
    const projection = projectSourceOutput(
      [
        "20:     const LIMIT: usize = 1_024;",
        "21:     /* comentário",
        "22:        continua */",
      ].join("\n"),
      "src/main.rs",
    );

    expect(projection?.lines.map((line) => [line.number, line.content])).toEqual([
      [20, "    const LIMIT: usize = 1_024;"],
      [21, "    /* comentário"],
      [22, "       continua */"],
    ]);
    expect(projection?.lines[0]?.tokens?.some((token) => token.kind === "keyword")).toBe(true);
    expect(projection?.lines[1]?.tokens?.some((token) => token.kind === "comment")).toBe(true);
    expect(projection?.lines[2]?.tokens?.map((token) => token.kind)).toEqual(["comment"]);
    expect(projection).toMatchObject({ lineNumberDigits: 2 });
    expect(projection?.maximumColumns).toBeGreaterThan(1);
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

  it("decodes only the closed view_image envelope and safe image origins", () => {
    const svg =
      "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E";

    expect(projectImageToolOutput(JSON.stringify({ image_url: svg }))).toBe(svg);
    expect(
      projectImageToolOutput(JSON.stringify({ image_url: "https://example.com/image.png" })),
    ).toBe("https://example.com/image.png");
    expect(
      projectImageToolOutput(JSON.stringify({ image_url: "file:///C:/secret.png" })),
    ).toBeNull();
    expect(projectImageToolOutput(JSON.stringify({ image_url: svg, unexpected: true }))).toBeNull();
    expect(projectImageToolOutput("not JSON")).toBeNull();
  });
});
