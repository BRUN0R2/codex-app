import { describe, expect, it } from "vitest";

import {
  ContractError,
  decodeEngineNotification,
  decodeEngineStartResponse,
  decodeModelListResponse,
} from "./decode";

function modelFixture() {
  return {
    id: "gpt-test",
    model: "gpt-test",
    displayName: "GPT Test",
    description: "Modelo de teste",
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Equilibrado" }],
    defaultReasoningEffort: "medium",
    serviceTiers: [{ id: "priority", name: "Priority", description: "Baixa latência" }],
    defaultServiceTier: "priority",
    isDefault: true,
  };
}

describe("decodificação dos contratos nativos", () => {
  it("aceita somente a composição de engine publicada", () => {
    const decoded = decodeEngineStartResponse({
      engine: {
        id: "native-engine",
        name: "Native Engine",
        provider: "ChatGPT Codex",
        auth: "ChatGPT OAuth",
        transport: "httpsSse",
        storage: "sqlite",
        capabilities: [
          "chatGptOauth",
          "localThreads",
          "modelStreaming",
          "nativeTools",
          "explicitApprovals",
        ],
      },
      schemaVersion: 1,
      permissionProfile: { sandbox: "workspace-write", approvals: "on-request" },
      permissionProfiles: [
        { sandbox: "read-only", approvals: "untrusted" },
        { sandbox: "workspace-write", approvals: "on-request" },
        { sandbox: "danger-full-access", approvals: "never" },
      ],
    });

    expect(decoded.engine.transport).toBe("httpsSse");
    expect(decoded.permissionProfiles).toHaveLength(3);
  });

  it("rejeita combinações de permissão não suportadas", () => {
    expect(() =>
      decodeEngineStartResponse({
        engine: {
          id: "native-engine",
          name: "Native Engine",
          provider: "ChatGPT Codex",
          auth: "ChatGPT OAuth",
          transport: "httpsSse",
          storage: "sqlite",
          capabilities: [],
        },
        schemaVersion: 1,
        permissionProfile: { sandbox: "danger-full-access", approvals: "on-request" },
        permissionProfiles: [],
      }),
    ).toThrow(ContractError);
  });

  it("valida a coerência semântica do catálogo de modelos", () => {
    const decoded = decodeModelListResponse({ data: [modelFixture()] });
    expect(decoded.data[0]?.defaultServiceTier).toBe("priority");

    expect(() =>
      decodeModelListResponse({
        data: [{ ...modelFixture(), defaultReasoningEffort: "high" }],
      }),
    ).toThrow("must be one of the supported reasoning efforts");
  });

  it("rejeita notificações desconhecidas e campos herdados", () => {
    expect(() => decodeEngineNotification({ method: "thread/legacy", params: {} })).toThrow(
      "unsupported notification",
    );

    expect(() =>
      decodeEngineNotification({
        method: "item.completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "commandExecution",
            id: "item-1",
            command: "cargo check",
            cwd: "C:\\workspace",
            processId: null,
            source: "agent",
            status: "completed",
            aggregatedOutput: null,
            exitCode: 0,
            durationMs: 12,
            commandActions: [],
          },
        },
      }),
    ).toThrow(ContractError);
  });
});
