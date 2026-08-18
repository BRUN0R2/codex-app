import { describe, expect, it } from "vitest";

import {
  ContractError,
  decodeAccountProfileResponse,
  decodeAccountReadResponse,
  decodeApplicationPreferences,
  decodeAttachmentImageResponse,
  decodeAutomationListResponse,
  decodeAutomationRun,
  decodeChatModelListResponse,
  decodeEngineNotification,
  decodeEngineStartResponse,
  decodeModelListResponse,
  decodeOutputReadResponse,
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

function configFixture(
  permissionProfile: { readonly approvals: string; readonly sandbox: string } = {
    sandbox: "workspace-write",
    approvals: "on-request",
  },
) {
  return {
    config: {
      model: null,
      modelReasoningEffort: null,
      serviceTier: null,
      permissionProfile,
      webSearch: "disabled",
      modelVerbosity: null,
      personality: "pragmatic",
      developerInstructions: null,
      desktop: {
        uiFontSize: 15,
        motion: "full",
        pointerCursor: true,
        diffDisplay: "unified",
      },
    },
    version: 1,
  };
}

describe("decodificação dos contratos nativos", () => {
  it("valida preferências de inicialização e bandeja", () => {
    const preferences = {
      schemaVersion: 1,
      startWithWindows: true,
      startMinimized: true,
      closeToTray: true,
    };

    expect(decodeApplicationPreferences(preferences)).toEqual(preferences);
    expect(() =>
      decodeApplicationPreferences({
        ...preferences,
        startWithWindows: false,
      }),
    ).toThrow(ContractError);
    expect(() =>
      decodeApplicationPreferences({
        ...preferences,
        legacy: true,
      }),
    ).toThrow(ContractError);
  });

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

  it("valida o perfil carregado pelo endpoint oficial do ChatGPT", () => {
    expect(
      decodeAccountProfileResponse({
        name: "Bruno Silva",
        picture: "https://images.example.com/bruno.png",
      }),
    ).toEqual({
      name: "Bruno Silva",
      picture: "https://images.example.com/bruno.png",
    });
    expect(() =>
      decodeAccountProfileResponse({ name: "Bruno", picture: "http://example.com/photo.png" }),
    ).toThrow(ContractError);
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
          "scheduledAutomations",
        ],
      },
      schemaVersion: 10,
      config: configFixture(),
      diagnosticLogPath: "C:\\Users\\Bruno\\AppData\\Roaming\\codex-app\\logs\\runtime.jsonl",
      permissionProfiles: [
        { sandbox: "read-only", approvals: "untrusted" },
        { sandbox: "workspace-write", approvals: "on-request" },
        { sandbox: "danger-full-access", approvals: "never" },
      ],
    });

    expect(decoded.engine.transport).toBe("httpsSse");
    expect(decoded.config.version).toBe(1);
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
        schemaVersion: 10,
        config: configFixture({
          sandbox: "danger-full-access",
          approvals: "on-request",
        }),
        diagnosticLogPath: "C:\\Users\\Bruno\\AppData\\Roaming\\codex-app\\logs\\runtime.jsonl",
        permissionProfiles: [],
      }),
    ).toThrow(ContractError);
  });

  it("valida snapshots completos de Automações", () => {
    const decoded = decodeAutomationListResponse({
      data: [automationFixture()],
      runs: [automationRunFixture()],
    });

    expect(decoded.data[0]?.intervalMinutes).toBe(60);
    expect(decoded.runs[0]).toMatchObject({
      status: "completed",
      reviewed: false,
    });
    expect(() =>
      decodeAutomationListResponse({
        data: [automationFixture({ nextRunAt: null })],
        runs: [],
      }),
    ).toThrow("enabled automations require a nextRunAt timestamp");
  });

  it("rejeita estados impossíveis de execuções automatizadas", () => {
    expect(() =>
      decodeAutomationRun(
        automationRunFixture({
          status: "running",
          completedAt: null,
          startedAt: null,
        }),
      ),
    ).toThrow("running automation runs require startedAt");
    expect(() =>
      decodeAutomationRun(
        automationRunFixture({
          status: "queued",
          completedAt: null,
          startedAt: 1_010,
        }),
      ),
    ).toThrow("queued automation runs cannot contain startedAt");
    expect(() =>
      decodeAutomationRun(
        automationRunFixture({
          status: "failed",
          error: null,
        }),
      ),
    ).toThrow("failed automation runs require an error");
    expect(() =>
      decodeAutomationRun(
        automationRunFixture({
          completedAt: 1_005,
          startedAt: 1_010,
        }),
      ),
    ).toThrow("automation completedAt must not precede startedAt");
    expect(() =>
      decodeAutomationRun(
        automationRunFixture({
          status: "queued",
          completedAt: null,
          reviewed: true,
          startedAt: null,
        }),
      ),
    ).toThrow("active automation runs cannot be reviewed");
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

  it("mantém presets Pro do Chat como model + thinkingEffort", () => {
    const decoded = decodeChatModelListResponse({
      data: [
        {
          id: "gpt-5.6-pro#pro#max",
          model: "gpt-5.6-pro",
          title: "Pro",
          description: "Maior capacidade",
          lane: "pro",
          thinkingEffort: "max",
          versionId: "gpt-5.6",
          selectedLabel: "GPT-5.6 Pro",
          isDefault: true,
        },
      ],
    });

    expect(decoded.data[0]).toMatchObject({
      model: "gpt-5.6-pro",
      lane: "pro",
      thinkingEffort: "max",
    });
    expect(() =>
      decodeChatModelListResponse({
        data: [{ ...decoded.data[0], thinkingEffort: "high" }],
      }),
    ).toThrow(ContractError);
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

  it("mantém saídas grandes fora do contrato do turno e valida cada bloco paginado", () => {
    const response = (output: unknown) => ({
      nextCursor: null,
      thread: {
        id: "thread-output-limit",
        mode: "codex",
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
    const preview = "😀".repeat((64 * 1_024) / 4);
    const output = {
      id: "output-large-1",
      preview,
      byteLength: 8 * 1_048_576,
      nextCursor: "1",
    };
    const decodedItem = decodeThreadReadResponse(response(output)).thread.turns[0]?.items[0];
    expect(decodedItem).toMatchObject({ output });
    expect(JSON.stringify(decodedItem).length).toBeLessThan(70_000);
    expect(() => decodeThreadReadResponse(response("x".repeat(1_048_577)))).toThrow(ContractError);

    const notification = decodeEngineNotification({
      method: "item.completed",
      params: {
        threadId: "thread-output-limit",
        turnId: "turn-output-limit",
        item: {
          type: "toolExecution",
          id: "tool-output-limit",
          name: "read_file",
          description: "Lê um arquivo",
          status: "completed",
          output,
        },
      },
    });
    if (
      notification.method !== "item.completed" ||
      notification.params.item.type !== "toolExecution" ||
      notification.params.item.output === null
    ) {
      throw new Error("A referência de saída mudou de tipo.");
    }
    expect(notification.params.item.output).toEqual(output);

    const block = decodeOutputReadResponse({
      outputId: output.id,
      chunk: preview,
      byteLength: output.byteLength,
      nextCursor: "2",
    });
    expect(new TextEncoder().encode(block.chunk).length).toBe(64 * 1_024);
    expect(block.chunk).not.toContain("�");
    expect(() =>
      decodeOutputReadResponse({
        ...block,
        chunk: `${preview}x`,
      }),
    ).toThrow(ContractError);
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

  it("decodifica lotes heterogêneos de deltas com limites explícitos", () => {
    const decoded = decodeEngineNotification({
      method: "item.streamDeltas",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        deltas: [
          { kind: "agentText", itemId: "message-1", delta: "Olá" },
          {
            kind: "reasoningSummary",
            itemId: "reasoning-1",
            index: 0,
            delta: "Analisando",
          },
        ],
      },
    });
    expect(decoded.method).toBe("item.streamDeltas");
    if (decoded.method !== "item.streamDeltas") {
      throw new Error("O lote de deltas mudou de método.");
    }
    expect(decoded.params.deltas).toHaveLength(2);
    expect(() =>
      decodeEngineNotification({
        method: "item.streamDeltas",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          deltas: Array.from({ length: 129 }, () => ({
            kind: "agentText",
            itemId: "message-1",
            delta: "x",
          })),
        },
      }),
    ).toThrow(ContractError);
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

    expect(buffering.method).toBe("model.safetyBufferingUpdated");
    expect(rerouted.method).toBe("model.rerouted");
    expect(verification.method).toBe("model.verification");
  });

  it("preserva falhas de turno e rejeita estados incoerentes", () => {
    const response = {
      nextCursor: null,
      thread: {
        id: "thread-1",
        mode: "codex",
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
        nextCursor: null,
        thread: {
          ...response.thread,
          cwd: "C:\\app-data\\projectless-workspace",
          projectPath: null,
        },
      }).thread.projectPath,
    ).toBeNull();
    expect(() =>
      decodeThreadReadResponse({
        nextCursor: null,
        thread: {
          ...response.thread,
          turns: [{ ...response.thread.turns[0], status: "completed" }],
        },
      }),
    ).toThrow("failed turns require an error");
    expect(() =>
      decodeThreadReadResponse({
        nextCursor: null,
        thread: {
          ...response.thread,
          turns: [{ ...response.thread.turns[0], createdAt: 3, updatedAt: 2 }],
        },
      }),
    ).toThrow("turn updatedAt must not precede createdAt");
  });
});

function automationFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "automation-1",
    name: "Revisar projeto",
    prompt: "Revise o projeto e execute os testes.",
    projectPath: "C:\\workspace\\codex-app",
    enabled: true,
    intervalMinutes: 60,
    timezone: "America/Sao_Paulo",
    timezoneOffsetMin: 180,
    nextRunAt: 4_600,
    lastRunAt: 1_000,
    version: 1,
    createdAt: 1_000,
    updatedAt: 1_100,
    ...overrides,
  };
}

function automationRunFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: "automation-run-1",
    automationId: "automation-1",
    trigger: "scheduled",
    status: "completed",
    threadId: "thread-1",
    turnId: "turn-1",
    error: null,
    reviewed: false,
    createdAt: 1_000,
    startedAt: 1_010,
    completedAt: 1_100,
    ...overrides,
  };
}
