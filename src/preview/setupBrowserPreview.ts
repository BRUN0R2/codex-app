import { mockIPC } from "@tauri-apps/api/mocks";

import type {
  AccountProfileResponse,
  AccountRateLimitsResponse,
  AccountReadResponse,
  ApplicationPreferences,
  Automation,
  AutomationListResponse,
  AutomationRun,
  AutoTopUpSettingsSnapshot,
  BrowserTabSnapshot,
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
  UsageResetCreditsResponse,
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

const PREVIEW_CREATED_RUST_LINE_COUNT: number = 338;

function previewCreatedRustDiff(): string {
  const source = [
    "use std::fmt;",
    "",
    "#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]",
    "enum RoutineLineKind {",
    "    BuildProgress,",
    "    JavaScriptTestSuccess,",
    "    PackageProgress,",
    "    RustTestSuccess,",
    "}",
    "",
    "impl RoutineLineKind {",
    "    fn label(self) -> &'static str {",
    "        match self {",
    '            Self::BuildProgress => "build progress lines",',
    '            Self::JavaScriptTestSuccess => "JavaScript test success lines",',
    '            Self::PackageProgress => "package-manager progress lines",',
    '            Self::RustTestSuccess => "Rust test success lines",',
    "        }",
    "    }",
    "}",
  ];
  while (source.length < PREVIEW_CREATED_RUST_LINE_COUNT) {
    const index = source.length + 1;
    source.push(`const VALUE_${index}: usize = ${index} * 1_024;`);
  }
  return [
    "--- /dev/null",
    "+++ b/src-tauri/src/engine/native/output_compaction/semantic.rs",
    `@@ -0,0 +1,${PREVIEW_CREATED_RUST_LINE_COUNT} @@`,
    ...source.map((line) => `+${line}`),
  ].join("\n");
}

function previewCommand(
  id: string,
  command: string,
  durationMs = 24,
): Extract<VisibleThreadItem, { readonly type: "commandExecution" }> {
  return {
    type: "commandExecution",
    id,
    command,
    cwd: PREVIEW_WORKSPACE,
    processId: null,
    startedAt: null,
    source: "agent",
    status: "completed",
    aggregatedOutput: null,
    liveOutput: null,
    exitCode: 0,
    durationMs,
  };
}

const PREVIEW_PROJECTS = [
  {
    color: "#4ade80",
    name: "codex-app",
    path: "D:\\Workspaces\\codex-app",
  },
  {
    name: "streamplay-app",
    path: "D:\\Workspaces\\streamplay-app",
  },
] as const satisfies readonly ProjectRecord[];

function createPreviewProfileDailyUsage() {
  const firstDay = Date.UTC(2025, 7, 24);
  return Array.from({ length: 365 }, (_, index) => {
    const date = new Date(firstDay + index * 86_400_000).toISOString().slice(0, 10);
    const recent = index >= 210;
    const active = recent && ((index * 13) % 19 <= 11 || index >= 358);
    const tokens =
      index === 341 ? 671_100_000 : active ? (24 + ((index * 47) % 260)) * 1_000_000 : 0;
    return { date, tokens };
  }).filter((bucket) => bucket.tokens > 0);
}

const PREVIEW_ACCOUNT = {
  account: {
    type: "chatgpt",
    email: null,
    name: "Ada",
    picture:
      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' fill='%23546673'/%3E%3Ccircle cx='32' cy='25' r='14' fill='%23f0c6a7'/%3E%3Cpath d='M8 64c3-17 13-25 24-25s21 8 24 25' fill='%23c03f77'/%3E%3Cpath d='M18 24c1-14 26-18 30 1-10-4-18-9-30-1' fill='%23302028'/%3E%3C/svg%3E",
    planType: "pro",
  },
  requiresOpenaiAuth: true,
  refresh: { status: "notRequired", error: null },
} as const satisfies AccountReadResponse;

const PREVIEW_ACCOUNT_PROFILE = {
  displayName: "ADA",
  username: "ada.dev",
  // The production endpoint only accepts HTTPS profile URLs. Keep the
  // self-contained data URI on the base account and exercise a valid nullable
  // profile response without weakening the IPC contract for browser preview.
  picture: null,
  statisticsStatus: "available",
  summary: {
    lifetimeTokens: 9_000_000_000,
    peakDailyTokens: 671_100_000,
    longestRunningTurnSeconds: 28_020,
    currentStreakDays: 7,
    longestStreakDays: 20,
  },
  dailyUsage: createPreviewProfileDailyUsage(),
  activityInsights: {
    fastModePercent: 2,
    mostUsedReasoningEffort: "max",
    mostUsedReasoningEffortPercent: 76,
    uniqueSkillsUsed: 1,
    totalSkillsUsed: 1,
    totalThreads: 660,
    topInvocations: [
      {
        type: "plugin",
        id: "test-android-apps",
        name: "@test-android-apps",
        usageCount: 1,
      },
    ],
  },
} as const satisfies AccountProfileResponse;

const PREVIEW_CONFIG = {
  config: {
    model: PREVIEW_MODEL_ID,
    modelReasoningEffort: PREVIEW_REASONING_EFFORT,
    serviceTier: "fast",
    modelContextWindowPreferences: { [PREVIEW_MODEL_ID]: "maximum" },
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
      "scheduledAutomations",
    ],
  },
  schemaVersion: 18,
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
const PREVIEW_WORKSPACE = "D:\\Workspaces\\streamplay-app";
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
          outputPresentation: { type: "sourceFile", path: "src/contracts/types.ts" },
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
          type: "fileChange",
          id: "preview-isolated-file-change",
          status: "completed",
          changes: [
            {
              path: "crates/media-windows/src/windows/engine.rs",
              kind: { type: "update", movePath: null },
              lineStats: { additions: 6, deletions: 2 },
              diff: [
                "@@ -1,4 +1,7 @@",
                " use std::time::Instant;",
                "-const SAMPLE_COUNT: usize = 5;",
                "-fn old_benchmark() {}",
                "+#[test]",
                "+fn benchmark_targeted_output_search() {",
                "+    const TARGET_BYTES: usize = 64 * 1_024 * 1_024;",
                '+    let message = r#"ready"#;',
                '+    assert!(message.contains("ready"));',
                "+}",
                " fn helper() {}",
              ].join("\n"),
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
            "$candidates = @('C:\\Users\\Developer\\.codex\\bin\\rtk.exe', 'C:\\Users\\Developer\\bin\\rtk.exe')",
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          startedAt: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: null,
          liveOutput: null,
          exitCode: 0,
          durationMs: 18,
        },
        {
          type: "commandExecution",
          id: "preview-command-2",
          command: "rg --files src",
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          startedAt: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: previewOutput(
            "preview-command-output-2",
            "exit_code: 0\nstdout:\nsrc/ui/WindowChrome.tsx\nsrc/ui/turnFailure.ts\nsrc/ui/timelineScroll.ts\nsrc/ui/Timeline.tsx\nsrc/ui/SettingsDialog.tsx\nsrc/ui/Composer.tsx\nsrc/ui/AppShell.tsx\nsrc/state/threadRuntime.ts\nsrc/contracts/types.ts\n\nstderr:\n",
          ),
          liveOutput: null,
          exitCode: 0,
          durationMs: 24,
        },
        {
          type: "commandExecution",
          id: "preview-command-3",
          command: 'rg -n -S "scroll|scrollTop|scrollIntoView|autoScroll|sticky|anchor" src',
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          startedAt: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: null,
          liveOutput: null,
          exitCode: 0,
          durationMs: 31,
        },
        {
          type: "commandExecution",
          id: "preview-command-4",
          command: "Get-Content -LiteralPath package.json -Raw",
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          startedAt: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: null,
          liveOutput: null,
          exitCode: 0,
          durationMs: 19,
        },
        {
          type: "commandExecution",
          id: "preview-command-scroll-1",
          command: "Get-Content -LiteralPath src/ui/Timeline.tsx -Raw",
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          startedAt: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: null,
          liveOutput: null,
          exitCode: 0,
          durationMs: 28,
        },
        {
          type: "commandExecution",
          id: "preview-command-scroll-2",
          command: 'rg -n "agent-activity-viewport|diff-block" src/styles/global.css',
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          startedAt: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: null,
          liveOutput: null,
          exitCode: 0,
          durationMs: 14,
        },
        {
          type: "commandExecution",
          id: "preview-command-scroll-3",
          command: "pnpm exec vitest run src/ui/timelineScroll.test.ts",
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          startedAt: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: null,
          liveOutput: null,
          exitCode: 0,
          durationMs: 410,
        },
        {
          type: "commandExecution",
          id: "preview-command-scroll-4",
          command: "pnpm typecheck",
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          startedAt: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: null,
          liveOutput: null,
          exitCode: 0,
          durationMs: 1_240,
        },
        {
          type: "commandExecution",
          id: "preview-command-scroll-5",
          command: "git diff --check",
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          startedAt: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: null,
          liveOutput: null,
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
              lineStats: { additions: 2, deletions: 2 },
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
            {
              path: "src-tauri/src/engine/native/output_compaction/semantic.rs",
              kind: { type: "add" },
              lineStats: { additions: PREVIEW_CREATED_RUST_LINE_COUNT, deletions: 0 },
              diff: previewCreatedRustDiff(),
            },
            {
              path: "src-tauri/src/engine/native/terminal_output.rs",
              kind: { type: "delete" },
              lineStats: { additions: 0, deletions: 288 },
              diff: [
                "--- a/src-tauri/src/engine/native/terminal_output.rs",
                "+++ /dev/null",
                "@@ -1,3 +0,0 @@",
                "-use std::fs::File;",
                "-use std::io::{Read, Write};",
                "-pub fn normalize_terminal_output() {}",
                "[diff truncated]",
              ].join("\n"),
            },
          ],
        },
        {
          type: "toolExecution",
          id: "preview-source-read",
          name: "read_file",
          description: "Read src/ui/syntax/diffHighlighter.test.ts",
          status: "completed",
          outputPresentation: {
            type: "sourceFile",
            path: "src/ui/syntax/diffHighlighter.test.ts",
          },
          output: previewOutput(
            "preview-source-read-output",
            [
              '20:     const continuation = highlighter.render(document, "src/main.rs", 4);',
              "21: ",
              '22:     expect(opening?.some((token) => token.kind === "comment")).toBe(true);',
              '23:     expect(continuation?.map((token) => token.kind)).toEqual(["comment"]);',
              '24:     expect(continuation === null ? null : continuation.map((token) => token.text).join("")).toBe(',
              '25:       "       continues */",',
              "26:     );",
              "27:   });",
            ].join("\n"),
          ),
        },
        {
          type: "toolExecution",
          id: "preview-search-results",
          name: "search_text",
          description: "Search syntax highlighter usage",
          status: "completed",
          outputPresentation: { type: "searchResults" },
          output: previewOutput(
            "preview-search-results-output",
            [
              'src/ui/syntax/diffHighlighter.test.ts:20:const continuation = highlighter.render(document, "src/main.rs", 4);',
              "src-tauri/src/engine/native/tools/fs.rs:104:let queries = search_query_variants(&args.query);",
            ].join("\n"),
          ),
        },
        {
          type: "toolExecution",
          id: "preview-web-search-1",
          name: "web_search",
          description: "Codex app activity files commands",
          status: "completed",
          outputPresentation: { type: "plainText" },
          output: null,
        },
        {
          type: "toolExecution",
          id: "preview-web-search-2",
          name: "web_search",
          description: "Codex app work activity messages",
          status: "completed",
          outputPresentation: { type: "plainText" },
          output: null,
        },
        {
          type: "toolExecution",
          id: "preview-web-search-3",
          name: "web_search",
          description: "https://developers.openai.com/codex/app/",
          status: "completed",
          outputPresentation: { type: "plainText" },
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
          outputPresentation: { type: "image" },
          output: previewOutput(
            "preview-image-output",
            JSON.stringify({ image_url: PREVIEW_IMAGE_ONE }),
          ),
        },
        {
          type: "toolExecution",
          id: "preview-image-tool-2",
          name: "view_image",
          description: "Visualizou uma imagem",
          status: "completed",
          outputPresentation: { type: "image" },
          output: previewOutput(
            "preview-image-output-2",
            JSON.stringify({ image_url: PREVIEW_IMAGE_TWO }),
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
          startedAt: Date.now() - 35_000,
          source: "agent",
          status: "inProgress",
          aggregatedOutput: null,
          liveOutput: {
            stdout: [
              "vite v8.2.2 building client environment for production...",
              "transforming...",
              "✓ 115 modules transformed.",
              ...Array.from({ length: 24 }, (_, index) => `rendering chunk ${index + 1}/24...`),
              "computing gzip size...",
            ].join("\n"),
            stderr: "warning: release validation is still running\n",
            truncated: false,
          },
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

const PREVIEW_CHAT_REFERENCE_THREAD = {
  id: "preview-chat-reference-thread",
  mode: "codex",
  preview: "Audit project against RULES.md",
  name: "Audit project against RULES.md",
  cwd: PREVIEW_WORKSPACE,
  projectPath: PREVIEW_WORKSPACE,
  createdAt: 1_787_000_000,
  updatedAt: 1_787_000_094,
  recencyAt: 1_787_000_094,
  status: { type: "active", activeFlags: [] },
  turns: [
    {
      id: "preview-chat-reference-turn",
      status: "completed",
      error: null,
      createdAt: 1_787_000_000,
      updatedAt: 1_787_000_094,
      items: [
        {
          type: "userMessage",
          id: "preview-chat-reference-user",
          content: [
            {
              type: "text",
              text: "Estude de forma rápida e entenda esse projeto, veja se ele segue fielmente todas as regras em docs/RULES.md, de forma limpa, enxuta, moderna, robusta, tipagem extremamente forte, organizada, semântica, bem estruturada, modular, dinâmica, abstrata, elegante, totalmente previsível e com boas práticas modernas sem exceção.",
            },
          ],
        },
        {
          type: "agentMessage",
          id: "preview-chat-reference-commentary-1",
          text: "Vou fazer uma auditoria objetiva: primeiro leio `docs/RULES.md` e o mapa do projeto, depois cruzo as regras com a implementação e executo as verificações disponíveis. Entrego os achados priorizados, com evidências em arquivos/linhas e sem alterar nada.",
          phase: "commentary",
        },
        previewCommand(
          "preview-chat-reference-command-1",
          "Get-Content -Raw docs/RULES.md; Write-Output \"`n---FILES---\"; rg --files -g '!node_modules/**'",
        ),
        {
          type: "agentMessage",
          id: "preview-chat-reference-commentary-2",
          text: "O documento define um padrão alto e também algumas regras verificáveis automaticamente (edition 2024, TypeScript estrito, ausência de `unwrap` / `expect` operacional, contratos explícitos, checks e TODO). Agora vou separar conformidade objetiva de julgamento arquitetural, para não tratar estilo como violação sem evidência.",
          phase: "commentary",
        },
        previewCommand("preview-chat-reference-command-2", "pnpm typecheck", 1_240),
        previewCommand("preview-chat-reference-command-3", "pnpm biome check src", 910),
        previewCommand("preview-chat-reference-command-4", "cargo fmt -- --check", 420),
        {
          type: "agentMessage",
          id: "preview-chat-reference-commentary-3",
          text: "Os checks rápidos já passaram: `typecheck`, Biome e `cargo fmt --check`. Os processos mais pesados ainda estão executando em paralelo; há contenção normal do cache/build do Cargo, então vou aguardar os resultados antes de concluir.",
          phase: "commentary",
        },
        {
          type: "toolExecution",
          id: "preview-chat-reference-terminal-read",
          name: "read_output",
          description: "Read stored output preview-chat-terminal",
          status: "completed",
          outputPresentation: { type: "plainText" },
          output: previewOutput(
            "preview-chat-terminal-output",
            "Os processos terminaram sem erros.\n",
          ),
        },
        previewCommand(
          "preview-chat-reference-command-5",
          "cargo check --locked --manifest-path src-tauri/Cargo.toml",
          4_850,
        ),
        previewCommand(
          "preview-chat-reference-command-6",
          "pnpm test:frontend -- --reporter=dot",
          3_120,
        ),
        previewCommand("preview-chat-reference-command-7", "pnpm clippy", 5_240),
        previewCommand(
          "preview-chat-reference-command-8",
          'git log -5 --oneline; Write-Output "---TODO---"; Get-Content -Raw docs/TODO.md',
          38,
        ),
        previewCommand(
          "preview-chat-reference-command-9",
          'Write-Output "---STATUS---"; git status --short',
          18,
        ),
        previewCommand(
          "preview-chat-reference-command-10",
          "$f='src-tauri/src/process.rs'; $lines=Get-Content $f; for($i=45;$i -le 90;$i++){\"$i`: $($lines[$i-1])\"}",
          26,
        ),
        {
          type: "agentMessage",
          id: "preview-chat-reference-answer",
          text: "Auditoria rápida concluída. O projeto está em bom nível e os checks atuais passam, mas não segue 100% todas as regras de `docs/RULES.md`.\n\nResultados objetivos:\n\n- `typecheck`: passou.\n- Biome lint: passou em 144 arquivos.\n- Frontend: 50 arquivos de teste, 236 testes, todos passaram.\n- `cargo check --locked`: passou.\n- `cargo clippy -D warnings`: passou.",
          phase: "finalAnswer",
        },
      ],
    },
  ],
} as const satisfies CodexThread;

const PREVIEW_TIMELINE_STRESS_ACTIVITY_COUNT = 180;

function previewTimelineStressSource(index: number): string {
  return Array.from(
    { length: 72 },
    (_, lineIndex) =>
      `${lineIndex + 1}: export const stressValue${index}_${lineIndex + 1}: number = ${index + lineIndex};`,
  ).join("\n");
}

function previewTimelineStressDiff(index: number): string {
  return [
    "@@ -1,90 +1,90 @@",
    ...Array.from({ length: 90 }, (_, lineIndex) => [
      `-const previous_${index}_${lineIndex} = ${lineIndex};`,
      `+const optimized_${index}_${lineIndex} = ${lineIndex + 1};`,
    ]).flat(),
  ].join("\n");
}

function previewTimelineStressActivities(): readonly VisibleThreadItem[] {
  return Array.from({ length: PREVIEW_TIMELINE_STRESS_ACTIVITY_COUNT }, (_, index) => {
    const ordinal = index + 1;
    switch (index % 3) {
      case 0:
        return {
          type: "commandExecution",
          id: `timeline-stress-command-${ordinal}`,
          command: `pnpm exec benchmark --case timeline-${ordinal}`,
          cwd: PREVIEW_WORKSPACE,
          processId: null,
          startedAt: null,
          source: "agent",
          status: "completed",
          aggregatedOutput: previewOutput(
            `timeline-stress-command-output-${ordinal}`,
            Array.from(
              { length: 96 },
              (_, lineIndex) =>
                `sample ${lineIndex + 1}: ${(ordinal * (lineIndex + 1)).toFixed(3)} ms`,
            ).join("\n"),
          ),
          liveOutput: null,
          exitCode: 0,
          durationMs: ordinal * 7,
        } satisfies VisibleThreadItem;
      case 1:
        return {
          type: "toolExecution",
          id: `timeline-stress-tool-${ordinal}`,
          name: "read_file",
          description: `Leu src/stress/module-${ordinal}.ts`,
          status: "completed",
          outputPresentation: {
            type: "sourceFile",
            path: `src/stress/module-${ordinal}.ts`,
          },
          output: previewOutput(
            `timeline-stress-tool-output-${ordinal}`,
            previewTimelineStressSource(ordinal),
          ),
        } satisfies VisibleThreadItem;
      case 2:
        return {
          type: "fileChange",
          id: `timeline-stress-change-${ordinal}`,
          status: "completed",
          changes: [
            {
              path: `src/stress/module-${ordinal}.ts`,
              kind: { type: "update", movePath: null },
              lineStats: { additions: 90, deletions: 90 },
              diff: previewTimelineStressDiff(ordinal),
            },
          ],
        } satisfies VisibleThreadItem;
      default:
        throw new Error("O gerador de estresse da timeline produziu uma categoria inválida.");
    }
  });
}

const PREVIEW_TIMELINE_STRESS_THREAD = {
  id: "preview-timeline-stress-thread",
  mode: "codex",
  preview: "Estresse de timeline expandida",
  name: "Estresse de timeline expandida",
  cwd: PREVIEW_WORKSPACE,
  projectPath: PREVIEW_WORKSPACE,
  createdAt: PREVIEW_NOW_SECONDS - 900,
  updatedAt: PREVIEW_NOW_SECONDS - 30,
  recencyAt: PREVIEW_NOW_SECONDS - 30,
  status: { type: "idle" },
  turns: [
    {
      id: "preview-timeline-stress-turn",
      status: "completed",
      error: null,
      createdAt: PREVIEW_NOW_SECONDS - 900,
      updatedAt: PREVIEW_NOW_SECONDS - 30,
      items: [
        {
          type: "userMessage",
          id: "timeline-stress-user-message",
          content: [
            {
              type: "text",
              text: "Expanda todas as ferramentas e mantenha a conversa fluida ao trocar de chat.",
            },
          ],
        },
        {
          type: "agentMessage",
          id: "timeline-stress-commentary",
          text: "Executando um lote grande de leituras, comandos e alterações para validar a timeline.",
          phase: "commentary",
        },
        ...previewTimelineStressActivities(),
        {
          type: "agentMessage",
          id: "timeline-stress-final-answer",
          text: "Cenário de estresse concluído.",
          phase: "finalAnswer",
        },
      ],
    },
  ],
} as const satisfies CodexThread;

const PREVIEW_TIMELINE_LIGHT_THREAD = {
  id: "preview-timeline-light-thread",
  mode: "codex",
  preview: "Chat leve de controle",
  name: "Chat leve de controle",
  cwd: PREVIEW_WORKSPACE,
  projectPath: PREVIEW_WORKSPACE,
  createdAt: PREVIEW_NOW_SECONDS - 600,
  updatedAt: PREVIEW_NOW_SECONDS - 60,
  recencyAt: PREVIEW_NOW_SECONDS - 60,
  status: { type: "idle" },
  turns: [
    {
      id: "preview-timeline-light-turn",
      status: "completed",
      error: null,
      createdAt: PREVIEW_NOW_SECONDS - 600,
      updatedAt: PREVIEW_NOW_SECONDS - 60,
      items: [
        {
          type: "userMessage",
          id: "timeline-light-user-message",
          content: [{ type: "text", text: "Confirme que este chat permanece leve." }],
        },
        {
          type: "agentMessage",
          id: "timeline-light-final-answer",
          text: "Chat de controle pronto.",
          phase: "finalAnswer",
        },
      ],
    },
  ],
} as const satisfies CodexThread;

const PREVIEW_TIMELINE_STRESS_THREADS = {
  data: [
    previewThreadSummary(PREVIEW_TIMELINE_STRESS_THREAD),
    previewThreadSummary(PREVIEW_TIMELINE_LIGHT_THREAD),
  ],
  nextCursor: null,
} as const satisfies ThreadListResponse;

const PREVIEW_TIMELINE_STRESS_THREADS_BY_ID = new Map<string, CodexThread>([
  [PREVIEW_TIMELINE_STRESS_THREAD.id, PREVIEW_TIMELINE_STRESS_THREAD],
  [PREVIEW_TIMELINE_LIGHT_THREAD.id, PREVIEW_TIMELINE_LIGHT_THREAD],
]);

const PREVIEW_THREADS = {
  data: [previewThreadSummary(PREVIEW_CONTEXT_THREAD)],
  nextCursor: null,
} as const satisfies ThreadListResponse;

const PREVIEW_AUTOMATION_ID = "preview-automation-review";
const previewAutomationNow = Math.floor(Date.now() / 1_000);
let previewAutomations: Automation[] = [
  {
    id: PREVIEW_AUTOMATION_ID,
    name: "Revisar regressões",
    prompt:
      "Analise as alterações recentes, execute os testes relevantes e resuma regressões, riscos e próximos passos.",
    projectPath: PREVIEW_WORKSPACE,
    enabled: true,
    intervalMinutes: 60,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffsetMin: new Date().getTimezoneOffset(),
    nextRunAt: previewAutomationNow + 3_600,
    lastRunAt: previewAutomationNow - 7_200,
    version: 1,
    createdAt: previewAutomationNow - 86_400,
    updatedAt: previewAutomationNow - 7_200,
  },
];
let previewAutomationRuns: AutomationRun[] = [
  {
    id: "preview-automation-run",
    automationId: PREVIEW_AUTOMATION_ID,
    trigger: "scheduled",
    status: "completed",
    threadId: PREVIEW_CONTEXT_THREAD.id,
    turnId: PREVIEW_CONTEXT_THREAD.turns.at(-1)?.id ?? null,
    error: null,
    reviewed: false,
    createdAt: previewAutomationNow - 7_260,
    startedAt: previewAutomationNow - 7_250,
    completedAt: previewAutomationNow - 7_200,
  },
];

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
    limitId: "codex",
    limitName: null,
    primary: {
      usedPercent: 43,
      windowDurationMins: 300,
      resetsAt: Date.parse("2026-08-22T11:45:00-03:00"),
    },
    secondary: {
      usedPercent: 93,
      windowDurationMins: 10_080,
      resetsAt: Date.parse("2026-08-27T05:38:00-03:00"),
    },
    credits: { hasCredits: true, unlimited: false, balance: "R$ 0" },
    individualLimit: null,
    spendControlReached: null,
    planType: "pro",
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {
    codex_spark: {
      limitId: "codex_spark",
      limitName: "GPT-5.3-Codex-Spark",
      primary: {
        usedPercent: 0,
        windowDurationMins: 300,
        resetsAt: Date.parse("2026-08-22T08:45:00-03:00"),
      },
      secondary: {
        usedPercent: 100,
        windowDurationMins: 10_080,
        resetsAt: Date.parse("2026-08-23T06:03:00-03:00"),
      },
      credits: null,
      individualLimit: null,
      spendControlReached: null,
      planType: "pro",
      rateLimitReachedType: null,
    },
  },
  planPrice: { amount: 52_500, currency: "BRL", minorUnitExponent: 2 },
} as const satisfies AccountRateLimitsResponse;

let previewUsageResets: UsageResetCreditsResponse = {
  credits: [
    {
      id: "preview-reset-credit",
      title: "Redefinição completa",
      status: "available",
      expiresAt: Date.parse("2026-09-20T21:16:00-03:00"),
    },
  ],
  availableCount: 1,
  immediateResetPurchaseEligible: true,
};

let previewAutoTopUpSettings: AutoTopUpSettingsSnapshot = {
  available: true,
  isEnabled: false,
  hasPaymentMethod: true,
  rechargeThreshold: "125",
  rechargeTarget: "250",
  rechargeMonthlyLimit: null,
  autoReloadCreditDiscountPolicy: "volume_discount_with_auto_reload_incentive_v1",
  maximumDiscountPercent: 40,
};

let previewApplicationPreferences: ApplicationPreferences = {
  schemaVersion: 1,
  startWithWindows: true,
  startMinimized: false,
  closeToTray: true,
} satisfies ApplicationPreferences;

export function setupBrowserPreview(): void {
  const previewParameters = new URLSearchParams(window.location.search);
  const preferenceUpdateDelay = previewDelay(previewParameters.get("preferenceDelay"));
  const timelineStressPreview = previewParameters.get("timelineStress") === "1";
  const previewThread = timelineStressPreview
    ? PREVIEW_TIMELINE_STRESS_THREAD
    : previewParameters.get("chatReference") === "1"
      ? PREVIEW_CHAT_REFERENCE_THREAD
      : PREVIEW_CONTEXT_THREAD;
  const previewThreads = timelineStressPreview
    ? PREVIEW_TIMELINE_STRESS_THREADS
    : previewThread === PREVIEW_CONTEXT_THREAD
      ? PREVIEW_THREADS
      : ({
          data: [previewThreadSummary(previewThread)],
          nextCursor: null,
        } as const satisfies ThreadListResponse);
  document.title = "Codex App · Visualização";
  document.documentElement.setAttribute("data-runtime", "browser-preview");
  if (previewParameters.get("chrome") === "1") {
    document.documentElement.setAttribute("data-window-chrome-preview", "true");
  }
  saveProjects(PREVIEW_PROJECTS);
  const previewBrowserTabs = new Map<string, BrowserTabSnapshot>();

  mockIPC(
    (command, args) => {
      switch (command) {
        case "browser_tab_create": {
          const browserTabId = readPreviewRequestString(args, "browserTabId");
          const existing = previewBrowserTabs.get(browserTabId);
          if (existing !== undefined) {
            return existing;
          }
          const snapshot = {
            browserTabId,
            conversationId: readPreviewRequestString(args, "conversationId"),
            url: readPreviewRequestString(args, "url"),
            title: null,
            canGoBack: false,
            canGoForward: false,
            isLoading: false,
          } satisfies BrowserTabSnapshot;
          previewBrowserTabs.set(browserTabId, snapshot);
          return snapshot;
        }
        case "browser_tab_navigate": {
          const browserTabId = readPreviewRequestString(args, "browserTabId");
          const current = previewBrowserTabs.get(browserTabId);
          if (current === undefined) {
            throw new Error("A aba solicitada não existe na prévia do navegador.");
          }
          const snapshot = {
            ...current,
            url: readPreviewRequestString(args, "url"),
            title: "Página de prévia",
            canGoBack: current.url !== "about:blank",
            isLoading: false,
          } satisfies BrowserTabSnapshot;
          previewBrowserTabs.set(browserTabId, snapshot);
          return snapshot;
        }
        case "browser_tab_back":
        case "browser_tab_forward":
        case "browser_tab_reload": {
          const browserTabId = readPreviewRequestString(args, "browserTabId");
          const snapshot = previewBrowserTabs.get(browserTabId);
          if (snapshot === undefined) {
            throw new Error("A aba solicitada não existe na prévia do navegador.");
          }
          return snapshot;
        }
        case "browser_tab_close":
          previewBrowserTabs.delete(readPreviewRequestString(args, "browserTabId"));
          return { applied: true };
        case "browser_surface_sync":
          return { applied: true };
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
          return previewThreads;
        case "engine_automation_list":
          return {
            data: previewAutomations,
            runs: previewAutomationRuns,
          } satisfies AutomationListResponse;
        case "engine_automation_create": {
          const request = readPreviewAutomationRequest(args);
          const now = Math.floor(Date.now() / 1_000);
          const automation: Automation = {
            id: `preview-automation-${Date.now()}`,
            ...request,
            nextRunAt: request.enabled ? now + request.intervalMinutes * 60 : null,
            lastRunAt: null,
            version: 1,
            createdAt: now,
            updatedAt: now,
          };
          previewAutomations = [automation, ...previewAutomations];
          return automation;
        }
        case "engine_automation_update": {
          const request = readPreviewAutomationRequest(args);
          const automationId = readPreviewRequestString(args, "id");
          const expectedVersion = readPreviewRequestNumber(args, "expectedVersion");
          const current = previewAutomations.find((automation) => automation.id === automationId);
          if (current === undefined || current.version !== expectedVersion) {
            throw new Error("A automação de prévia foi alterada por outra operação.");
          }
          const now = Math.floor(Date.now() / 1_000);
          const automation: Automation = {
            ...current,
            ...request,
            nextRunAt: request.enabled ? now + request.intervalMinutes * 60 : null,
            version: current.version + 1,
            updatedAt: now,
          };
          previewAutomations = previewAutomations.map((entry) =>
            entry.id === automationId ? automation : entry,
          );
          return automation;
        }
        case "engine_automation_delete": {
          const automationId = readPreviewRequestString(args, "automationId");
          previewAutomations = previewAutomations.filter(
            (automation) => automation.id !== automationId,
          );
          previewAutomationRuns = previewAutomationRuns.filter(
            (run) => run.automationId !== automationId,
          );
          return { applied: true };
        }
        case "engine_automation_run_now": {
          const automationId = readPreviewRequestString(args, "automationId");
          const automation = previewAutomations.find((entry) => entry.id === automationId);
          if (automation === undefined) {
            throw new Error("A automação de prévia não existe.");
          }
          const now = Math.floor(Date.now() / 1_000);
          const run: AutomationRun = {
            id: `preview-automation-run-${Date.now()}`,
            automationId,
            trigger: "manual",
            status: "completed",
            threadId: PREVIEW_CONTEXT_THREAD.id,
            turnId: PREVIEW_CONTEXT_THREAD.turns.at(-1)?.id ?? null,
            error: null,
            reviewed: false,
            createdAt: now,
            startedAt: now,
            completedAt: now,
          };
          previewAutomationRuns = [run, ...previewAutomationRuns];
          return run;
        }
        case "engine_automation_run_mark_reviewed": {
          const runId = readPreviewRequestString(args, "runId");
          previewAutomationRuns = previewAutomationRuns.map((run) =>
            run.id === runId ? { ...run, reviewed: true } : run,
          );
          return { applied: true };
        }
        case "engine_thread_resume": {
          const resumedThread = timelineStressPreview
            ? PREVIEW_TIMELINE_STRESS_THREADS_BY_ID.get(readPreviewRequestString(args, "threadId"))
            : previewThread;
          if (resumedThread === undefined) {
            throw new Error("A tarefa solicitada não existe na prévia de estresse.");
          }
          return {
            thread: resumedThread,
            cwd: resumedThread.cwd,
            nextCursor: null,
          };
        }
        case "engine_account_rate_limits_read":
          return PREVIEW_RATE_LIMITS;
        case "engine_account_usage_resets_read":
          return previewUsageResets;
        case "engine_account_usage_reset_redeem": {
          const request = (args as { request?: { creditId?: string | null } }).request;
          const redeemedId = request?.creditId ?? previewUsageResets.credits[0]?.id ?? null;
          previewUsageResets = {
            ...previewUsageResets,
            availableCount: Math.max(0, previewUsageResets.availableCount - 1),
            credits: previewUsageResets.credits.filter((credit) => credit.id !== redeemedId),
          };
          return { code: "reset", creditId: redeemedId };
        }
        case "engine_account_auto_top_up_read":
          return previewAutoTopUpSettings;
        case "engine_account_auto_top_up_enable":
        case "engine_account_auto_top_up_update": {
          const request = (
            args as {
              request?: {
                rechargeMonthlyLimit?: string | null;
                rechargeTarget?: string;
                rechargeThreshold?: string;
              };
            }
          ).request;
          previewAutoTopUpSettings = {
            ...previewAutoTopUpSettings,
            isEnabled: true,
            rechargeMonthlyLimit: request?.rechargeMonthlyLimit ?? null,
            rechargeTarget: request?.rechargeTarget ?? "250",
            rechargeThreshold: request?.rechargeThreshold ?? "125",
          };
          return previewAutoTopUpSettings;
        }
        case "engine_account_auto_top_up_disable":
          previewAutoTopUpSettings = {
            ...previewAutoTopUpSettings,
            isEnabled: false,
          };
          return previewAutoTopUpSettings;
        case "application_preferences_read":
          return previewApplicationPreferences;
        case "application_preferences_update": {
          const preferences = (args as { preferences?: ApplicationPreferences }).preferences;
          if (preferences === undefined) {
            throw new Error("A atualização de preferências não recebeu um valor.");
          }
          const applyPreferences = () => {
            previewApplicationPreferences = preferences;
            return previewApplicationPreferences;
          };
          return preferenceUpdateDelay === 0
            ? applyPreferences()
            : new Promise<ApplicationPreferences>((resolve) => {
                window.setTimeout(() => resolve(applyPreferences()), preferenceUpdateDelay);
              });
        }
        case "application_workspace_open": {
          const request = (args as { request?: { path?: string } }).request;
          (
            window as Window & {
              __previewOpenedWorkspace?: string;
            }
          ).__previewOpenedWorkspace = request?.path ?? "";
          return { applied: true };
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

function readPreviewAutomationRequest(args: unknown): {
  readonly enabled: boolean;
  readonly intervalMinutes: number;
  readonly name: string;
  readonly projectPath: string | null;
  readonly prompt: string;
  readonly timezone: string;
  readonly timezoneOffsetMin: number;
} {
  const request = (args as { request?: PreviewAutomationRequestRecord }).request;
  if (request === undefined) {
    throw new Error("A operação de automação não recebeu um request.");
  }
  const projectPath = request.projectPath;
  if (projectPath !== null && typeof projectPath !== "string") {
    throw new Error("O projeto da automação de prévia é inválido.");
  }
  if (typeof request.enabled !== "boolean") {
    throw new Error("O estado da automação de prévia é inválido.");
  }
  return {
    enabled: request.enabled,
    intervalMinutes: readPreviewRequestNumber(args, "intervalMinutes"),
    name: readPreviewRequestString(args, "name"),
    projectPath,
    prompt: readPreviewRequestString(args, "prompt"),
    timezone: readPreviewRequestString(args, "timezone"),
    timezoneOffsetMin: readPreviewRequestNumber(args, "timezoneOffsetMin"),
  };
}

interface PreviewAutomationRequestRecord extends Record<string, unknown> {
  readonly enabled?: unknown;
  readonly projectPath?: unknown;
}

function readPreviewRequestString(args: unknown, key: string): string {
  const value = (args as { request?: Record<string, unknown> }).request?.[key];
  if (typeof value !== "string") {
    throw new Error(`O campo ${key} do request de prévia é inválido.`);
  }
  return value;
}

function readPreviewRequestNumber(args: unknown, key: string): number {
  const value = (args as { request?: Record<string, unknown> }).request?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`O campo ${key} do request de prévia é inválido.`);
  }
  return value;
}

function previewDelay(value: string | null): number {
  if (value === null) {
    return 0;
  }
  const delay = Number(value);
  return Number.isInteger(delay) && delay >= 0 && delay <= 2_000 ? delay : 0;
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
