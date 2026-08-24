import { describe, expect, it } from "vitest";

import { outputDetailLabel } from "./outputDetail";

describe("output detail options", () => {
  it("uses the model default label when no override is selected", () => {
    expect(outputDetailLabel(null)).toBe("Padrão do modelo");
    expect(outputDetailLabel("low")).toBe("Baixo");
    expect(outputDetailLabel("medium")).toBe("Médio");
    expect(outputDetailLabel("high")).toBe("Alto");
  });
});
