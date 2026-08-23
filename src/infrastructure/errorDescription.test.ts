import { describe, expect, it } from "vitest";

import { describeDiagnosticError, describeError } from "./errorDescription";

describe("error descriptions", () => {
  it("keeps the concise command error for the interface", () => {
    expect(
      describeError({
        code: "invalid_request",
        message: "A solicitação é inválida.",
        retryable: false,
      }),
    ).toBe("A solicitação é inválida.");
  });

  it("unwraps generic framework errors to the original command failure", () => {
    const commandError = {
      code: "invalid_attachment",
      message: "O arquivo anexado não está mais disponível.",
      retryable: false,
    };
    const wrapped = new Error("Unknown error", { cause: commandError });

    expect(describeError(wrapped)).toBe("O arquivo anexado não está mais disponível.");
  });

  it("preserves the complete error cause chain for diagnostics", () => {
    const root = new Error("falha original");
    const wrapped = new Error("falha ao renderizar o turno", { cause: root });

    const diagnostic = describeDiagnosticError(wrapped);

    expect(diagnostic).toContain("falha ao renderizar o turno");
    expect(diagnostic).toContain("Causado por:");
    expect(diagnostic).toContain("falha original");
  });

  it("bounds diagnostics and terminates circular causes", () => {
    const error = new Error("x".repeat(5_000));
    Object.defineProperty(error, "cause", { value: error });

    const diagnostic = describeDiagnosticError(error);

    expect(diagnostic.length).toBeLessThanOrEqual(4_000);
    expect(() => describeDiagnosticError(error)).not.toThrow();
  });
});
