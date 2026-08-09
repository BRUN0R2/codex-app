import { describe, expect, it } from "vitest";

import {
  ContractError,
  decodeAccountReadResponse,
  decodeAttachmentImageResponse,
  decodeEngineNotification,
  decodeEngineStartResponse,
  decodeModelListResponse,
  decodeThreadCompactStartResponse,
  decodeThreadReadResponse,
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
    contextWindow: {
      tokens: 272_000,
      usableTokens: 258_400,
      usablePercent: 95,
      maximumTokens: 400_000,
    },
    isDefault: true,
  };
}

describe("decodificação dos contratos nativos", () => {
  it("valida a resposta usada para visualizar anexos de imagem", () => {
    expect(decodeAttachmentImageResponse({ dataUrl: "data:image/png;base64,aGVsbG8=" })).toEqual({
      dataUrl: "data:image/png;base64,aGVsbG8=",
    });
    expect(() =>
      decodeAttachmentImageResponse({ dataUrl: "data:image/png;base64,aGVsbG8=", extra: true }),
    ).toThrow(ContractError);
  });

  it("preserva nome e foto do perfil ChatGPT", () => {
    const decoded = decodeAccountReadResponse({
      account: {
        type: "chatgpt",
        email: "bruno@example.com",
        name: "Bruno",
        picture: "https://images.example.com/bruno.png",
        planType: "plus",
      },
      requiresOpenaiAuth: true,
      refresh: { status: "notRequired", error: null },
    });

    expect(decoded.account?.name).toBe("Bruno");
    expect(decoded.account?.picture).toBe("https://images.example.com/bruno.png");
  });

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
      schemaVersion: 2,
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
        schemaVersion: 2,
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

  it("mantém saídas de ferramenta dentro do limite publicado pelo motor", () => {
    const response = (output: string) => ({
      thread: {
        id: "thread-output-limit",
        preview: "Teste de limite",
        name: null,
        cwd: "C:\\workspace",
        projectPath: "C:\\workspace",
        createdAt: 1,
        updatedAt: 2,
        recencyAt: 2,
        status: { type: "idle" },
        turns: [
          {
            id: "turn-output-limit",
            items: [
              {
                type: "toolExecution",
                id: "tool-output-limit",
                name: "read_file",
                description: "Lê um arquivo",
                status: "completed",
                output,
              },
            ],
            status: "completed",
            error: null,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      },
    });
    const maximumOutput = "x".repeat(1_048_576);

    expect(
      decodeThreadReadResponse(response(maximumOutput)).thread.turns[0]?.items[0],
    ).toMatchObject({ output: maximumOutput });
    expect(() => decodeThreadReadResponse(response(`${maximumOutput}x`))).toThrow(
      "$.thread.turns[0].items[0].output: string must contain at most 1048576 UTF-8 bytes",
    );
  });

  it("aceita somente movePath em alterações de arquivo", () => {
    const notification = (kind: Record<string, unknown>) => ({
      method: "item.completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "fileChange",
          id: "change-1",
          changes: [{ path: "src/old.ts", kind, diff: "" }],
          status: "completed",
        },
      },
    });

    const decoded = decodeEngineNotification(
      notification({ type: "update", movePath: "src/new.ts" }),
    );
    if (decoded.method !== "item.completed" || decoded.params.item.type !== "fileChange") {
      throw new Error("A alteração de arquivo decodificada mudou de tipo.");
    }
    expect(decoded.params.item.changes[0]?.kind).toEqual({
      type: "update",
      movePath: "src/new.ts",
    });
    expect(() =>
      decodeEngineNotification(notification({ type: "update", move_path: "src/new.ts" })),
    ).toThrow(ContractError);
  });

  it("decodifica planos estruturados e rejeita progresso ambíguo", () => {
    const notification = (steps: readonly Record<string, unknown>[]) => ({
      method: "item.completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "plan",
          id: "plan-1",
          explanation: "Plano inicial",
          steps,
        },
      },
    });

    const decoded = decodeEngineNotification(
      notification([
        { step: "Mapear o fluxo", status: "completed" },
        { step: "Corrigir o estado", status: "inProgress" },
        { step: "Validar", status: "pending" },
      ]),
    );
    if (decoded.method !== "item.completed" || decoded.params.item.type !== "plan") {
      throw new Error("O plano decodificado mudou de tipo.");
    }
    expect(decoded.params.item.steps[1]?.status).toBe("inProgress");
    expect(() => decodeEngineNotification(notification([]))).toThrow(ContractError);
    expect(() =>
      decodeEngineNotification(
        notification([
          { step: "Um", status: "inProgress" },
          { step: "Dois", status: "inProgress" },
        ]),
      ),
    ).toThrow(ContractError);
    expect(() =>
      decodeEngineNotification(
        notification([
          { step: "Validar", status: "completed" },
          { step: "validar", status: "pending" },
        ]),
      ),
    ).toThrow(ContractError);
  });

  it("valida o uso persistido da janela de contexto", () => {
    const decoded = decodeEngineNotification({
      method: "item.completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: {
          type: "contextUsage",
          id: "context-turn-1-0",
          model: "gpt-test",
          usage: {
            inputTokens: 164_000,
            cachedInputTokens: 120_000,
            outputTokens: 10_000,
            reasoningOutputTokens: 8_000,
            totalTokens: 174_000,
          },
          contextWindow: modelFixture().contextWindow,
        },
      },
    });

    if (decoded.method !== "item.completed") {
      throw new Error("A notificação decodificada mudou de método.");
    }
    expect(decoded.params.item.type).toBe("contextUsage");
  });

  it("decodifica o marco explícito de compactação de contexto", () => {
    const decoded = decodeEngineNotification({
      method: "item.completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "contextCompaction", id: "compaction-1" },
      },
    });

    if (decoded.method !== "item.completed") {
      throw new Error("A notificação decodificada mudou de método.");
    }
    expect(decoded.params.item).toEqual({ type: "contextCompaction", id: "compaction-1" });
  });

  it("mantém a resposta de compactação manual estritamente vazia", () => {
    expect(decodeThreadCompactStartResponse({})).toEqual({});
    expect(() => decodeThreadCompactStartResponse({ turn: {} })).toThrow(ContractError);
  });

  it("decodifica o lifecycle explícito de tarefas", () => {
    for (const method of ["thread.archived", "thread.unarchived", "thread.deleted"] as const) {
      expect(decodeEngineNotification({ method, params: { threadId: "thread-1" } })).toEqual({
        method,
        params: { threadId: "thread-1" },
      });
    }
  });

  it("decodifica somente projeções terminais completas", () => {
    const notification = (turn: Record<string, unknown>) => ({
      method: "turn.completed",
      params: { threadId: "thread-1", turn, error: null },
    });
    const decoded = decodeEngineNotification(
      notification({
        id: "turn-1",
        status: "interrupted",
        error: null,
        updatedAt: 1_785_552_060,
      }),
    );

    if (decoded.method !== "turn.completed") {
      throw new Error("A notificação terminal mudou de método.");
    }
    expect(decoded.params.turn).toEqual({
      id: "turn-1",
      status: "interrupted",
      error: null,
      updatedAt: 1_785_552_060,
    });
    expect(() =>
      decodeEngineNotification(
        notification({ id: "turn-1", status: "inProgress", error: null, updatedAt: 2 }),
      ),
    ).toThrow(ContractError);
    expect(() =>
      decodeEngineNotification(notification({ id: "turn-1", status: "completed", error: null })),
    ).toThrow(ContractError);
  });

  it("decodifica o fluxo transitório de segurança e roteamento do modelo", () => {
    const buffering = decodeEngineNotification({
      method: "model.safetyBufferingUpdated",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        model: "gpt-test",
        useCases: ["cyber"],
        reasons: ["policy-check"],
        showBufferingUi: true,
        fasterModel: "gpt-fast",
      },
    });
    const rerouted = decodeEngineNotification({
      method: "model.rerouted",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        fromModel: "gpt-test",
        toModel: "gpt-fallback",
        reason: "highRiskCyberActivity",
      },
    });
    const verification = decodeEngineNotification({
      method: "model.verification",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        verifications: ["trustedAccessForCyber"],
      },
    });
    const moderation = decodeEngineNotification({
      method: "turn.moderationMetadata",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        metadata: { presentation: "inline" },
      },
    });

    expect(buffering.method).toBe("model.safetyBufferingUpdated");
    expect(rerouted.method).toBe("model.rerouted");
    expect(verification.method).toBe("model.verification");
    expect(moderation.method).toBe("turn.moderationMetadata");
  });

  it("preserva falhas de turno e rejeita estados incoerentes", () => {
    const response = {
      thread: {
        id: "thread-1",
        preview: "Teste",
        name: null,
        cwd: "C:\\workspace",
        projectPath: "C:\\workspace",
        createdAt: 1,
        updatedAt: 2,
        recencyAt: 2,
        status: { type: "idle" },
        turns: [
          {
            id: "turn-1",
            items: [],
            status: "failed",
            error: "O provider rejeitou o evento.",
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      },
    } as const;

    expect(decodeThreadReadResponse(response).thread.turns[0]?.error).toBe(
      "O provider rejeitou o evento.",
    );
    expect(
      decodeThreadReadResponse({
        thread: {
          ...response.thread,
          cwd: "C:\\app-data\\projectless-workspace",
          projectPath: null,
        },
      }).thread.projectPath,
    ).toBeNull();
    expect(() =>
      decodeThreadReadResponse({
        thread: {
          ...response.thread,
          turns: [{ ...response.thread.turns[0], status: "completed" }],
        },
      }),
    ).toThrow("failed turns require an error");
    expect(() =>
      decodeThreadReadResponse({
        thread: {
          ...response.thread,
          turns: [{ ...response.thread.turns[0], createdAt: 3, updatedAt: 2 }],
        },
      }),
    ).toThrow("turn updatedAt must not precede createdAt");
  });
});
