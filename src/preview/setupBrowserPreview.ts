import { emit } from "@tauri-apps/api/event";
import { mockIPC } from "@tauri-apps/api/mocks";

import type {
  AccountRateLimitsResponse,
  AccountReadResponse,
  CodexModel,
  CodexThread,
  ConfigReadResponse,
  EngineStartResponse,
  ModelListResponse,
  PermissionProfile,
  ProjectRecord,
  ThreadListResponse,
  VisibleThreadItem,
  WorkspaceRepository,
} from "../contracts/types";
import { saveProjects } from "../state/projects";

const PREVIEW_PERMISSION_PROFILE = {
  sandbox: "danger-full-access",
  approvals: "never",
} as const satisfies PermissionProfile;

const PREVIEW_PROJECTS = [
  {
    name: "codex-app",
    path: "D:\\ARQUIVOS IMPORTANTES\\REPOSITORIOS\\Tools\\codex-app",
  },
  {
    name: "streamplay-app",
    path: "D:\\ARQUIVOS IMPORTANTES\\REPOSITORIOS\\apps\\streamplay-app",
  },
] as const satisfies readonly ProjectRecord[];

const PREVIEW_ENGINE = {
  engine: {
    id: "native-engine",
    name: "NativeEngine",
    provider: "OpenAI",
    auth: "ChatGPT OAuth",
    transport: "httpsSse",
    storage: "sqlite",
    capabilities: [
      "chatGptOauth",
      "explicitApprovals",
      "localThreads",
      "modelStreaming",
      "nativeTools",
    ],
  },
  schemaVersion: 1,
  permissionProfile: PREVIEW_PERMISSION_PROFILE,
  permissionProfiles: [
    { sandbox: "read-only", approvals: "untrusted" },
    { sandbox: "workspace-write", approvals: "on-request" },
    PREVIEW_PERMISSION_PROFILE,
  ],
} as const satisfies EngineStartResponse;

const PREVIEW_ACCOUNT = {
  account: { type: "chatgpt", email: null, planType: "plus" },
  requiresOpenaiAuth: true,
  refresh: { status: "notRequired", error: null },
} as const satisfies AccountReadResponse;

const PREVIEW_CONFIG = {
  config: {
    model: "gpt-5.6-sol",
    modelReasoningEffort: "ultra",
    serviceTier: null,
    permissionProfile: PREVIEW_PERMISSION_PROFILE,
    webSearch: "live",
    modelVerbosity: "medium",
    personality: "pragmatic",
    developerInstructions: null,
    desktop: {
      uiFontSize: 14,
      motion: "full",
      pointerCursor: true,
      diffDisplay: "unified",
    },
  },
  version: 1,
} as const satisfies ConfigReadResponse;

const PREVIEW_MODEL_DEFINITIONS = [
  ["gpt-5.6-sol", "5.6 Sol"],
  ["gpt-5.6-terra", "5.6 Terra"],
  ["gpt-5.6-luna", "5.6 Luna"],
  ["gpt-5.5", "GPT-5.5"],
  ["gpt-5.4", "GPT-5.4"],
  ["gpt-5.4-mini", "GPT-5.4-Mini"],
  ["gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark"],
] as const;

const PREVIEW_MODELS = PREVIEW_MODEL_DEFINITIONS.map(([id, displayName], index) =>
  createPreviewModel(id, displayName, index === 0),
);

const PREVIEW_MODEL_CATALOG = {
  data: PREVIEW_MODELS,
} satisfies ModelListResponse;

const PREVIEW_SCROLL_ITEMS: readonly VisibleThreadItem[] = [
  {
    type: "userMessage",
    id: "preview-user-message",
    content: [{ type: "text", text: "Inspecione o projeto e valide o fluxo completo." }],
  },
  {
    type: "agentMessage",
    id: "preview-commentary",
    text: "Vou percorrer a arquitetura e validar as fronteiras do aplicativo.",
    phase: "commentary",
  },
  ...Array.from({ length: 18 }, (_, index): VisibleThreadItem => {
    const step = index + 1;
    return index % 2 === 0
      ? {
          type: "reasoning",
          id: `preview-reasoning-${step}`,
          summary: [`Analisando etapa ${step} do fluxo nativo`],
          content: [],
        }
      : {
          type: "toolExecution",
          id: `preview-tool-${step}`,
          name: "read_file",
          description: `Leitura de contrato ${step}`,
          status: "completed",
          output: null,
        };
  }),
  {
    type: "agentMessage",
    id: "preview-final-answer",
    text: "A inspeção terminou e o **último item** permanece totalmente visível acima do `compositor`.",
    phase: "finalAnswer",
  },
];

const PREVIEW_CONTEXT_THREAD = {
  id: "preview-context-thread",
  preview: "Inspecionar janela de contexto",
  name: "Inspecionar janela de contexto",
  cwd: "D:\\ARQUIVOS IMPORTANTES\\REPOSITORIOS\\apps\\streamplay-app",
  createdAt: 1_785_552_000,
  updatedAt: 1_785_552_060,
  recencyAt: 1_785_552_060,
  status: { type: "idle" },
  turns: [
    {
      id: "preview-turn",
      status: "completed",
      error: null,
      createdAt: 1_785_552_000,
      updatedAt: 1_785_552_060,
      items: [
        ...PREVIEW_SCROLL_ITEMS,
        {
          type: "contextUsage",
          id: "context-preview-turn-0",
          model: "gpt-5.6-sol",
          usage: {
            inputTokens: 164_000,
            cachedInputTokens: 120_000,
            outputTokens: 10_000,
            reasoningOutputTokens: 8_000,
            totalTokens: 174_000,
          },
          contextWindow: {
            tokens: 272_000,
            usableTokens: 258_400,
            usablePercent: 95,
            maximumTokens: 400_000,
          },
        },
      ],
    },
  ],
} as const satisfies CodexThread;

const PREVIEW_THREADS = {
  data: [PREVIEW_CONTEXT_THREAD],
  nextCursor: null,
} as const satisfies ThreadListResponse;

const PREVIEW_RATE_LIMITS = {
  rateLimits: {
    limitId: null,
    limitName: null,
    primary: { usedPercent: 21, windowDurationMins: 300, resetsAt: null },
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: "plus",
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {},
} as const satisfies AccountRateLimitsResponse;

const PREVIEW_REPOSITORY = {
  type: "gitBranch",
  branch: "main",
  changes: [
    { status: " M", path: "src/ui/Timeline.tsx" },
    { status: "??", path: "src/ui/MessageNavigator.tsx" },
  ],
} as const satisfies WorkspaceRepository;

export function setupBrowserPreview(): void {
  document.title = "Codex App · Visualização";
  document.documentElement.setAttribute("data-runtime", "browser-preview");
  saveProjects(PREVIEW_PROJECTS);

  mockIPC(
    (command) => {
      switch (command) {
        case "engine_start":
          return emit("engine://runtime-status", { state: "ready", message: null }).then(
            () => PREVIEW_ENGINE,
          );
        case "engine_account_read":
          return PREVIEW_ACCOUNT;
        case "engine_config_read":
          return PREVIEW_CONFIG;
        case "engine_model_list":
          return PREVIEW_MODEL_CATALOG;
        case "engine_thread_list":
          return PREVIEW_THREADS;
        case "engine_thread_resume":
          return { thread: PREVIEW_CONTEXT_THREAD, cwd: PREVIEW_CONTEXT_THREAD.cwd };
        case "engine_account_rate_limits_read":
          return PREVIEW_RATE_LIMITS;
        case "workspace_repository_read":
          return PREVIEW_REPOSITORY;
        default:
          throw new Error(
            `O modo de visualização não executa o comando nativo ${JSON.stringify(command)}.`,
          );
      }
    },
    { shouldMockEvents: true },
  );
}

function createPreviewModel(id: string, displayName: string, isDefault: boolean): CodexModel {
  return {
    id,
    model: id,
    displayName,
    description: null,
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Raciocínio mais direto." },
      { reasoningEffort: "medium", description: "Equilíbrio entre velocidade e profundidade." },
      { reasoningEffort: "high", description: "Raciocínio aprofundado." },
      { reasoningEffort: "xhigh", description: "Raciocínio muito aprofundado." },
      { reasoningEffort: "ultra", description: "Profundidade máxima disponível." },
    ],
    defaultReasoningEffort: "medium",
    serviceTiers: [
      {
        id: "fast",
        name: "Fast",
        description: "Prioriza menor latência de resposta.",
      },
    ],
    defaultServiceTier: null,
    contextWindow: {
      tokens: 272_000,
      usableTokens: 258_400,
      usablePercent: 95,
      maximumTokens: 400_000,
    },
    isDefault,
  };
}
