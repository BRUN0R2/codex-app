import { describe, expect, it } from "vitest";

import { createCommentaryPresentation } from "./messagePresentation";

describe("commentary presentation", () => {
  it("represents empty commentary without an absent textual accessor", () => {
    expect(createCommentaryPresentation(" \n ")).toEqual({
      text: "",
      visible: false,
    });
  });

  it("removes private content references before rendering Markdown", () => {
    expect(
      createCommentaryPresentation(
        "Primeira linha\uE200cite\uE202turn0search0\uE201\nSegunda linha",
      ),
    ).toEqual({
      text: "Primeira linha\nSegunda linha",
      visible: true,
    });
  });
});
