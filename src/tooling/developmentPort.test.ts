import { describe, expect, it } from "vitest";

import { DEFAULT_DEVELOPMENT_PORT, resolveDevelopmentPort } from "./developmentPort";

describe("development port", () => {
  it("uses the default only when no explicit value is configured", () => {
    expect(resolveDevelopmentPort(undefined)).toBe(DEFAULT_DEVELOPMENT_PORT);
  });

  it("accepts explicit integers inside the TCP port range", () => {
    expect(resolveDevelopmentPort("1")).toBe(1);
    expect(resolveDevelopmentPort("1420")).toBe(1420);
    expect(resolveDevelopmentPort("65535")).toBe(65535);
  });

  it("rejects malformed or out-of-range values instead of falling back", () => {
    for (const value of ["", "0", "65536", "-1", "1420.5", "1420abc", "not-a-port"]) {
      expect(() => resolveDevelopmentPort(value)).toThrow(/between 1 and 65535/u);
    }
  });
});
