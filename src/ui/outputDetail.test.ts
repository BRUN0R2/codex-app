import { describe, expect, it } from "vitest";

import { OUTPUT_DETAIL_OPTIONS, outputDetailLabel } from "./outputDetail";

describe("output detail options", () => {
  it("keeps the model default first and exposes every supported override", () => {
    expect(OUTPUT_DETAIL_OPTIONS.map((option) => option.value)).toEqual([
      null,
      "low",
      "medium",
      "high",
    ]);
  });

  it("uses the model default label when no override is selected", () => {
    expect(outputDetailLabel(null)).toBe("Padrão do modelo");
    expect(outputDetailLabel("low")).toBe("Baixo");
    expect(outputDetailLabel("medium")).toBe("Médio");
    expect(outputDetailLabel("high")).toBe("Alto");
  });
});
