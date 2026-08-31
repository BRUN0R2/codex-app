import { describe, expect, it } from "vitest";

import { describeDiagnosticError, describeError } from "./errorDescription";

describe("error descriptions", () => {
  it("keeps the concise command error for the interface", () => {
    expect(
      describeError({
        code: "invalid_request",
        message: "The request is invalid.",
        retryable: false,
      }),
    ).toBe("The request is invalid.");
  });

  it("unwraps generic framework errors to the original command failure", () => {
    const commandError = {
      code: "invalid_attachment",
      message: "The attached file is no longer available.",
      retryable: false,
    };
    const wrapped = new Error("Unknown error", { cause: commandError });

    expect(describeError(wrapped)).toBe("The attached file is no longer available.");
  });

  it("preserves the complete error cause chain for diagnostics", () => {
    const root = new Error("original failure");
    const wrapped = new Error("failed to render the turn", { cause: root });

    const diagnostic = describeDiagnosticError(wrapped);

    expect(diagnostic).toContain("failed to render the turn");
    expect(diagnostic).toContain("Causado por:");
    expect(diagnostic).toContain("original failure");
  });

  it("bounds diagnostics and terminates circular causes", () => {
    const error = new Error("x".repeat(5_000));
    Object.defineProperty(error, "cause", { value: error });

    const diagnostic = describeDiagnosticError(error);

    expect(diagnostic.length).toBeLessThanOrEqual(4_000);
    expect(() => describeDiagnosticError(error)).not.toThrow();
  });
});
