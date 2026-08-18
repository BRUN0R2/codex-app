import { describe, expect, it } from "vitest";

import { createMarkdownStreamRenderer } from "./markdownStreamRenderer";

describe("incremental Markdown renderer", () => {
  it("commits completed blocks and rerenders only the unstable tail", () => {
    const renderer = createMarkdownStreamRenderer((source) => source);
    const first = renderer.render("First paragraph.\n\nSec", "append");
    expect(first.appendHtml).toContain("First paragraph.");
    expect(first.tailHtml).toContain("Sec");

    const delta = renderer.render("First paragraph.\n\nSecond paragraph.", "append");
    expect(delta.reset).toBe(false);
    expect(delta.appendHtml).toBe("");
    expect(delta.tailHtml).toContain("Second paragraph.");

    const nextBlock = renderer.render(
      "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
      "append",
    );
    expect(nextBlock.appendHtml).toContain("Second paragraph.");
    expect(nextBlock.tailHtml).toContain("Third paragraph.");
  });

  it("performs one authoritative full render when streaming finishes", () => {
    const renderer = createMarkdownStreamRenderer((source) => source);
    renderer.render("A [reference][id]", "append");
    const completed = renderer.render("A [reference][id]\n\n[id]: https://example.com", "final");
    expect(completed.reset).toBe(true);
    expect(completed.appendHtml).toBe("A [reference][id]\n\n[id]: https://example.com");
    expect(completed.tailHtml).toBe("");
  });

  it("accepts an authoritative final render produced by a worker", () => {
    const renderer = createMarkdownStreamRenderer((source) => source);
    renderer.render("Partial", "append");
    const completed = renderer.finalize("Complete", "<p>Complete</p>");
    expect(completed).toEqual({
      appendHtml: "<p>Complete</p>",
      reset: true,
      tailHtml: "",
    });
    expect(renderer.render("Complete and streaming again", "append").reset).toBe(true);
  });

  it("resets an append stream when its source shrinks or is replaced in place", () => {
    const shrinking = createMarkdownStreamRenderer((source) => source);
    shrinking.render("Long response", "append");
    expect(shrinking.render("Short", "append").reset).toBe(true);

    const replacing = createMarkdownStreamRenderer((source) => source);
    replacing.render("first", "append");
    expect(replacing.render("other", "append").reset).toBe(true);
  });
});
