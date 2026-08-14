import { describe, expect, it } from "vitest";

import { containsContentReferenceMarker, presentAssistantText } from "./contentReferenceMarkers";

describe("assistant content-reference presentation", () => {
  it("removes the same private-use envelope stripped by Codex Desktop", () => {
    expect(
      presentAssistantText("Antes. \uE200cite\uE202turn0search0\uE202turn0search5\uE201 Depois."),
    ).toBe("Antes.  Depois.");
  });

  it("removes multiple envelopes without consuming ordinary text", () => {
    expect(presentAssistantText("A\uE200cite\uE202one\uE201B\uE200source\uE202two\uE201C")).toBe(
      "ABC",
    );
  });

  it("hides an unfinished streaming envelope until its closing delimiter arrives", () => {
    expect(presentAssistantText("Resposta segura \uE200cite\uE202turn0sea")).toBe(
      "Resposta segura ",
    );
  });

  it("leaves assistant text on the allocation-free fast path semantically unchanged", () => {
    const text = "Resposta sem metadados internos.";
    expect(presentAssistantText(text)).toBe(text);
    expect(containsContentReferenceMarker(text)).toBe(false);
    expect(containsContentReferenceMarker("\uE200cite\uE201")).toBe(true);
  });
});
