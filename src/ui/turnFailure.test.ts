import { describe, expect, it } from "vitest";

import { presentTurnFailure } from "./turnFailure";

describe("turn failure presentation", () => {
  it("explains a provider usage limit without exposing raw JSON", () => {
    const failure = presentTurnFailure(
      'provider returned HTTP 429: {"error":{"type":"usage_limit_reached","message":"The usage limit has been reached","resets_in_seconds":511936}}',
    );

    expect(failure).toEqual({
      title: "Limite de uso atingido",
      detail:
        "A conta atingiu a cota do Codex. Tente novamente em aproximadamente 5 dias e 22 horas.",
      technical: "HTTP 429 · usage_limit_reached",
    });
  });

  it("turns the historical missing-output response into an actionable explanation", () => {
    const failure = presentTurnFailure(
      'provider returned HTTP 400: {"error":{"message":"No tool output found for function call call-1","type":"invalid_request_error"}}',
    );

    expect(failure.title).toBe("Histórico de ferramentas incompleto");
    expect(failure.detail).toContain("corrige esse histórico automaticamente");
    expect(failure.technical).toBe("HTTP 400 · invalid_request_error");
  });

  it("supports the bounded normalized provider message used by new turns", () => {
    const failure = presentTurnFailure(
      "provider returned HTTP 429: The usage limit has been reached; reset in approximately 5d 22h (provider type: usage_limit_reached)",
    );

    expect(failure.detail).toContain("5 dias e 22 horas");
    expect(failure.technical).toBe("HTTP 429 · usage_limit_reached");
  });

  it("sanitizes absolute system paths from error messages", () => {
    const failure = presentTurnFailure(
      "Failed to open file at C:\\Users\\test\\secret\\project.txt",
    );
    expect(failure.detail).toBe("Failed to open file at <caminho-local>");
  });
});
