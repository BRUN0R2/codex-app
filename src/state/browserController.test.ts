import { describe, expect, it } from "vitest";

import { normalizeBrowserAddress } from "./browserController";

describe("browser address normalization", () => {
  it("normalizes hosts, local development URLs, and searches deterministically", () => {
    expect(normalizeBrowserAddress("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeBrowserAddress("localhost:1420/test")).toBe("http://localhost:1420/test");
    expect(normalizeBrowserAddress("virtualização de listas")).toBe(
      "https://www.google.com/search?q=virtualiza%C3%A7%C3%A3o%20de%20listas",
    );
    expect(normalizeBrowserAddress("about:blank")).toBe("about:blank");
  });

  it("rejects executable schemes and embedded credentials", () => {
    expect(() => normalizeBrowserAddress("javascript:alert(1)")).toThrow("HTTP(S)");
    expect(() => normalizeBrowserAddress("https://user:secret@example.com")).toThrow("credenciais");
    expect(() => normalizeBrowserAddress("\n")).toThrow("vazio ou inválido");
  });
});
