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
      tone: "warning",
    });
  });

  it("turns the historical missing-output response into an actionable explanation", () => {
    const failure = presentTurnFailure(
      'provider returned HTTP 400: {"error":{"message":"No tool output found for function call call-1","type":"invalid_request_error"}}',
    );

    expect(failure.title).toBe("Histórico de ferramentas incompleto");
    expect(failure.detail).toContain("corrige esse histórico automaticamente");
    expect(failure.technical).toBe("HTTP 400 · invalid_request_error");
    expect(failure.tone).toBe("error");
  });

  it("supports the bounded normalized provider message used by new turns", () => {
    const failure = presentTurnFailure(
      "provider returned HTTP 429: The usage limit has been reached; reset in approximately 5d 22h (provider type: usage_limit_reached)",
    );

    expect(failure.detail).toContain("5 dias e 22 horas");
    expect(failure.technical).toBe("HTTP 429 · usage_limit_reached");
    expect(failure.tone).toBe("warning");
  });

  it("presents provider overload as a concise warning", () => {
    const failure = presentTurnFailure(
      "provider request failed: server_is_overloaded: Our servers are currently overloaded. Please try again later.",
    );

    expect(failure).toEqual({
      title: "Serviço temporariamente ocupado",
      detail: "O serviço está com alta demanda no momento. Tente novamente em alguns instantes.",
      technical: "server_is_overloaded",
      tone: "warning",
    });
  });

  it("hides raw server-error boilerplate while preserving the request id", () => {
    const failure = presentTurnFailure(
      "provider temporarily unavailable: server_error: An error occurred while processing your request. Please include the request ID 8796db4b-8d14-4390-86a6-9a1a2ab7a184 in your message.",
    );

    expect(failure.title).toBe("Instabilidade temporária no serviço");
    expect(failure.detail).not.toContain("help center");
    expect(failure.technical).toBe("server_error · ID 8796db4b-8d14-4390-86a6-9a1a2ab7a184");
    expect(failure.tone).toBe("warning");
  });

  it("recognizes the normalized transient-provider message even without a provider code", () => {
    const failure = presentTurnFailure(
      "provider temporarily unavailable: An error occurred while processing your request.",
    );

    expect(failure.title).toBe("Instabilidade temporária no serviço");
    expect(failure.technical).toBeNull();
    expect(failure.tone).toBe("warning");
  });

  it("turns an exhausted context recovery into an actionable message", () => {
    const failure = presentTurnFailure(
      "model context window exceeded: context_length_exceeded: too large",
    );

    expect(failure.title).toBe("Contexto da conversa excedido");
    expect(failure.detail).toContain("Compacte o contexto");
    expect(failure.technical).toBe("context_length_exceeded");
    expect(failure.tone).toBe("error");
  });

  it("sanitizes absolute system paths from error messages", () => {
    const failure = presentTurnFailure(
      "Failed to open file at C:\\Users\\test\\secret\\project.txt",
    );
    expect(failure.detail).toBe("Failed to open file at <caminho-local>");
    expect(failure.tone).toBe("error");
  });
});
