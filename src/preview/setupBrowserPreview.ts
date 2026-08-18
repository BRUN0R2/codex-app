import { mockIPC } from "@tauri-apps/api/mocks";

import type {
  AccountProfileResponse,
  AccountRateLimitsResponse,
  AccountReadResponse,
  ApplicationPreferences,
  ChatModelListResponse,
  CodexModel,
  CodexThread,
  ConfigReadResponse,
  EngineStartResponse,
  ModelListResponse,
  PermissionProfile,
  ProjectRecord,
  ThreadListResponse,
  ThreadOutput,
  ThreadSummary,
  VisibleThreadItem,
} from "../contracts/types";
import { saveProjects } from "../state/projects";
import { utf8ByteLength } from "../utf8";

const PREVIEW_PERMISSION_PROFILE = {
  sandbox: "danger-full-access",
  approvals: "never",
} as const satisfies PermissionProfile;

const PREVIEW_MODEL_ID = "gpt-5.6-luna";
const PREVIEW_REASONING_EFFORT = "low";

function previewOutput(id: string, preview: string): ThreadOutput {
  return {
    id,
    preview,
    byteLength: utf8ByteLength(preview),
    nextCursor: null,
  };
}

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

const PREVIEW_ACCOUNT = {
  account: {
    type: "chatgpt",
    email: null,
    name: "Bruno",
    picture:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23546673'/%3E%3Ccircle cx='32' cy='25' r='14' fill='%23f0c6a7'/%3E%3Cpath d='M8 64c3-17 13-25 24-25s21 8 24 25' fill='%23c03f77'/%3E%3Cpath d='M18 24c1-14 26-18 30 1-10-4-18-9-30-1' fill='%23302028'/%3E%3C/svg%3E",
    planType: "plus",
  },
  requiresOpenaiAuth: true,
  refresh: { status: "notRequired", error: null },
} as const satisfies AccountReadResponse;

const PREVIEW_ACCOUNT_PROFILE = {
  name: "Bruno",
  // The production endpoint only accepts HTTPS profile URLs. Keep the
  // self-contained data URI on the base account and exercise a valid nullable
  // profile response without weakening the IPC contract for browser preview.
  picture: null,
} as const satisfies AccountProfileResponse;

const PREVIEW_CONFIG = {
  config: {
    model: PREVIEW_MODEL_ID,
    modelReasoningEffort: PREVIEW_REASONING_EFFORT,
    serviceTier: null,
    permissionProfile: PREVIEW_PERMISSION_PROFILE,
    webSearch: "live",
    modelVerbosity: null,
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
  schemaVersion: 9,
  config: PREVIEW_CONFIG,
  diagnosticLogPath: "D:\\Codex App Preview\\logs\\runtime.jsonl",
  permissionProfiles: [
    { sandbox: "read-only", approvals: "untrusted" },
    { sandbox: "workspace-write", approvals: "on-request" },
    PREVIEW_PERMISSION_PROFILE,
  ],
} as const satisfies EngineStartResponse;

const PREVIEW_MODEL_DEFINITIONS = [
  ["gpt-5.6-sol", "5.6 Sol"],
  ["gpt-5.6-terra", "5.6 Terra"],
  ["gpt-5.6-luna", "5.6 Luna"],
  ["gpt-5.5", "GPT-5.5"],
  ["gpt-5.4", "GPT-5.4"],
  ["gpt-5.4-mini", "GPT-5.4-Mini"],
  ["gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark"],
] as const;

const PREVIEW_MODELS = PREVIEW_MODEL_DEFINITIONS.map(([id, displayName]) =>
  createPreviewModel(id, displayName, id === PREVIEW_MODEL_ID),
);

const PREVIEW_MODEL_CATALOG = {
  data: PREVIEW_MODELS,
} satisfies ModelListResponse;

const PREVIEW_CHAT_MODEL_CATALOG = {
  data: [
    {
      id: "auto#instant#zero",
      model: "auto",
      title: "Instantâneo",
      description: "Respostas rápidas para tarefas cotidianas.",
      lane: "instant",
      thinkingEffort: "zero",
      versionId: "gpt-5.6",
      selectedLabel: "GPT-5.6 Instantâneo",
      isDefault: true,
    },
    {
      id: "gpt-5.6-thinking#thinking#extended",
      model: "gpt-5.6-thinking",
      title: "Pensamento",
      description: "Mais tempo para problemas complexos.",
      lane: "thinking",
      thinkingEffort: "extended",
      versionId: "gpt-5.6",
      selectedLabel: "GPT-5.6 Pensamento",
      isDefault: false,
    },
    {
      id: "gpt-5.6-pro#pro#max",
      model: "gpt-5.6-pro",
      title: "Pro",
      description: "Maior capacidade para tarefas difíceis.",
      lane: "pro",
      thinkingEffort: "max",
      versionId: "gpt-5.6",
      selectedLabel: "GPT-5.6 Pro",
      isDefault: false,
    },
  ],
} satisfies ChatModelListResponse;

const PREVIEW_NOW_SECONDS = Math.floor(Date.now() / 1_000);
const PREVIEW_WORKSPACE = "D:\\ARQUIVOS IMPORTANTES\\REPOSITORIOS\\apps\\streamplay-app";
const PREVIEW_IMAGE_ONE = previewSvg(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 220">
    <rect width="320" height="220" fill="#17191d"/>
    <rect x="16" y="16" width="288" height="188" rx="18" fill="#252930"/>
    <circle cx="82" cy="91" r="42" fill="#597a71"/>
    <path d="M34 177 105 99l42 43 34-35 105 70" fill="#84a79a"/>
    <circle cx="243" cy="63" r="22" fill="#e2c873"/>
  </svg>
`);
const PREVIEW_IMAGE_TWO = previewSvg(`
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 220">
    <rect width="320" height="220" fill="#151515"/>
    <rect x="20" y="22" width="280" height="176" rx="12" fill="#202020" stroke="#454545"/>
    <circle cx="39" cy="41" r="4" fill="#e06c75"/>
    <circle cx="53" cy="41" r="4" fill="#e5c07b"/>
    <circle cx="67" cy="41" r="4" fill="#98c379"/>
    <path d="M43 76h92M43 100h190M43 124h150M43 148h214M43 172h120" stroke="#7f8fa6" stroke-width="9" stroke-linecap="round"/>
    <path d="M154 76h86M213 124h48M184 172h72" stroke="#65a780" stroke-width="9" stroke-linecap="round"/>
  </svg>
`);

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
  mode: "codex",
  preview: "Inspecionar janela de contexto",
  name: "Inspecionar janela de contexto",
  cwd: PREVIEW_WORKSPACE,
  projectPath: PREVIEW_WORKSPACE,
  createdAt: 1_785_552_000,
  updatedAt: PREVIEW_NOW_SECONDS,
  recencyAt: PREVIEW_NOW_SECONDS,
  status: { type: "active", activeFlags: [] },
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
          model: PREVIEW_MODEL_ID,
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
    {
      id: "preview-active-turn",
      status: "inProgress",
      error: null,
      createdAt: PREVIEW_NOW_SECONDS - 240,
      updatedAt: PREVIEW_NOW_SECONDS,
      items: [
        {
          type: "userMessage",
          id: "preview-active-user-message",
          content: [
            {
              type: "text",
              text: "**O turno falhou** provider request failed: provider returned unsupported SSE event `response.web_search_call.in_progress`",
            },
          ],
        },
        {
          type: "plan",
          id: "preview-active-plan",
          explanation: null,
          steps: [
            {
              step: "Mapear o ciclo de renderização da conversa e o estado transitório da UI",
              status: "inProgress",
            },
            {
              step: "Isolar a causa do remonte e dos saltos de scroll",
              status: "pending",
            },
            {
              step: "Implementar uma correção preservando as alterações locais existentes",
              status: "pending",
            },
            {
              step: "Adicionar/regredir testes e validar o comportamento",
              status: "pending",
            },
            {
              step: "Revisar o resultado final e preparar a entrega",
              status: "pending",
            },
          ],
        },
        {
          type: "contextCompaction",
          id: "preview-context-compaction",
        },
        {
          type: "reasoning",
          id: "preview-active-reasoning",
          summary: ["Implementing keyed Show with stable Index"],
          content: [],
        },
        {
          type: "commandExecution",
          id: "preview-command-1",
          command:
            "$candidates = @('C:\\Users\\bruno\\.codex\\bin\\rtk.exe', 'C:\\Users\\bruno\\bin\\rtk.exe')",
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 18,
        },
        {
          type: "commandExecution",
          id: "preview-command-2",
          command: "rg --files src",
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: previewOutput(
            "preview-command-output-2",
            "exit_code: 0\nstdout:\nsrc/ui/WindowChrome.tsx\nsrc/ui/turnFailure.ts\nsrc/ui/timelineScroll.ts\nsrc/ui/Timeline.tsx\nsrc/ui/SettingsDialog.tsx\nsrc/ui/Composer.tsx\nsrc/ui/AppShell.tsx\nsrc/state/threadRuntime.ts\nsrc/contracts/types.ts\n\nstderr:\n",
          ),
          exitCode: 0,
          durationMs: 24,
        },
        {
          type: "commandExecution",
          id: "preview-command-3",
          command: 'rg -n -S "scroll|scrollTop|scrollIntoView|autoScroll|sticky|anchor" src',
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 31,
        },
        {
          type: "commandExecution",
          id: "preview-command-4",
          command: "Get-Content -LiteralPath package.json -Raw",
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 19,
        },
        {
          type: "commandExecution",
          id: "preview-command-scroll-1",
          command: "Get-Content -LiteralPath src/ui/Timeline.tsx -Raw",
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 28,
        },
        {
          type: "commandExecution",
          id: "preview-command-scroll-2",
          command: 'rg -n "agent-activity-viewport|diff-block" src/styles/global.css',
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 14,
        },
        {
          type: "commandExecution",
          id: "preview-command-scroll-3",
          command: "pnpm exec vitest run src/ui/timelineScroll.test.ts",
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 410,
        },
        {
          type: "commandExecution",
          id: "preview-command-scroll-4",
          command: "pnpm typecheck",
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 1_240,
        },
        {
          type: "commandExecution",
          id: "preview-command-scroll-5",
          command: "git diff --check",
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: null,
          exitCode: 0,
          durationMs: 17,
        },
        {
          type: "fileChange",
          id: "preview-file-change",
          status: "completed",
          changes: [
            {
              path: "src/preview/setupBrowserPreview.ts",
              kind: { type: "update", movePath: null },
              diff: [
                "@@ -22,6 +22,6 @@ const PREVIEW_PERMISSION_PROFILE = {",
                '   approvals: "never",',
                " } as const satisfies PermissionProfile;",
                " ",
                '-const PREVIEW_MODEL_ID = "gpt-5.6-sol";',
                '-const PREVIEW_REASONING_EFFORT = "ultra";',
                '+const PREVIEW_MODEL_ID = "gpt-5.6-luna";',
                '+const PREVIEW_REASONING_EFFORT = "low";',
              ].join("\n"),
            },
          ],
        },
        {
          type: "toolExecution",
          id: "preview-web-search-1",
          name: "web_search",
          description: "Codex app activity files commands",
          status: "completed",
          output: null,
        },
        {
          type: "toolExecution",
          id: "preview-web-search-2",
          name: "web_search",
          description: "Codex app work activity messages",
          status: "completed",
          output: null,
        },
        {
          type: "toolExecution",
          id: "preview-web-search-3",
          name: "web_search",
          description: "https://developers.openai.com/codex/app/",
          status: "completed",
          output: null,
        },
        {
          type: "userMessage",
          id: "preview-image-user-message",
          content: [
            { type: "text", text: "Compare estas duas referências visuais." },
            { type: "localImage", path: PREVIEW_IMAGE_ONE, detail: "auto" },
            { type: "localImage", path: PREVIEW_IMAGE_TWO, detail: "high" },
          ],
        },
        {
          type: "toolExecution",
          id: "preview-image-tool",
          name: "view_image",
          description: "Visualizou uma imagem",
          status: "completed",
          output: previewOutput(
            "preview-image-output",
            JSON.stringify({ image_url: PREVIEW_IMAGE_ONE }),
          ),
        },
        {
          type: "agentMessage",
          id: "preview-latest-commentary",
          text: "Vou investigar em três frentes: entender a implementação do menu e do perfil neste projeto, localizar a instalação oficial do Codex Desktop e comparar como ela resolve e carrega a imagem do usuário antes de alterar qualquer código.\uE200cite\uE202turn0search0\uE202turn0search5\uE201",
          phase: "commentary",
        },
        {
          type: "commandExecution",
          id: "preview-command-5",
          command: "Get-Content -LiteralPath src/ui/Timeline.tsx -Raw",
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          source: "agent",
          status: "inProgress",
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        },
        {
          type: "agentMessage",
          id: "preview-image-answer",
          text: `A imagem gerada também aparece como uma prévia clicável.\n\n![Interface gerada](${PREVIEW_IMAGE_TWO})`,
          phase: "finalAnswer",
        },
      ],
    },
  ],
} as const satisfies CodexThread;

const PREVIEW_THREADS = {
  data: [previewThreadSummary(PREVIEW_CONTEXT_THREAD)],
  nextCursor: null,
} as const satisfies ThreadListResponse;

function previewThreadSummary(thread: CodexThread): ThreadSummary {
  return {
    id: thread.id,
    mode: thread.mode,
    preview: thread.preview,
    name: thread.name,
    cwd: thread.cwd,
    projectPath: thread.projectPath,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    recencyAt: thread.recencyAt,
    status: thread.status,
  };
}

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

let previewApplicationPreferences: ApplicationPreferences = {
  schemaVersion: 1,
  startWithWindows: true,
  startMinimized: false,
  closeToTray: true,
} satisfies ApplicationPreferences;

export function setupBrowserPreview(): void {
  document.title = "Codex App · Visualização";
  document.documentElement.setAttribute("data-runtime", "browser-preview");
  if (new URLSearchParams(window.location.search).get("chrome") === "1") {
    document.documentElement.setAttribute("data-window-chrome-preview", "true");
  }
  saveProjects(PREVIEW_PROJECTS);

  mockIPC(
    (command, args) => {
      switch (command) {
        case "engine_start": {
          return PREVIEW_ENGINE;
        }
        case "engine_runtime_diagnostic_report":
          return { applied: true };
        case "engine_account_read":
          return PREVIEW_ACCOUNT;
        case "engine_account_profile_read":
          return PREVIEW_ACCOUNT_PROFILE;
        case "engine_model_list":
          return PREVIEW_MODEL_CATALOG;
        case "engine_chat_model_list":
          return PREVIEW_CHAT_MODEL_CATALOG;
        case "engine_thread_list":
          return PREVIEW_THREADS;
        case "engine_thread_resume":
          return {
            thread: PREVIEW_CONTEXT_THREAD,
            cwd: PREVIEW_CONTEXT_THREAD.cwd,
            nextCursor: null,
          };
        case "engine_account_rate_limits_read":
          return PREVIEW_RATE_LIMITS;
        case "application_preferences_read":
          return previewApplicationPreferences;
        case "application_preferences_update": {
          const preferences = (args as { preferences?: ApplicationPreferences }).preferences;
          if (preferences === undefined) {
            throw new Error("A atualização de preferências não recebeu um valor.");
          }
          previewApplicationPreferences = preferences;
          return previewApplicationPreferences;
        }
        case "engine_turn_interrupt":
          return { applied: true };
        case "engine_turn_steer":
          return { applied: true };
        case "engine_turn_start": {
          const now = Math.floor(Date.now() / 1_000);
          return {
            turn: {
              id: `preview-turn-${Date.now()}`,
              status: "inProgress",
              createdAt: now,
              updatedAt: now,
            },
          };
        }
        case "plugin:dialog|open": {
          const options = (args as { options?: { directory?: boolean } }).options;
          return options?.directory === true
            ? PREVIEW_WORKSPACE
            : [PREVIEW_IMAGE_ONE, PREVIEW_IMAGE_TWO];
        }
        case "attachment_inspect": {
          const paths = (args as { paths?: readonly string[] }).paths ?? [];
          return paths.map((path, index) => ({
            id: `preview-attachment-${index}`,
            name: index === 0 ? "paisagem.png" : "interface.png",
            path,
            kind: "image",
            size: 128_000 + index * 16_000,
            mediaType: "image/png",
          }));
        }
        case "attachment_read_image": {
          const request = (args as { request?: { path?: string } }).request;
          return { dataUrl: request?.path ?? PREVIEW_IMAGE_ONE };
        }
        case "attachment_save_pasted_image":
          return {
            id: "preview-pasted-image",
            name: "imagem-colada.png",
            path: PREVIEW_IMAGE_ONE,
            kind: "image",
            size: 128_000,
            mediaType: "image/png",
          };
        default:
          throw new Error(
            `O modo de visualização não executa o comando nativo ${JSON.stringify(command)}.`,
          );
      }
    },
    { shouldMockEvents: true },
  );
}

function previewSvg(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg.trim())}`;
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
