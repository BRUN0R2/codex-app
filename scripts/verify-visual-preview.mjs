import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VITE_ENTRY = path.join(PROJECT_ROOT, "node_modules", "vite", "bin", "vite.js");
const PREVIEW_PORT = 1420;
const HOME_PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}/?preview=1&chrome=1`;
const CHAT_REFERENCE_PREVIEW_URL = `${HOME_PREVIEW_URL}&chatReference=1`;
const TIMELINE_STRESS_PREVIEW_URL = `${HOME_PREVIEW_URL}&timelineStress=1`;
const TIMELINE_EXTREME_PREVIEW_URL = `${TIMELINE_STRESS_PREVIEW_URL}&timelineFiles=100000`;
const ACTIVITY_RECONCILIATION_PREVIEW_URL = `${TIMELINE_STRESS_PREVIEW_URL}&activityReconciliation=1`;
const BROWSER_PANEL_PREVIEW_URL = `${TIMELINE_STRESS_PREVIEW_URL}&browser=1`;
const BROWSER_DEBUG_PREVIEW_URL = `${BROWSER_PANEL_PREVIEW_URL}&browserMetrics=1`;
const OFFICIAL_READ_ICON_PATH =
  "M16.3965 5.01128C16.3963 4.93399 16.3489 4.87691 16.293 4.85406L16.2354 4.84332C13.9306 4.91764 12.5622 5.32101 10.665 6.34722V16.3716C11.3851 15.9994 12.0688 15.7115 12.7861 15.5015C13.8286 15.1965 14.9113 15.0633 16.2402 15.0435L16.2979 15.0308C16.353 15.0063 16.3965 14.9483 16.3965 14.8755V5.01128ZM3.54492 14.8765C3.54492 14.9725 3.62159 15.0422 3.70117 15.0435L4.19629 15.0562C5.94062 15.1247 7.26036 15.4201 8.65918 16.0484C8.05544 15.1706 7.14706 14.436 6.17871 14.1109V14.1099C5.56757 13.9045 5.16816 13.3314 5.16797 12.6988V4.98882C4.86679 4.93786 4.60268 4.8999 4.28223 4.87457L3.72754 4.84429C3.62093 4.84079 3.54505 4.92417 3.54492 5.01226V14.8765ZM17.7266 14.8755C17.7266 15.6314 17.1607 16.2751 16.4121 16.3628L16.2598 16.3736C15.0122 16.3922 14.0555 16.5159 13.1602 16.7779C12.2629 17.0404 11.3966 17.4508 10.3369 18.0738C10.129 18.1959 9.87099 18.1958 9.66309 18.0738C7.71455 16.9283 6.31974 16.4689 4.12988 16.3853L3.68164 16.3736C2.85966 16.3614 2.21484 15.6838 2.21484 14.8765V5.01226C2.21497 4.15391 2.93263 3.4871 3.77246 3.51519L4.39844 3.54937C4.67996 3.57191 4.92258 3.60421 5.16797 3.64214V2.51031C5.16797 1.44939 6.29018 0.645615 7.31055 1.15679L7.31152 1.15582C8.78675 1.89511 10.0656 3.33006 10.5352 4.91461C12.3595 3.98907 13.8688 3.58817 16.1924 3.51324L16.3506 3.51714C17.1285 3.5741 17.7264 4.23496 17.7266 5.01128V14.8755ZM6.49805 12.6988C6.49824 12.7723 6.5442 12.8296 6.60254 12.8492L6.96289 12.9859C7.85245 13.3586 8.68125 13.9846 9.33496 14.7496V5.5816C9.08794 4.37762 8.13648 3.1566 6.95801 2.47613L6.71582 2.34527C6.67779 2.32617 6.6337 2.32502 6.58301 2.35796C6.52946 2.39279 6.49805 2.44863 6.49805 2.51031V12.6988Z";
const SETTINGS_PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}/?preview=1&chrome=1&settings=general`;
const USAGE_SETTINGS_PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}/?preview=1&chrome=1&settings=usage`;
const SETTINGS_INTERACTION_PREVIEW_URL = `${SETTINGS_PREVIEW_URL}&preferenceDelay=400`;
const AUTOMATIONS_PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}/?preview=1&chrome=1&surface=automations`;
const PROFILE_PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}/?preview=1&chrome=1&settings=profile`;
const ARTIFACT_DIRECTORY = path.join(PROJECT_ROOT, ".freebuff", "visual-audit");
const VIEWPORTS = [
  { width: 920, height: 640 },
  { width: 1280, height: 820 },
  { width: 1920, height: 1080 },
];
const FILE_VIEWER_VIEWPORTS = [
  { width: 789, height: 422 },
  { width: 881, height: 1030 },
  { width: 1280, height: 720 },
  { width: 1920, height: 1080 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
  { width: 7680, height: 4320 },
];
const REQUESTED_SCENARIOS = new Set(
  (process.env.CODEX_VISUAL_SCENARIOS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0),
);
const SCENARIOS = [
  {
    id: "composer-fast-mode",
    url: HOME_PREVIEW_URL,
    readyExpression: `document.querySelector(".model-speed-indicator") !== null &&
      document.querySelector(".model-speed-indicator + .model-button-name") !== null`,
    auditExpression: composerFastModeVisualAuditExpression,
    validate: validateComposerFastModeMetrics,
  },
  {
    id: "active-activity-reflection",
    url: HOME_PREVIEW_URL,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Inspecionar janela de contexto"),
    )`,
    prepareExpression: `(() => {
      const threadButton = [...document.querySelectorAll(".thread-main")].find(
        (button) => button.textContent?.includes("Inspecionar janela de contexto"),
      );
      threadButton?.click();
    })()`,
    readyExpression: `document.querySelector(
      ".activity-title.is-running.is-shimmer-active .activity-title-sweep",
    ) !== null`,
    auditExpression: activeActivityReflectionVisualAuditExpression,
    validate: validateActiveActivityReflectionMetrics,
  },
  {
    id: "user-message-navigation",
    url: HOME_PREVIEW_URL,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Inspecionar janela de contexto"),
    )`,
    prepareExpression: `(() => {
      const threadButton = [...document.querySelectorAll(".thread-main")].find(
        (button) => button.textContent?.includes("Inspecionar janela de contexto"),
      );
      threadButton?.click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const activeTurn = [...document.querySelectorAll(".conversation-turn")].at(-1);
        const group = activeTurn?.querySelector(".agent-activity-group:not([open]) > summary");
        group?.click();
        queueMicrotask(() => {
          document.querySelectorAll(".user-message-navigator button")[2]?.click();
          requestAnimationFrame(() => {
            window.__previewUserMessageNavigationRequested = true;
          });
        });
      }));
    })()`,
    readyExpression: `(() => {
      if (window.__previewUserMessageNavigationRequested !== true) {
        return false;
      }
      const timeline = document.querySelector(".timeline");
      const target = document.getElementById("user-message-preview-image-user-message");
      const marker = document.querySelectorAll(".user-message-navigator button")[2];
      if (
        !(timeline instanceof HTMLElement) ||
        !(target instanceof HTMLElement) ||
        !(marker instanceof HTMLButtonElement)
      ) {
        return false;
      }
      const targetGap =
        target.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
      const targetOffset = timeline.scrollTop + targetGap;
      const maximumScroll = timeline.scrollHeight - timeline.clientHeight;
      const expectedScroll = Math.min(maximumScroll, Math.max(0, targetOffset - 32));
      return Math.abs(timeline.scrollTop - expectedScroll) <= 2 &&
        marker.getAttribute("aria-current") === "true";
    })()`,
    auditExpression: userMessageNavigationVisualAuditExpression,
    validate: validateUserMessageNavigationMetrics,
  },
  {
    id: "manual-scroll-ownership",
    url: HOME_PREVIEW_URL,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Inspecionar janela de contexto"),
    )`,
    prepareExpression: manualScrollOwnershipPrepareExpression(),
    readyExpression: `window.__previewManualScrollReady === true`,
    auditExpression: manualScrollOwnershipVisualAuditExpression,
    validate: validateManualScrollOwnershipMetrics,
  },
  {
    id: "nested-scroll-handoff",
    url: HOME_PREVIEW_URL,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Inspecionar janela de contexto"),
    )`,
    prepareExpression: nestedScrollHandoffPrepareExpression(),
    readyExpression: `window.__previewNestedScrollReady === true`,
    auditExpression: nestedScrollHandoffVisualAuditExpression,
    validate: validateNestedScrollHandoffMetrics,
  },
  {
    id: "nested-scroll-wheel-ownership",
    url: TIMELINE_STRESS_PREVIEW_URL,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Estresse de timeline expandida"),
    )`,
    prepareExpression: nestedScrollWheelOwnershipPrepareExpression(),
    readyExpression: `window.__previewNestedWheelReady === true`,
    interact: exerciseNestedScrollWheelOwnership,
    auditExpression: nestedScrollWheelOwnershipAuditExpression,
    validate: validateNestedScrollWheelOwnershipMetrics,
  },
  {
    id: "nested-scroll-following",
    url: HOME_PREVIEW_URL,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Inspecionar janela de contexto"),
    )`,
    prepareExpression: nestedScrollFollowingPrepareExpression(),
    readyExpression: `window.__previewNestedFollowReady === true`,
    auditExpression: nestedScrollFollowingVisualAuditExpression,
    validate: validateNestedScrollFollowingMetrics,
  },
  {
    id: "live-command-output",
    url: HOME_PREVIEW_URL,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Inspecionar janela de contexto"),
    )`,
    prepareExpression: `(() => {
      const threadButton = [...document.querySelectorAll(".thread-main")].find(
        (button) => button.textContent?.includes("Inspecionar janela de contexto"),
      );
      threadButton?.click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const group = [...document.querySelectorAll(".agent-activity-group")].find(
          (details) => details.querySelector(":scope > summary .activity-title.is-running") !== null,
        );
        if (group instanceof HTMLDetailsElement && !group.open) {
          group.querySelector(":scope > summary")?.click();
        }
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const command = [...document.querySelectorAll(".command-activity-card")].find(
            (details) => details.querySelector(":scope > summary .activity-title.is-running") !== null,
          );
          if (command instanceof HTMLDetailsElement && !command.open) {
            command.querySelector(":scope > summary")?.click();
          }
        }));
      }));
    })()`,
    readyExpression: `document.querySelector(".command-activity-card[open] .command-live-output code")
      ?.textContent?.includes("computing gzip size...") === true`,
    auditExpression: liveCommandOutputVisualAuditExpression,
    validate: validateLiveCommandOutputMetrics,
  },
  {
    id: "single-file-change",
    url: HOME_PREVIEW_URL,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Inspecionar janela de contexto"),
    )`,
    prepareExpression: `(() => {
      const threadButton = [...document.querySelectorAll(".thread-main")].find(
        (button) => button.textContent?.includes("Inspecionar janela de contexto"),
      );
      threadButton?.click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.querySelectorAll(".agent-activity-group:not([open]) > summary").forEach(
          (summary) => summary.click(),
        );
      }));
    })()`,
    readyExpression: `(() => {
      const files = new Set(
        [...document.querySelectorAll(".file-change-diff .diff-file-identity code")].map(
          (element) => element.textContent?.trim(),
        ),
      );
      return ["engine.rs", "setupBrowserPreview.ts", "semantic.rs", "terminal_output.rs"].every(
        (file) => files.has(file),
      );
    })()`,
    auditExpression: singleFileChangeVisualAuditExpression,
    interact: exerciseIntrinsicActivityInteraction,
    validate: validateSingleFileChangeMetrics,
  },
  {
    id: "syntax-highlighted-diff",
    url: HOME_PREVIEW_URL,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Inspecionar janela de contexto"),
    )`,
    prepareExpression: `(() => {
      const csp = document.createElement("meta");
      csp.httpEquiv = "Content-Security-Policy";
      csp.content = "style-src 'self'";
      document.head.append(csp);
      const threadButton = [...document.querySelectorAll(".thread-main")].find(
        (button) => button.textContent?.includes("Inspecionar janela de contexto"),
      );
      threadButton?.click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const file = [...document.querySelectorAll(".file-change-diff .diff-file-identity code")].find(
          (element) => element.textContent?.trim() === "engine.rs",
        );
        const block = file?.closest(".file-change-diff");
        if (block instanceof HTMLDetailsElement && !block.open) {
          block.querySelector(":scope > summary")?.click();
        }
        requestAnimationFrame(() =>
          block?.scrollIntoView({ behavior: "auto", block: "start" }),
        );
      }));
    })()`,
    readyExpression: `[...document.querySelectorAll(".file-change-diff .diff-file-identity code")].some(
      (element) =>
        element.textContent?.trim() === "engine.rs" &&
        element.closest(".file-change-diff")?.querySelector(".syntax-token") !== null,
    )`,
    auditExpression: syntaxHighlightedDiffVisualAuditExpression,
    validate: validateSyntaxHighlightedDiffMetrics,
  },
  {
    id: "review-file-layout",
    url: TIMELINE_STRESS_PREVIEW_URL,
    viewports: FILE_VIEWER_VIEWPORTS,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Estresse de timeline expandida"),
    )`,
    prepareExpression: `(() => {
      void (async () => {
        const csp = document.createElement("meta");
        csp.httpEquiv = "Content-Security-Policy";
        csp.content = "style-src 'self'";
        document.head.append(csp);
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const waitUntil = async (label, predicate) => {
          const deadline = performance.now() + 5_000;
          while (!predicate()) {
            if (performance.now() > deadline) {
              throw new Error("Tempo esgotado preparando " + label + ".");
            }
            await frame();
          }
        };
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Estresse de timeline expandida"),
        );
        threadButton?.click();
        await waitUntil(
          "o gatilho da revisão",
          () => document.querySelector(".plan-review-trigger") instanceof HTMLButtonElement,
        );
        document.querySelector(".plan-review-trigger")?.click();
        await waitUntil(
          "a lista de arquivos da revisão",
          () => document.querySelector(".review-file-option") instanceof HTMLButtonElement,
        );
        const largeFile = [...document.querySelectorAll(".review-file-option")].find(
          (option) => option.querySelector("code")?.textContent?.endsWith("module-15.ts"),
        );
        if (!(largeFile instanceof HTMLButtonElement)) {
          throw new Error("O arquivo grande da revisão está ausente.");
        }
        largeFile.click();
        await waitUntil(
          "as linhas virtuais da revisão",
          () => document.querySelector(".review-panel .diff-virtual-row") instanceof HTMLElement,
        );
        await frame();
        await frame();
        const measureReviewVirtualization = () => {
          const diffViewport = document.querySelector(".review-panel .diff-viewport");
          const canvas = diffViewport?.querySelector(".diff-virtual-canvas");
          if (!(diffViewport instanceof HTMLElement) || !(canvas instanceof HTMLElement)) {
            throw new Error("A geometria virtual da revisão está ausente.");
          }
          const rows = [...diffViewport.querySelectorAll(".diff-virtual-row")];
          const viewportBounds = diffViewport.getBoundingClientRect();
          const rowTopOffsets = rows.map(
            (row) => row.getBoundingClientRect().top - viewportBounds.top,
          );
          return {
            canvasHeight: canvas.getBoundingClientRect().height,
            clientHeight: diffViewport.clientHeight,
            mountedRowIndexes: rows.map((row) =>
              Number.parseInt(row.getAttribute("aria-rowindex") ?? "0", 10),
            ),
            rowGaps: rowTopOffsets.slice(1).map(
              (top, rowIndex) => top - (rowTopOffsets[rowIndex] ?? top),
            ),
            rowInlineTops: rows.map((row) =>
              row instanceof HTMLElement ? row.style.top : null,
            ),
            scrollHeight: diffViewport.scrollHeight,
            scrollTop: diffViewport.scrollTop,
          };
        };
        const initial = measureReviewVirtualization();
        const diffViewport = document.querySelector(".review-panel .diff-viewport");
        if (!(diffViewport instanceof HTMLElement)) {
          throw new Error("A viewport da revisão está ausente.");
        }
        diffViewport.scrollTop = diffViewport.scrollHeight;
        await frame();
        await frame();
        await frame();
        const bottom = measureReviewVirtualization();
        diffViewport.scrollTop = 0;
        await frame();
        await frame();
        await frame();
        const restored = measureReviewVirtualization();
        window.__previewReviewVirtualizationCycle = { initial, bottom, restored };
      })();
    })()`,
    readyExpression: `document.querySelector(".review-file-option.selected code")?.textContent?.endsWith("module-15.ts") === true &&
      document.querySelector(".review-panel .diff-virtual-row") !== null &&
      window.__previewReviewVirtualizationCycle !== undefined`,
    auditExpression: reviewFileLayoutVisualAuditExpression,
    interact: exerciseWorkspaceSplitInteraction,
    validate: validateReviewFileLayoutMetrics,
  },
  {
    id: "syntax-highlighted-created-file",
    url: HOME_PREVIEW_URL,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Inspecionar janela de contexto"),
    )`,
    prepareExpression: previewFileDetailPrepareExpression("semantic.rs"),
    readyExpression: `window.__previewCreatedFileMetrics !== undefined ||
      window.__previewCreatedFileError !== undefined`,
    auditExpression: syntaxHighlightedCreatedFileVisualAuditExpression,
    validate: validateSyntaxHighlightedCreatedFileMetrics,
  },
  {
    id: "highlighted-tool-output",
    url: HOME_PREVIEW_URL,
    viewports: FILE_VIEWER_VIEWPORTS,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Inspecionar janela de contexto"),
    )`,
    prepareExpression: previewHighlightedToolOutputsPrepareExpression(),
    readyExpression: `window.__previewHighlightedToolMetrics !== undefined`,
    auditExpression: highlightedToolOutputVisualAuditExpression,
    interact: exerciseHighlightedReadInteraction,
    validate: validateHighlightedToolOutputMetrics,
  },
  {
    id: "composer-popover-layering",
    url: TIMELINE_STRESS_PREVIEW_URL,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Estresse de timeline expandida"),
    )`,
    prepareExpression: composerPopoverLayeringPrepareExpression(),
    readyExpression: `window.__previewComposerPopoverLayeringReady === true`,
    auditExpression: composerPopoverLayeringVisualAuditExpression,
    validate: validateComposerPopoverLayeringMetrics,
  },
  {
    id: "chat-reference",
    url: CHAT_REFERENCE_PREVIEW_URL,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Audit project against RULES.md"),
    )`,
    prepareExpression: `(() => {
      const threadButton = [...document.querySelectorAll(".thread-main")].find(
        (button) => button.textContent?.includes("Audit project against RULES.md"),
      );
      threadButton?.click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const turnButton = document.querySelector(".turn-header-button");
        if (turnButton?.getAttribute("aria-expanded") !== "true") {
          turnButton?.click();
        }
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const groups = [...document.querySelectorAll(".agent-activity-summary")];
          const finalGroup = groups.at(-1);
          if (finalGroup?.closest("details")?.open !== true) {
            finalGroup?.click();
          }
          const timeline = document.querySelector(".timeline");
          if (timeline instanceof HTMLElement) {
            timeline.scrollTop = 0;
          }
        }));
      }));
    })()`,
    readyExpression: `document.querySelector(".turn-header-button")?.getAttribute("aria-expanded") === "true" &&
      document.querySelectorAll(".agent-activity-summary").length === 2 &&
      document.querySelectorAll(".agent-activity-group[open]").length === 1 &&
      [...document.querySelectorAll(".activity-title")].some(
        (element) => element.textContent?.trim() === "Terminal do chat lido",
      )`,
    auditExpression: chatReferenceVisualAuditExpression,
    validate: validateChatReferenceMetrics,
  },
  {
    id: "project-open-workspace",
    url: HOME_PREVIEW_URL,
    initialReadyExpression: `[...document.querySelectorAll(".project-group")].some(
      (project) => project.textContent?.includes("codex-app"),
    )`,
    prepareExpression: `(() => {
      const project = [...document.querySelectorAll(".project-group")].find(
        (entry) => entry.textContent?.includes("codex-app"),
      );
      project?.querySelector(".thread-menu-control > summary")?.click();
      requestAnimationFrame(() => {
        const openButton = [...(project?.querySelectorAll(".project-context-menu button") ?? [])].find(
          (button) => button.textContent?.includes("Abrir no Explorador de Arquivos"),
        );
        openButton?.click();
      });
    })()`,
    readyExpression: `typeof window.__previewOpenedWorkspace === "string" &&
      window.__previewOpenedWorkspace.length > 0`,
    auditExpression: projectOpenWorkspaceVisualAuditExpression,
    validate: validateProjectOpenWorkspaceMetrics,
  },
  {
    id: "project-color-editor",
    url: HOME_PREVIEW_URL,
    initialReadyExpression: `document.querySelector(".project-context-menu") !== null`,
    prepareExpression: `(() => {
      const editButton = [...document.querySelectorAll(".project-context-menu button")].find(
        (button) => button.textContent?.includes("Editar projeto"),
      );
      editButton?.click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const input = document.querySelector(".hex-text-input");
        if (!(input instanceof HTMLInputElement)) {
          return;
        }
        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        valueSetter?.call(input, "DE4B4E");
        input.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          composed: true,
          data: "DE4B4E",
          inputType: "insertText",
        }));
        window.__previewProjectColorUpdated = true;
      }));
    })()`,
    readyExpression: `(() => {
      const input = document.querySelector(".hex-text-input");
      const preview = document.querySelector(".project-icon-preview");
      if (
        window.__previewProjectColorUpdated !== true ||
        !(input instanceof HTMLInputElement) ||
        !(preview instanceof HTMLElement) ||
        !/^[0-9A-F]{6}$/.test(input.value) ||
        document.querySelector(".project-color-side-panel") === null ||
        document.querySelector(".inline-color-picker") === null
      ) {
        return false;
      }
      const expected = "rgb(" +
        Number.parseInt(input.value.slice(0, 2), 16) + ", " +
        Number.parseInt(input.value.slice(2, 4), 16) + ", " +
        Number.parseInt(input.value.slice(4, 6), 16) + ")";
      return getComputedStyle(preview).color === expected;
    })()`,
    auditExpression: projectColorEditorVisualAuditExpression,
    validate: validateProjectColorEditorMetrics,
  },
  {
    id: "settings",
    url: SETTINGS_PREVIEW_URL,
    readyExpression: `document.querySelector(".settings-dialog") !== null &&
      document.querySelector(".window-chrome-controls") !== null &&
      document.querySelector(".settings-scrollbar:not(.is-hidden)") !== null &&
      document.querySelectorAll(".application-preference").length === 3`,
    auditExpression: settingsVisualAuditExpression,
    validate: validateSettingsMetrics,
  },
  {
    id: "usage-settings",
    url: USAGE_SETTINGS_PREVIEW_URL,
    readyExpression: `document.querySelector(".usage-reset-row") !== null &&
      document.querySelector(".usage-auto-top-up-row") !== null &&
      document.querySelectorAll(".usage-meter-row").length >= 4`,
    auditExpression: usageSettingsVisualAuditExpression,
    validate: validateUsageSettingsMetrics,
  },
  {
    id: "usage-settings-interaction",
    url: USAGE_SETTINGS_PREVIEW_URL,
    initialReadyExpression: `document.querySelector(".usage-reset-button")?.textContent?.trim() === "Usar redefinição" &&
      document.querySelector(".usage-switch")?.getAttribute("aria-checked") === "false"`,
    prepareExpression: `(() => {
      const resetButton = document.querySelector(".usage-reset-button");
      resetButton?.click();
      requestAnimationFrame(() => {
        if (resetButton?.textContent?.trim() === "Confirmar") {
          resetButton.click();
        }
        document.querySelector(".usage-switch")?.click();
      });
    })()`,
    readyExpression: `document.querySelector(".usage-inline-success")?.textContent?.includes("Limites de uso redefinidos") === true &&
      document.querySelector(".usage-switch")?.getAttribute("aria-checked") === "true"`,
    auditExpression: usageSettingsInteractionVisualAuditExpression,
    validate: validateUsageSettingsInteractionMetrics,
  },
  {
    id: "settings-output-detail",
    url: SETTINGS_PREVIEW_URL,
    initialReadyExpression: `document.querySelector(".output-detail-trigger") !== null`,
    prepareExpression: `document.querySelector(".output-detail-trigger")?.click()`,
    readyExpression: `document.querySelector(".output-detail-menu") !== null`,
    auditExpression: outputDetailVisualAuditExpression,
    validate: validateOutputDetailMetrics,
  },
  {
    id: "settings-interaction",
    url: SETTINGS_INTERACTION_PREVIEW_URL,
    initialReadyExpression: `document.querySelectorAll(".application-preference input").length === 3`,
    prepareExpression: `(() => {
      const sections = document.querySelectorAll(".settings-section");
      window.__settingsModelTopBefore = sections[1]?.getBoundingClientRect().top ?? null;
      document.querySelectorAll(".application-preference input")[2]?.click();
    })()`,
    readyExpression: `document.querySelector('.visually-hidden[aria-live="polite"]')?.textContent?.includes("Salvando") === true`,
    auditExpression: settingsInteractionVisualAuditExpression,
    validate: validateSettingsInteractionMetrics,
  },
  {
    id: "profile",
    url: PROFILE_PREVIEW_URL,
    readyExpression: `document.querySelector(".profile-identity h1")?.textContent?.trim() === "ADA" &&
      document.querySelectorAll(".profile-summary-stat").length === 5 &&
      document.querySelectorAll(".profile-activity-cell").length === 364 &&
      document.querySelectorAll(".profile-insight-list > div").length === 5 &&
      document.querySelectorAll(".profile-invocation-list li").length === 1`,
    auditExpression: profileVisualAuditExpression,
    validate: validateProfileMetrics,
  },
  {
    id: "automations",
    url: AUTOMATIONS_PREVIEW_URL,
    readyExpression: `document.querySelector(".automations-view") !== null &&
      document.querySelector(".automation-card") !== null &&
      document.querySelector(".automation-run-row") !== null &&
      document.querySelector(".window-chrome-controls") !== null`,
    auditExpression: automationsVisualAuditExpression,
    validate: validateAutomationsMetrics,
  },
  {
    id: "automation-editor",
    url: AUTOMATIONS_PREVIEW_URL,
    readyExpression: `document.querySelector(".automation-editor") !== null`,
    prepareExpression: `document.querySelector(".automations-header .automation-primary-button")?.click()`,
    initialReadyExpression: `document.querySelector(".automations-view") !== null &&
      document.querySelector(".automations-header .automation-primary-button") !== null`,
    auditExpression: automationEditorVisualAuditExpression,
    validate: validateAutomationEditorMetrics,
  },
  {
    id: "browser-panel",
    url: BROWSER_PANEL_PREVIEW_URL,
    viewports: FILE_VIEWER_VIEWPORTS,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Estresse de timeline expandida"),
    )`,
    prepareExpression: `(() => {
      const threadButton = [...document.querySelectorAll(".thread-main")].find(
        (button) => button.textContent?.includes("Estresse de timeline expandida"),
      );
      threadButton?.click();
    })()`,
    readyExpression: `document.querySelector(".browser-panel") !== null &&
      document.querySelector(".browser-native-surface") !== null &&
      document.querySelector(".workspace-tab[data-kind='browser']") !== null`,
    auditExpression: browserPanelVisualAuditExpression,
    interact: exerciseWorkspaceSplitInteraction,
    validate: validateBrowserPanelMetrics,
  },
  {
    id: "browser-responsive-viewport",
    url: BROWSER_PANEL_PREVIEW_URL,
    viewports: FILE_VIEWER_VIEWPORTS,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Estresse de timeline expandida"),
    )`,
    prepareExpression: `(() => {
      void (async () => {
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Estresse de timeline expandida"),
        );
        threadButton?.click();
        for (let index = 0; index < 30; index += 1) {
          const toggle = document.querySelector('[aria-label="Alternar viewport responsivo"]');
          if (toggle instanceof HTMLButtonElement) {
            toggle.click();
            break;
          }
          await frame();
        }
        await frame();
        const preset = document.querySelector('select[aria-label="Resolução padrão"]');
        const scale = document.querySelector('select[aria-label="Escala do viewport"]');
        if (!(preset instanceof HTMLSelectElement) || !(scale instanceof HTMLSelectElement)) {
          throw new Error("Os controles responsivos não foram montados.");
        }
        preset.value = "7680x4320";
        preset.dispatchEvent(new Event("change", { bubbles: true }));
        scale.value = "0.25";
        scale.dispatchEvent(new Event("change", { bubbles: true }));
        await frame();
        await frame();
      })();
    })()`,
    readyExpression: `document.querySelector(".browser-responsive-toolbar") !== null &&
      document.querySelector('.browser-preview-page small')?.textContent?.includes("7680 × 4320 · 25%") === true`,
    auditExpression: browserResponsiveVisualAuditExpression,
    validate: validateBrowserResponsiveMetrics,
  },
  {
    id: "browser-debug-panel",
    url: BROWSER_DEBUG_PREVIEW_URL,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Estresse de timeline expandida"),
    )`,
    prepareExpression: `(() => {
      const threadButton = [...document.querySelectorAll(".thread-main")].find(
        (button) => button.textContent?.includes("Estresse de timeline expandida"),
      );
      threadButton?.click();
      const openDebug = () => {
        const button = document.querySelector('[aria-label="Alternar diagnóstico do navegador"]');
        if (button instanceof HTMLButtonElement) {
          button.click();
          return;
        }
        requestAnimationFrame(openDebug);
      };
      openDebug();
    })()`,
    readyExpression: `document.querySelector(".browser-debug-panel") !== null &&
      document.querySelectorAll(".browser-debug-row").length >= 3`,
    auditExpression: browserDebugVisualAuditExpression,
    validate: validateBrowserDebugMetrics,
  },
  {
    id: "browser-panel-lifecycle",
    url: BROWSER_PANEL_PREVIEW_URL,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Estresse de timeline expandida"),
    )`,
    prepareExpression: `(() => {
      void (async () => {
        try {
          const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
          const threadButton = [...document.querySelectorAll(".thread-main")].find(
            (button) => button.textContent?.includes("Estresse de timeline expandida"),
          );
          threadButton?.click();
          let closeButton;
          for (let index = 0; index < 30; index += 1) {
            await frame();
            closeButton = document.querySelector('[aria-label="Fechar área de trabalho"]');
            if (closeButton !== null) break;
          }
          if (!(closeButton instanceof HTMLButtonElement)) {
            throw new Error("O navegador não abriu para validar sua desmontagem.");
          }
          closeButton.click();
          await frame();
          await frame();
        } catch (error) {
          window.__previewBrowserPanelLifecycleError =
            error instanceof Error ? error.stack ?? error.message : String(error);
        }
        window.__previewBrowserPanelClosed = true;
      })();
    })()`,
    readyExpression: `window.__previewBrowserPanelClosed === true &&
      document.querySelector(".browser-panel") === null`,
    auditExpression: browserPanelLifecycleVisualAuditExpression,
    validate: validateBrowserPanelLifecycleMetrics,
  },
  {
    id: "image-view-group",
    url: HOME_PREVIEW_URL,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Inspecionar janela de contexto"),
    )`,
    prepareExpression: imageViewGroupPrepareExpression(),
    readyExpression: `window.__previewImageViewReady === true`,
    auditExpression: imageViewGroupVisualAuditExpression,
    validate: validateImageViewGroupMetrics,
  },
  {
    id: "activity-shimmer-cadence",
    url: HOME_PREVIEW_URL,
    readyTimeoutMs: 15_000,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Inspecionar janela de contexto"),
    )`,
    prepareExpression: activityShimmerPrepareExpression(),
    readyExpression: `window.__activityShimmerReady === true`,
    auditExpression: activityShimmerAuditExpression,
    validate: validateActivityShimmerMetrics,
  },
  {
    id: "activity-reconciliation-stream",
    url: ACTIVITY_RECONCILIATION_PREVIEW_URL,
    readyTimeoutMs: 15_000,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Reconciliação de comandos paralelos"),
    )`,
    prepareExpression: activityReconciliationPrepareExpression(),
    readyExpression: `window.__activityReconciliationReady === true`,
    auditExpression: activityReconciliationAuditExpression,
    validate: validateActivityReconciliationMetrics,
  },
  {
    id: "timeline-performance-stress",
    url: TIMELINE_STRESS_PREVIEW_URL,
    readyTimeoutMs: 30_000,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Estresse de timeline expandida"),
    )`,
    prepareExpression: timelinePerformanceStressPrepareExpression(),
    readyExpression: `window.__timelinePerformanceStressReady === true`,
    auditExpression: timelinePerformanceStressAuditExpression,
    validate: validateTimelinePerformanceStressMetrics,
  },
  {
    id: "timeline-files-100k",
    url: TIMELINE_EXTREME_PREVIEW_URL,
    readyTimeoutMs: 30_000,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Estresse de 100000 arquivos"),
    )`,
    prepareExpression: timelineExtremeFilesPrepareExpression(),
    readyExpression: `window.__timelineExtremeFilesReady === true`,
    auditExpression: timelineExtremeFilesAuditExpression,
    validate: validateTimelineExtremeFilesMetrics,
  },
];

async function main() {
  const browserPath = resolveBrowserPath();
  const browserProfile = await mkdtemp(path.join(os.tmpdir(), "codex-app-visual-"));
  const debugPort = await reservePort();
  // Browser fixtures are guarded by import.meta.env.DEV; the production build is validated
  // separately, while this server keeps those deterministic fixtures available to the audit.
  const server = spawn(
    process.execPath,
    [
      VITE_ENTRY,
      "--host",
      "127.0.0.1",
      "--mode",
      "production",
      "--port",
      String(PREVIEW_PORT),
      "--strictPort",
    ],
    {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  const serverOutput = captureOutput(server);
  let browser;
  let browserController;

  try {
    await waitForHttp(SETTINGS_PREVIEW_URL, server, serverOutput);
    browser = spawn(
      browserPath,
      [
        "--headless=new",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-breakpad",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-features=Translate",
        "--disable-renderer-backgrounding",
        "--disable-sync",
        "--hide-scrollbars",
        "--metrics-recording-only",
        "--no-first-run",
        `--remote-debugging-port=${debugPort}`,
        `--user-data-dir=${browserProfile}`,
        "about:blank",
      ],
      {
        cwd: PROJECT_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const browserOutput = captureOutput(browser);
    const versionUrl = `http://127.0.0.1:${debugPort}/json/version`;
    await waitForHttp(versionUrl, browser, browserOutput, { allowExited: true });
    const browserVersion = await fetchJson(versionUrl);
    browserController = await CdpClient.connect(browserVersion.webSocketDebuggerUrl);
    await mkdir(ARTIFACT_DIRECTORY, { recursive: true });

    const reports = [];
    const scenarios =
      REQUESTED_SCENARIOS.size === 0
        ? SCENARIOS
        : SCENARIOS.filter((scenario) => REQUESTED_SCENARIOS.has(scenario.id));
    if (scenarios.length !== (REQUESTED_SCENARIOS.size || SCENARIOS.length)) {
      const knownScenarios = new Set(SCENARIOS.map((scenario) => scenario.id));
      const unknownScenarios = [...REQUESTED_SCENARIOS].filter(
        (scenarioId) => !knownScenarios.has(scenarioId),
      );
      throw new Error(`Cenários visuais desconhecidos: ${unknownScenarios.join(", ")}`);
    }
    for (const scenario of scenarios) {
      for (const viewport of scenario.viewports ?? VIEWPORTS) {
        reports.push(await auditViewport(debugPort, viewport, scenario));
      }
    }

    process.stdout.write(`${JSON.stringify({ browserPath, reports }, null, 2)}\n`);
  } finally {
    if (browserController !== undefined) {
      await Promise.race([
        browserController.send("Browser.close").catch(() => undefined),
        delay(1_000),
      ]);
      browserController.close();
      await delay(250);
    }
    await terminate(browser, { processTree: true });
    await terminate(server);
    await rm(browserProfile, {
      force: true,
      maxRetries: 10,
      recursive: true,
      retryDelay: 200,
    }).catch(() => undefined);
  }
}

async function auditViewport(debugPort, viewport, scenario) {
  const target = await fetchJson(
    `http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT" },
  );
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Storage.clearDataForOrigin", {
      origin: new URL(scenario.url).origin,
      storageTypes: "all",
    });
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
    });
    const loaded = client.waitForEvent("Page.loadEventFired");
    await client.send("Page.navigate", { url: scenario.url });
    await loaded;
    await waitForPreview(
      client,
      scenario.initialReadyExpression ?? scenario.readyExpression,
      scenario.id,
    );
    if (scenario.prepareExpression !== undefined) {
      await client.evaluate(scenario.prepareExpression, false);
      await waitForPreview(
        client,
        scenario.readyExpression,
        scenario.id,
        scenario.readyTimeoutMs,
      );
    }
    if (scenario.interact !== undefined) {
      await scenario.interact(client);
    }
    await client.evaluate(
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(async () => {
        await document.fonts.ready;
        resolve(true);
      })))`,
      true,
    );

    const metrics = await client.evaluate(scenario.auditExpression(), false);
    try {
      scenario.validate(metrics, viewport);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cenário ${scenario.id} inválido em ${viewport.width}x${viewport.height}: ${reason}. Métricas: ${JSON.stringify(metrics)}`,
        { cause: error },
      );
    }
    const screenshot = await client.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
    });
    const screenshotPath = path.join(
      ARTIFACT_DIRECTORY,
      `${scenario.id}-${viewport.width}x${viewport.height}.png`,
    );
    await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
    return { scenario: scenario.id, viewport, screenshotPath, metrics };
  } finally {
    client.close();
    await fetch(
      `http://127.0.0.1:${debugPort}/json/close/${encodeURIComponent(target.id)}`,
    ).catch(() => undefined);
  }
}

async function waitForPreview(client, readyExpression, scenarioId, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ready = await client.evaluate(
      `document.readyState === "complete" && (${readyExpression})`,
      false,
    );
    if (ready === true) {
      return;
    }
    await delay(50);
  }
  const diagnostics = await client
    .evaluate(
      `({
        title: document.title,
        body: document.body?.innerText?.slice(0, 4000) ?? "",
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        timelineStressProgress: window.__timelineStressProgress ?? null,
        failures: [...document.querySelectorAll(
          ".bootstrap-failure, .render-failure, .frontend-failure, [role='alert']",
        )].map((element) => element.textContent?.trim() ?? ""),
      })`,
      false,
    )
    .catch(() => null);
  throw new Error(
    `A prévia visual de ${scenarioId} não ficou pronta dentro de ${timeoutMs / 1000} segundos.\n` +
      `Diagnóstico: ${JSON.stringify(diagnostics)}`,
  );
}

function browserPanelVisualAuditExpression() {
  return `(() => {
    const workspace = document.querySelector(".workspace-panel");
    const panel = document.querySelector(".browser-panel");
    const tabs = document.querySelector(".workspace-tab-bar");
    const toolbar = document.querySelector(".browser-toolbar");
    const address = document.querySelector(".browser-address");
    const surface = document.querySelector(".browser-native-surface");
    if (
      !(workspace instanceof HTMLElement) ||
      !(panel instanceof HTMLElement) ||
      !(tabs instanceof HTMLElement) ||
      !(toolbar instanceof HTMLElement) ||
      !(address instanceof HTMLElement) ||
      !(surface instanceof HTMLElement)
    ) {
      throw new Error("A superfície do navegador interno está incompleta.");
    }
    const rectangle = (element) => {
      const bounds = element.getBoundingClientRect();
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
      };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      workspaceSplit: ${workspaceSplitVisualStateExpression()},
      workspaceSplitInteraction: window.__previewWorkspaceSplitInteraction ?? null,
      workspace: rectangle(workspace),
      panel: rectangle(panel),
      tabs: rectangle(tabs),
      toolbar: rectangle(toolbar),
      address: rectangle(address),
      surface: rectangle(surface),
      tabCount: workspace.querySelectorAll('[role="tab"]').length,
      selectedTabs: workspace.querySelectorAll('[role="tab"][aria-selected="true"]').length,
      navigationButtons: panel.querySelectorAll(".browser-toolbar > .browser-toolbar-button").length,
      addressInputs: panel.querySelectorAll('.browser-address input[aria-label="Pesquisar ou digitar endereço"]').length,
      previewPages: panel.querySelectorAll(".browser-preview-page").length,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`;
}

function workspaceSplitVisualStateExpression() {
  return `(() => {
    const container = document.querySelector(".main-panel-content");
    const chat = container?.querySelector(":scope > .chat-page");
    const splitter = container?.querySelector(":scope > .workspace-splitter");
    const workspace = container?.querySelector(":scope > .workspace-panel");
    if (
      !(container instanceof HTMLElement) ||
      !(chat instanceof HTMLElement) ||
      !(splitter instanceof HTMLElement) ||
      !(workspace instanceof HTMLElement)
    ) {
      throw new Error("A divisão entre chat e área de trabalho está incompleta.");
    }
    const rectangle = (element) => {
      const bounds = element.getBoundingClientRect();
      return {
        bottom: bounds.bottom,
        height: bounds.height,
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        width: bounds.width,
      };
    };
    const chatBounds = rectangle(chat);
    const workspaceBounds = rectangle(workspace);
    const splitterBounds = rectangle(splitter);
    const paneWidth = chatBounds.width + workspaceBounds.width;
    return {
      ariaMaximum: Number(splitter.getAttribute("aria-valuemax")),
      ariaMinimum: Number(splitter.getAttribute("aria-valuemin")),
      ariaNow: Number(splitter.getAttribute("aria-valuenow")),
      ariaOrientation: splitter.getAttribute("aria-orientation"),
      ariaText: splitter.getAttribute("aria-valuetext"),
      chat: chatBounds,
      chatDisplay: getComputedStyle(chat).display,
      chatHidden: chat.hidden,
      container: rectangle(container),
      paneRatio: paneWidth === 0 ? null : chatBounds.width / paneWidth,
      persistedRatio: localStorage.getItem("codex-desktop.profile-v2.workspace-split-ratio"),
      role: splitter.getAttribute("role") ?? (splitter.tagName === "HR" ? "separator" : null),
      splitter: splitterBounds,
      splitterDisplay: getComputedStyle(splitter).display,
      workspace: workspaceBounds,
    };
  })()`;
}

function browserResponsiveVisualAuditExpression() {
  return `(() => {
    const workspace = document.querySelector(".workspace-panel");
    const toolbar = document.querySelector(".browser-responsive-toolbar");
    const surface = document.querySelector(".browser-native-surface");
    const width = document.querySelector('input[aria-label="Largura do viewport"]');
    const height = document.querySelector('input[aria-label="Altura do viewport"]');
    const scale = document.querySelector('select[aria-label="Escala do viewport"]');
    const reset = document.querySelector('[aria-label="Redefinir viewport responsivo"]');
    if (
      !(workspace instanceof HTMLElement) ||
      !(toolbar instanceof HTMLElement) ||
      !(surface instanceof HTMLElement) ||
      !(width instanceof HTMLInputElement) ||
      !(height instanceof HTMLInputElement) ||
      !(scale instanceof HTMLSelectElement) ||
      !(reset instanceof HTMLButtonElement)
    ) {
      throw new Error("O viewport responsivo está incompleto.");
    }
    const rectangle = (element) => {
      const bounds = element.getBoundingClientRect();
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
      };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      workspace: rectangle(workspace),
      toolbar: rectangle(toolbar),
      surface: rectangle(surface),
      width: width.value,
      height: height.value,
      scale: scale.value,
      preview: document.querySelector(".browser-preview-page small")?.textContent?.trim() ?? null,
      selectedTabs: workspace.querySelectorAll('[role="tab"][aria-selected="true"]').length,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      toolbarOverflow: toolbar.scrollWidth - toolbar.clientWidth,
      resetLabel: reset.getAttribute("aria-label"),
    };
  })()`;
}

function browserDebugVisualAuditExpression() {
  return `(() => {
    const panel = document.querySelector(".browser-panel");
    const debug = document.querySelector(".browser-debug-panel");
    const surface = document.querySelector(".browser-native-surface");
    if (
      !(panel instanceof HTMLElement) ||
      !(debug instanceof HTMLElement) ||
      !(surface instanceof HTMLElement)
    ) {
      throw new Error("O diagnóstico do navegador está incompleto.");
    }
    const rectangle = (element) => {
      const bounds = element.getBoundingClientRect();
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
      };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight },
      panel: rectangle(panel),
      debug: rectangle(debug),
      surface: rectangle(surface),
      summaryCards: debug.querySelectorAll(".browser-debug-summary > div").length,
      historyRows: debug.querySelectorAll(".browser-debug-row").length,
      failedRows: debug.querySelectorAll('.browser-debug-row[data-status="failed"]').length,
      stageBadges: debug.querySelectorAll(".browser-debug-stages span").length,
      findingBadges: debug.querySelectorAll(".browser-debug-findings span").length,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      debugHorizontalOverflow: debug.scrollWidth - debug.clientWidth,
    };
  })()`;
}

function browserPanelLifecycleVisualAuditExpression() {
  return `(() => {
    if (window.__previewBrowserPanelLifecycleError !== undefined) {
      throw new Error(window.__previewBrowserPanelLifecycleError);
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      panelCount: document.querySelectorAll(".browser-panel").length,
      failureCount: document.querySelectorAll(
        ".bootstrap-failure, .render-failure, .frontend-failure, [role='alert']",
      ).length,
      chatVisible: document.querySelector(".chat-page:not([hidden])") !== null,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`;
}

function imageViewGroupPrepareExpression() {
  return `(() => {
    void (async () => {
      try {
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Inspecionar janela de contexto"),
        );
        threadButton?.click();
        let group;
        for (let index = 0; index < 20; index += 1) {
          await frame();
          document.querySelectorAll('button[aria-label="Mostrar trabalho do agente"]').forEach(
            (button) => button.click(),
          );
          const timeline = document.querySelector(".timeline");
          if (timeline instanceof HTMLElement) {
            timeline.scrollTop = timeline.scrollHeight - timeline.clientHeight;
          }
          group = document.querySelector(".image-view-group");
          if (group instanceof HTMLDetailsElement) {
            break;
          }
        }
        if (!(group instanceof HTMLDetailsElement)) {
          throw new Error("O agrupamento de imagens não foi montado.");
        }
        group.scrollIntoView({ block: "center" });
        if (!group.open) {
          group.querySelector(":scope > summary")?.click();
        }
        for (let index = 0; index < 20; index += 1) {
          await frame();
          if (group.querySelectorAll(".tool-image-preview img").length === 2) {
            return;
          }
        }
        throw new Error("As duas miniaturas não ficaram prontas.");
      } catch (error) {
        window.__previewImageViewError =
          error instanceof Error ? error.stack ?? error.message : String(error);
      } finally {
        window.__previewImageViewReady = true;
      }
    })();
  })()`;
}

function previewFileDetailPrepareExpression(fileName) {
  return `(() => {
    void (async () => {
      try {
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Inspecionar janela de contexto"),
        );
        threadButton?.click();
        await frame();
        const timeline = document.querySelector(".timeline");
        if (!(timeline instanceof HTMLElement)) {
          throw new Error("A timeline não foi montada.");
        }
        const marker = document.querySelectorAll(".user-message-navigator button")[1];
        if (!(marker instanceof HTMLButtonElement)) {
          throw new Error("O marcador da mensagem anterior ao arquivo criado está ausente.");
        }
        marker.click();
        await frame();
        await frame();
        await frame();
        // Stay below the production high-velocity deferral threshold so each
        // interval is materialized exactly as it is during deliberate reading.
        const step = 140;
        let discoveredActivityGroups = 0;
        let discoveredTurnHeaders = 0;
        let openedActivityGroups = 0;
        let openedTurnHeaders = 0;
        let largestScrollHeight = timeline.scrollHeight;
        const discoveredActivityTitles = new Set();
        const discoveredFileNames = new Set();
        for (let index = 0; index < 500; index += 1) {
          await frame();
          let disclosureOpened = false;
          const turnHeaders = document.querySelectorAll(".turn-header-button");
          discoveredTurnHeaders = Math.max(discoveredTurnHeaders, turnHeaders.length);
          turnHeaders.forEach((button) => {
            if (button.getAttribute("aria-expanded") === "false") {
              openedTurnHeaders += 1;
              button.click();
              disclosureOpened = true;
            }
          });
          const activityGroups = document.querySelectorAll(".agent-activity-group");
          discoveredActivityGroups = Math.max(discoveredActivityGroups, activityGroups.length);
          activityGroups.forEach((group) => {
            if (group instanceof HTMLDetailsElement && !group.open) {
              openedActivityGroups += 1;
              group.querySelector(":scope > summary")?.click();
              disclosureOpened = true;
            }
          });
          document.querySelectorAll(".file-change-card:not([open]) > summary").forEach(
            (summary) => {
              summary.click();
              disclosureOpened = true;
            },
          );
          if (disclosureOpened) {
            await new Promise((resolve) => setTimeout(resolve, 120));
          }
          await frame();
          largestScrollHeight = Math.max(largestScrollHeight, timeline.scrollHeight);
          document.querySelectorAll(".activity-title").forEach((element) => {
            const title = element.textContent?.trim();
            if (title) discoveredActivityTitles.add(title);
          });
          document.querySelectorAll(".diff-file-identity code").forEach((element) => {
            const fileName = element.textContent?.trim();
            if (fileName) discoveredFileNames.add(fileName);
          });
          const file = [...document.querySelectorAll(".file-change-diff .diff-file-identity code")].find(
            (element) => element.textContent?.trim() === ${JSON.stringify(fileName)},
          );
          const block = file?.closest(".file-change-diff");
          if (block instanceof HTMLDetailsElement) {
            if (!block.open) {
              block.querySelector(":scope > summary")?.click();
            }
            await new Promise((resolve) => setTimeout(resolve, 120));
            await frame();
            await frame();
            const currentFile = [...document.querySelectorAll(
              ".file-change-diff .diff-file-identity code",
            )].find(
              (element) => element.textContent?.trim() === ${JSON.stringify(fileName)},
            );
            const currentBlock = currentFile?.closest(".file-change-diff");
            const diffViewport = currentBlock?.querySelector(".diff-viewport");
            const code = diffViewport?.querySelector(
              ".unified-diff-row.is-addition .unified-diff-code",
            );
            if (
              !(currentBlock instanceof HTMLDetailsElement) ||
              !(diffViewport instanceof HTMLElement) ||
              !(code instanceof HTMLElement)
            ) {
              throw new Error("O diff criado não materializou suas linhas visíveis.");
            }
            const tokens = [...diffViewport.querySelectorAll(".syntax-token")];
            const rows = [...diffViewport.querySelectorAll(".unified-diff-row")];
            window.__previewCreatedFileMetrics = {
              tokenKinds: [
                ...new Set(
                  tokens.flatMap((token) =>
                    [...token.classList].filter((className) => className.startsWith("token-")),
                  ),
                ),
              ].sort(),
              tokenColorCount: new Set(tokens.map((token) => getComputedStyle(token).color)).size,
              tokenCount: tokens.length,
              additionRows: diffViewport.querySelectorAll(".unified-diff-row.is-addition").length,
              deletionRows: diffViewport.querySelectorAll(".unified-diff-row.is-deletion").length,
              newlineMetadataRows: [...diffViewport.querySelectorAll(".unified-diff-hunk")].filter(
                (element) => element.textContent?.includes("No newline at end of file"),
              ).length,
              structuralMetadataRows: diffViewport.querySelectorAll(
                ".unified-diff-row.is-hunk, .unified-diff-row.is-meta, .unified-diff-hunk, .split-diff-hunk",
              ).length,
              containsStructuralMetadata: [
                "@@ ",
                "diff --git ",
                "No newline at end of file",
              ].some((marker) => (diffViewport.textContent ?? "").includes(marker)),
              codeInset: code.getBoundingClientRect().left - diffViewport.getBoundingClientRect().left,
              lineNumberCellsPerRow: rows.map(
                (row) => row.querySelectorAll(":scope > .diff-line-number").length,
              ),
              markerCellCount: diffViewport.querySelectorAll(".diff-line-prefix").length,
              horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
            };
            return;
          }
          const maximumScroll = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
          if (timeline.scrollTop >= maximumScroll - 1) {
            break;
          }
          timeline.scrollTop = Math.min(maximumScroll, timeline.scrollTop + step);
        }
        throw new Error(
          "O arquivo " +
            ${JSON.stringify(fileName)} +
            " não foi encontrado na timeline (scrollTop=" +
            timeline.scrollTop +
            ", scrollHeight=" +
            timeline.scrollHeight +
            ", turnHeaders=" +
            document.querySelectorAll(".turn-header-button").length +
            ", openTurnHeaders=" +
            document.querySelectorAll('.turn-header-button[aria-expanded="true"]').length +
            ", activityGroups=" +
            document.querySelectorAll(".agent-activity-group").length +
            ", discoveredTurnHeaders=" +
            discoveredTurnHeaders +
            ", openedTurnHeaders=" +
            openedTurnHeaders +
            ", discoveredActivityGroups=" +
            discoveredActivityGroups +
            ", openedActivityGroups=" +
            openedActivityGroups +
            ", largestScrollHeight=" +
            largestScrollHeight +
            ", markerCurrent=" +
            marker.getAttribute("aria-current") +
            ", activityTitles=" +
            JSON.stringify([...discoveredActivityTitles]) +
            ", fileNames=" +
            JSON.stringify([...discoveredFileNames]) +
            ").",
        );
      } catch (error) {
        window.__previewCreatedFileError =
          error instanceof Error ? error.stack ?? error.message : String(error);
      }
    })();
  })()`;
}

function previewHighlightedToolOutputsPrepareExpression() {
  return `(() => {
    void (async () => {
      const csp = document.createElement("meta");
      csp.httpEquiv = "Content-Security-Policy";
      csp.content = "style-src 'self'";
      document.head.append(csp);
      const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
      const threadButton = [...document.querySelectorAll(".thread-main")].find(
        (button) => button.textContent?.includes("Inspecionar janela de contexto"),
      );
      threadButton?.click();
      let positionedAtEnd = false;
      for (let index = 0; index < 32; index += 1) {
        await frame();
        document.querySelectorAll('button[aria-label="Mostrar trabalho do agente"]').forEach(
          (button) => button.click(),
        );
        const timeline = document.querySelector(".timeline");
        if (timeline instanceof HTMLElement && !positionedAtEnd) {
          timeline.scrollTop = timeline.scrollHeight - timeline.clientHeight;
          positionedAtEnd = true;
        }
        document.querySelectorAll(".agent-activity-group:not([open]) > summary").forEach(
          (summary) => summary.click(),
        );
        const sourceCard = [...document.querySelectorAll(".tool-activity-card")].find(
          (element) => element.textContent?.includes("diffHighlighter.test.ts"),
        );
        const searchCard = [...document.querySelectorAll(".tool-activity-card")].find(
          (element) => element.textContent?.includes("Search syntax highlighter usage"),
        );
        if (
          sourceCard instanceof HTMLDetailsElement &&
          searchCard instanceof HTMLDetailsElement
        ) {
          for (const card of [sourceCard, searchCard]) {
            if (!card.open) {
              card.querySelector(":scope > summary")?.click();
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 120));
          const measureSourceVirtualization = () => {
            const currentSource = sourceCard.querySelector(".tool-source-output");
            const currentCanvas = currentSource?.querySelector(".tool-source-virtual-canvas");
            const currentViewport = currentSource?.closest(".tool-source-viewport");
            if (
              !(currentSource instanceof HTMLElement) ||
              !(currentCanvas instanceof HTMLElement) ||
              !(currentViewport instanceof HTMLElement)
            ) {
              throw new Error("A leitura virtual não está materializada.");
            }
            const currentRows = [...currentSource.querySelectorAll(".tool-source-line")];
            const viewportBounds = currentViewport.getBoundingClientRect();
            const rowTopOffsets = currentRows.map(
              (row) => row.getBoundingClientRect().top - viewportBounds.top,
            );
            return {
              canvasHeight: currentCanvas.getBoundingClientRect().height,
              clientHeight: currentViewport.clientHeight,
              lineNumbers: currentRows.map(
                (row) => row.querySelector(".tool-source-line-number")?.textContent?.trim() ?? "",
              ),
              mountedRowIndexes: currentRows.map((row) =>
                Number.parseInt(row.getAttribute("aria-rowindex") ?? "0", 10),
              ),
              rowGaps: rowTopOffsets.slice(1).map(
                (top, rowIndex) => top - (rowTopOffsets[rowIndex] ?? top),
              ),
              rowInlineTops: currentRows.map((row) =>
                row instanceof HTMLElement ? row.style.top : null,
              ),
              scrollHeight: currentViewport.scrollHeight,
              scrollTop: currentViewport.scrollTop,
            };
          };
          const firstOpen = measureSourceVirtualization();
          const sourceSummary = sourceCard.querySelector(":scope > summary");
          sourceSummary?.click();
          await frame();
          await frame();
          sourceSummary?.click();
          await new Promise((resolve) => setTimeout(resolve, 120));
          await frame();
          await frame();
          const reopened = measureSourceVirtualization();
          const sourceViewport = sourceCard.querySelector(".tool-source-viewport");
          if (!(sourceViewport instanceof HTMLElement)) {
            throw new Error("A viewport reaberta da leitura está ausente.");
          }
          sourceViewport.scrollTop = sourceViewport.scrollHeight;
          await frame();
          await frame();
          await frame();
          const bottom = measureSourceVirtualization();
          sourceViewport.scrollTop = 0;
          await frame();
          await frame();
          await frame();
          const restored = measureSourceVirtualization();
          const source = sourceCard.querySelector(".tool-source-output");
          const search = searchCard.querySelector(".tool-search-output");
          const sourceCanvas = source?.querySelector(".tool-source-virtual-canvas");
          if (
            source instanceof HTMLElement &&
            search instanceof HTMLElement &&
            sourceCanvas instanceof HTMLElement &&
            sourceViewport instanceof HTMLElement
          ) {
            const sourceTokens = [...source.querySelectorAll(".syntax-token")];
            const searchTokens = [...search.querySelectorAll(".syntax-token")];
            const sourceRows = [...source.querySelectorAll(".tool-source-line")];
            const sourceViewportBounds = sourceViewport.getBoundingClientRect();
            const sourceRowTopOffsets = sourceRows.map(
              (row) => row.getBoundingClientRect().top - sourceViewportBounds.top,
            );
            const sourceInlineOverlapCount = sourceRows.reduce((total, row) => {
              const code = row.querySelector("code");
              if (!(code instanceof HTMLElement)) {
                return total + 1;
              }
              const fragments = [...code.childNodes]
                .map((node) => {
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  const bounds = range.getBoundingClientRect();
                  return { left: bounds.left, right: bounds.right, top: bounds.top, width: bounds.width };
                })
                .filter((bounds) => bounds.width > 0);
              return (
                total +
                fragments.slice(1).filter((fragment, index) => {
                  const previous = fragments[index];
                  return (
                    previous === undefined ||
                    fragment.left < previous.right - 0.5 ||
                    Math.abs(fragment.top - previous.top) > 1
                  );
                }).length
              );
            }, 0);
            const readIcon = sourceSummary?.querySelector(".activity-icon svg");
            const readChevron = sourceSummary?.querySelector(".activity-chevron");
            const readChevronIcon = readChevron?.querySelector("svg");
            const readIconBounds = readIcon?.getBoundingClientRect();
            const readChevronBounds = readChevronIcon?.getBoundingClientRect();
            window.__previewHighlightedToolMetrics = {
              readIconPaths: [
                ...(sourceSummary?.querySelectorAll(".activity-icon svg path") ?? []),
              ].map((path) => path.getAttribute("d")),
              readIconFill: readIcon?.getAttribute("fill") ?? null,
              readIconRtlFlip: readIcon?.hasAttribute("data-rtl-flip") ?? false,
              readIconSize:
                readIconBounds === undefined
                  ? null
                  : { height: readIconBounds.height, width: readIconBounds.width },
              readIconStroke: readIcon?.getAttribute("stroke") ?? null,
              readIconStrokeWidth: readIcon?.getAttribute("stroke-width") ?? null,
              readIconViewBox: readIcon?.getAttribute("viewBox") ?? null,
              readChevronOpacity:
                readChevron === null || readChevron === undefined
                  ? null
                  : Number.parseFloat(getComputedStyle(readChevron).opacity),
              readChevronPath:
                readChevronIcon?.querySelector("path")?.getAttribute("d") ?? null,
              readChevronSize:
                readChevronBounds === undefined
                  ? null
                  : { height: readChevronBounds.height, width: readChevronBounds.width },
              readChevronTransform:
                readChevronIcon === null || readChevronIcon === undefined
                  ? null
                  : getComputedStyle(readChevronIcon).transform,
              readTitle:
                sourceSummary?.querySelector(".activity-title-base")?.textContent?.trim() ?? null,
              sourceLineNumbers: [...source.querySelectorAll(".tool-source-line-number")].map(
                (element) => element.textContent?.trim() ?? "",
              ),
              sourceTableRole: source.getAttribute("role"),
              sourceRowGroupRole: sourceCanvas.getAttribute("role"),
              sourceRowRoles: sourceRows.map((row) => row.getAttribute("role")),
              sourceCellRoles: sourceRows.map((row) =>
                [...row.children].map((cell) => cell.getAttribute("role")),
              ),
              sourceMountedRowIndexes: sourceRows.map((row) =>
                Number.parseInt(row.getAttribute("aria-rowindex") ?? "0", 10),
              ),
              sourceRowGaps: sourceRowTopOffsets.slice(1).map(
                (top, index) => top - (sourceRowTopOffsets[index] ?? top),
              ),
              sourceInlineOverlapCount,
              sourceCanvasHeight: sourceCanvas.getBoundingClientRect().height,
              sourceViewportClientHeight: sourceViewport.clientHeight,
              sourceViewportScrollHeight: sourceViewport.scrollHeight,
              sourceVirtualizationCycle: { firstOpen, reopened, bottom, restored },
              sourceTokenKinds: [
                ...new Set(
                  sourceTokens.flatMap((token) =>
                    [...token.classList].filter((className) => className.startsWith("token-")),
                  ),
                ),
              ].sort(),
              searchTokenKinds: [
                ...new Set(
                  searchTokens.flatMap((token) =>
                    [...token.classList].filter((className) => className.startsWith("token-")),
                  ),
                ),
              ].sort(),
              sourceText: source.textContent ?? "",
              searchText: search.textContent ?? "",
              sourceHorizontalOverflow: source.scrollWidth - source.clientWidth,
              searchHorizontalOverflow: search.scrollWidth - search.clientWidth,
              horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
            };
            return;
          }
        }
        if (timeline instanceof HTMLElement) {
          timeline.scrollTop = Math.max(0, timeline.scrollTop - 140);
        }
      }
    })();
  })()`;
}

function composerPopoverLayeringPrepareExpression() {
  return `(() => {
    void (async () => {
      try {
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const waitUntil = async (label, predicate, timeoutMs = 4000) => {
          const deadline = performance.now() + timeoutMs;
          while (!predicate()) {
            if (performance.now() >= deadline) {
              throw new Error("Tempo excedido aguardando " + label + ".");
            }
            await frame();
          }
        };
        const rectangle = (element) => {
          const bounds = element.getBoundingClientRect();
          return {
            top: bounds.top,
            right: bounds.right,
            bottom: bounds.bottom,
            left: bounds.left,
            width: bounds.width,
            height: bounds.height,
          };
        };
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Estresse de timeline expandida"),
        );
        threadButton?.click();
        await waitUntil(
          "o compositor e o resumo das alterações",
          () =>
            document.querySelector(".composer-wrap") !== null &&
            document.querySelector(".plan-progress-pill") !== null &&
            document.querySelector(".permission-button") !== null,
        );
        await waitUntil(
          "a timeline de estresse",
          () =>
            document.querySelector(".command-activity-card") !== null ||
            document.querySelector(".agent-activity-group") !== null ||
            document.querySelector('button[aria-label="Mostrar trabalho do agente"]') !== null,
        );
        document.querySelectorAll('button[aria-label="Mostrar trabalho do agente"]').forEach(
          (button) => button.click(),
        );
        document.querySelectorAll(".agent-activity-group:not([open]) > summary").forEach(
          (summary) => summary.click(),
        );
        await waitUntil(
          "uma linha de comando materializada",
          () =>
            document.querySelector(
              ".command-activity-card > summary .activity-icon svg",
            ) !== null,
        );

        const measureMenu = async (name, triggerSelector, menuSelector) => {
          const trigger = document.querySelector(triggerSelector);
          if (!(trigger instanceof HTMLButtonElement)) {
            throw new Error("Controle ausente para o menu " + name + ".");
          }
          trigger.click();
          await frame();
          await frame();
          const menu = document.querySelector(menuSelector);
          const status = document.querySelector(".plan-progress-pill");
          if (!(menu instanceof HTMLElement) || !(status instanceof HTMLElement)) {
            throw new Error("Superfícies ausentes ao medir o menu " + name + ".");
          }
          const menuBounds = rectangle(menu);
          const statusBounds = rectangle(status);
          const intersection = {
            top: Math.max(menuBounds.top, statusBounds.top),
            right: Math.min(menuBounds.right, statusBounds.right),
            bottom: Math.min(menuBounds.bottom, statusBounds.bottom),
            left: Math.max(menuBounds.left, statusBounds.left),
          };
          const overlapWidth = Math.max(0, intersection.right - intersection.left);
          const overlapHeight = Math.max(0, intersection.bottom - intersection.top);
          const samplePoints =
            overlapWidth === 0 || overlapHeight === 0
              ? []
              : [
                  [0.15, 0.2],
                  [0.5, 0.2],
                  [0.85, 0.2],
                  [0.15, 0.8],
                  [0.5, 0.8],
                  [0.85, 0.8],
                ].map(([horizontal, vertical]) => ({
                  x: intersection.left + overlapWidth * horizontal,
                  y: intersection.top + overlapHeight * vertical,
                }));
          return {
            name,
            menuBounds,
            statusBounds,
            overlapHeight,
            overlapWidth,
            paintedInFront: samplePoints.map(({ x, y }) => {
              const paintedElement = document.elementFromPoint(x, y);
              return paintedElement !== null && menu.contains(paintedElement);
            }),
          };
        };

        const menus = [];
        menus.push(await measureMenu("add", ".add-button", ".add-menu"));
        menus.push(
          await measureMenu("permission", ".permission-button", ".permission-menu"),
        );
        menus.push(await measureMenu("model", ".model-button", ".model-menu"));
        const permissionButton = document.querySelector(".permission-button");
        if (!(permissionButton instanceof HTMLButtonElement)) {
          throw new Error("O controle de permissões desapareceu durante a auditoria.");
        }
        permissionButton.click();
        await frame();
        await frame();

        const composer = document.querySelector(".composer-wrap");
        const chatPage = document.querySelector(".chat-page");
        const dock = document.querySelector(".chat-dock");
        const progress = document.querySelector(".plan-progress");
        const timelineFrame = document.querySelector(".timeline-frame");
        const timeline = timelineFrame?.querySelector(".timeline");
        const timelineInner = timeline?.querySelector(".timeline-inner");
        const surfaceScrollbar = timelineFrame?.querySelector(".surface-scrollbar");
        const scrollbarDown = surfaceScrollbar?.querySelector(".surface-scrollbar-arrow.down");
        const permissionMenu = document.querySelector(".permission-menu");
        const commandIcon = document.querySelector(
          ".command-activity-card > summary .activity-icon svg",
        );
        const commandFrame = commandIcon?.querySelector("rect");
        const commandIconBounds = commandIcon?.getBoundingClientRect();
        if (
          !(composer instanceof HTMLElement) ||
          !(chatPage instanceof HTMLElement) ||
          !(dock instanceof HTMLElement) ||
          !(progress instanceof HTMLElement) ||
          !(timelineFrame instanceof HTMLElement) ||
          !(timeline instanceof HTMLElement) ||
          !(timelineInner instanceof HTMLElement) ||
          !(surfaceScrollbar instanceof HTMLElement) ||
          !(scrollbarDown instanceof HTMLButtonElement) ||
          !(permissionMenu instanceof HTMLElement) ||
          !(commandIcon instanceof SVGElement) ||
          !(commandFrame instanceof SVGRectElement) ||
          commandIconBounds === undefined
        ) {
          throw new Error("A hierarquia final de camadas do dock está incompleta.");
        }
        timeline.scrollTop = timeline.scrollHeight;
        await frame();
        await frame();
        const mountedTimelineItems = [...document.querySelectorAll(".timeline-virtual-item")];
        const lastTimelineItem = mountedTimelineItems.reduce(
          (latest, candidate) =>
            latest === null ||
            candidate.getBoundingClientRect().bottom > latest.getBoundingClientRect().bottom
              ? candidate
              : latest,
          null,
        );
        if (!(lastTimelineItem instanceof HTMLElement)) {
          throw new Error("O último item da timeline não está materializado no limite inferior.");
        }
        const rootStyle = getComputedStyle(document.documentElement);
        const chatPageBounds = rectangle(chatPage);
        const dockBounds = rectangle(dock);
        const timelineBounds = rectangle(timelineFrame);
        const timelineViewportBounds = rectangle(timeline);
        const scrollbarBounds = rectangle(surfaceScrollbar);
        const scrollbarDownBounds = rectangle(scrollbarDown);
        const lastTimelineItemBounds = rectangle(lastTimelineItem);
        window.__previewComposerPopoverLayeringMetrics = {
          chatPageBounds,
          chatPageDisplay: getComputedStyle(chatPage).display,
          chatDockHeight: Number.parseFloat(
            getComputedStyle(chatPage).getPropertyValue("--chat-dock-height"),
          ),
          composerIsolation: getComputedStyle(composer).isolation,
          composerLayer: Number.parseInt(getComputedStyle(composer).zIndex, 10),
          commandFrame: {
            height: commandFrame.getAttribute("height"),
            rx: commandFrame.getAttribute("rx"),
            width: commandFrame.getAttribute("width"),
            x: commandFrame.getAttribute("x"),
            y: commandFrame.getAttribute("y"),
          },
          commandIconPaths: [...commandIcon.querySelectorAll("path")].map((path) =>
            path.getAttribute("d"),
          ),
          commandIconSize: {
            height: commandIconBounds.height,
            width: commandIconBounds.width,
          },
          commandIconViewBox: commandIcon.getAttribute("viewBox"),
          dockLayer: rootStyle.getPropertyValue("--layer-chat-dock").trim(),
          dockBounds,
          dockPosition: getComputedStyle(dock).position,
          horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
          menus,
          permissionMenuBounds: rectangle(permissionMenu),
          permissionMenuLayer: Number.parseInt(getComputedStyle(permissionMenu).zIndex, 10),
          popoverLayer: rootStyle.getPropertyValue("--layer-local-popover").trim(),
          scrollbarBounds,
          scrollbarDownBounds,
          scrollbarBottomGap: chatPageBounds.bottom - scrollbarDownBounds.bottom,
          statusLayer: Number.parseInt(getComputedStyle(progress).zIndex, 10),
          lastTimelineItemBounds,
          lastTimelineItemDockGap: dockBounds.top - lastTimelineItemBounds.bottom,
          timelineAtEnd:
            timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop,
          timelineBounds,
          timelineBottomPadding: Number.parseFloat(getComputedStyle(timelineInner).paddingBottom),
          timelinePosition: getComputedStyle(timelineFrame).position,
          timelineViewportBounds,
          timelineDockGap: dockBounds.top - timelineBounds.bottom,
          timelineDockOverlap: Math.max(
            0,
            Math.min(timelineBounds.bottom, dockBounds.bottom) -
              Math.max(timelineBounds.top, dockBounds.top),
          ),
        };
      } catch (error) {
        window.__previewComposerPopoverLayeringError =
          error instanceof Error ? error.stack ?? error.message : String(error);
      }
      window.__previewComposerPopoverLayeringReady = true;
    })();
  })()`;
}

function imageViewGroupVisualAuditExpression() {
  return `(() => {
    if (window.__previewImageViewError !== undefined) {
      throw new Error(window.__previewImageViewError);
    }
    const group = document.querySelector(".image-view-group");
    if (!(group instanceof HTMLDetailsElement)) {
      throw new Error("O agrupamento de imagens está ausente.");
    }
    const images = [...group.querySelectorAll(".tool-image-preview img")];
    return {
      viewport: { width: innerWidth, height: innerHeight },
      label: group.querySelector(":scope > summary .activity-title")?.textContent?.trim() ?? null,
      open: group.open,
      imageCount: images.length,
      uniqueSources: new Set(images.map((image) => image.getAttribute("src"))).size,
      rawDataUrlText: group.querySelector("pre")?.textContent?.includes("image_url") === true,
      previewButtons: group.querySelectorAll(".tool-image-preview").length,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`;
}

function manualScrollOwnershipPrepareExpression() {
  return `(() => {
    void (async () => {
      try {
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const waitUntil = async (label, predicate) => {
          const deadline = performance.now() + 3000;
          while (!predicate()) {
            if (performance.now() > deadline) {
              throw new Error("Tempo esgotado preparando " + label + ".");
            }
            await frame();
          }
        };
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Inspecionar janela de contexto"),
        );
        if (!(threadButton instanceof HTMLButtonElement)) {
          throw new Error("O chat de referência do scroll manual está ausente.");
        }
        threadButton.click();
        await waitUntil(
          "o chat de referência",
          () => document.getElementById("user-message-preview-image-user-message") !== null,
        );
        const timeline = document.querySelector(".timeline");
        if (!(timeline instanceof HTMLElement)) {
          throw new Error("A timeline do cenário de scroll manual está ausente.");
        }
        await waitUntil(
          "dois turnos virtualizados",
          () => document.querySelectorAll(".timeline-virtual-item").length >= 2,
        );
        const initialItems = [...document.querySelectorAll(".timeline-virtual-item")];
        const initialFirst = initialItems[0];
        const initialAnchor = initialItems[1];
        const timelineInner = timeline.querySelector(":scope > .timeline-inner");
        if (
          !(initialFirst instanceof HTMLElement) ||
          !(initialAnchor instanceof HTMLElement) ||
          !(timelineInner instanceof HTMLElement)
        ) {
          throw new Error("Os itens de referência do scroll manual estão ausentes.");
        }
        const firstId = initialFirst.getAttribute("data-virtual-turn-id");
        const anchorId = initialAnchor.getAttribute("data-virtual-turn-id");
        if (firstId === null || anchorId === null) {
          throw new Error("Os itens de referência perderam suas identidades virtuais.");
        }
        const setupSpacer = document.createElement("div");
        setupSpacer.dataset.previewManualScrollSetup = "";
        setupSpacer.style.height = Math.max(1200, window.innerHeight) + "px";
        timelineInner.append(setupSpacer);
        await frame();
        await frame();
        timeline.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -1 }),
        );
        timeline.scrollTop = 0;
        await frame();
        await frame();
        const first = document.querySelector(
          '.timeline-virtual-item[data-virtual-turn-id="' + firstId + '"]',
        );
        const anchor = document.querySelector(
          '.timeline-virtual-item[data-virtual-turn-id="' + anchorId + '"]',
        );
        if (!(first instanceof HTMLElement) || !(anchor instanceof HTMLElement)) {
          throw new Error("Os itens de referência foram desmontados durante a preparação.");
        }
        const timelineTop = timeline.getBoundingClientRect().top;
        const anchorContentTop =
          timeline.scrollTop + anchor.getBoundingClientRect().top - timelineTop;
        timeline.scrollTop = Math.min(
          timeline.scrollHeight - timeline.clientHeight,
          Math.max(0, anchorContentTop + 200),
        );
        await frame();
        const target = Math.max(0, timeline.scrollTop - 80);
        timeline.dispatchEvent(
          new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -80 }),
        );
        timeline.scrollTop = target;
        await frame();
        const mountedFirst = document.querySelector(
          '.timeline-virtual-item[data-virtual-turn-id="' + firstId + '"]',
        );
        const mountedAnchor = document.querySelector(
          '.timeline-virtual-item[data-virtual-turn-id="' + anchorId + '"]',
        );
        if (
          !(mountedFirst instanceof HTMLElement) ||
          !(mountedAnchor instanceof HTMLElement)
        ) {
          throw new Error("Os itens de referência foram desmontados antes da medição.");
        }
        window.__previewManualScrollState = {
          anchorId,
          beforeAnchorGap:
            mountedAnchor.getBoundingClientRect().top - timeline.getBoundingClientRect().top,
          beforeItemHeight: mountedFirst.getBoundingClientRect().height,
          beforeScrollTop: timeline.scrollTop,
          firstId,
        };
        const growth = document.createElement("div");
        growth.dataset.previewScrollGrowth = "";
        growth.style.height = "320px";
        mountedFirst.append(growth);
        await new Promise((resolve) => setTimeout(resolve, 300));
      } catch (error) {
        window.__previewManualScrollError =
          error instanceof Error ? error.stack ?? error.message : String(error);
      } finally {
        window.__previewManualScrollReady = true;
      }
    })();
  })()`;
}

function nestedScrollHandoffPrepareExpression() {
  return `(() => {
    void (async () => {
      try {
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Inspecionar janela de contexto"),
        );
        threadButton?.click();
        for (let index = 0; index < 16; index += 1) {
          await frame();
          document.querySelectorAll('button[aria-label="Mostrar trabalho do agente"]').forEach(
            (button) => button.click(),
          );
          const timeline = document.querySelector(".timeline");
          if (timeline instanceof HTMLElement) {
            timeline.scrollTop = timeline.scrollHeight - timeline.clientHeight;
          }
          document.querySelectorAll(".agent-activity-group:not([open]) > summary").forEach(
            (summary) => summary.click(),
          );
          const command = [...document.querySelectorAll(".command-activity-card")].find(
            (details) => details.querySelector(":scope > summary .activity-title.is-running") !== null,
          );
          const source = document
            .querySelector('[data-virtual-activity-key*="preview-source-read"]')
            ?.querySelector("details");
          const file = [...document.querySelectorAll(".file-change-diff .diff-file-identity code")].find(
            (element) => element.textContent?.trim() === "semantic.rs",
          );
          const diff = file?.closest(".file-change-diff");
          if (
            command instanceof HTMLDetailsElement &&
            source instanceof HTMLDetailsElement &&
            diff instanceof HTMLDetailsElement
          ) {
            for (const details of [command, source, diff]) {
              if (!(details instanceof HTMLDetailsElement)) {
                continue;
              }
              if (!details.open) {
                details.querySelector(":scope > summary")?.click();
              }
            }
            await frame();
            await frame();
            const timeline = document.querySelector(".timeline");
            const commandScroll = command.querySelector(".command-card-scroll");
            const sourceScroll = source.querySelector(".tool-source-viewport");
            const diffScroll = diff.querySelector(".diff-viewport");
            if (
              !(timeline instanceof HTMLElement) ||
              !(commandScroll instanceof HTMLElement) ||
              !(sourceScroll instanceof HTMLElement) ||
              !(diffScroll instanceof HTMLElement)
            ) {
              throw new Error("As regiões aninhadas não materializaram seu conteúdo.");
            }
            const maximumTimelineScroll = timeline.scrollHeight - timeline.clientHeight;
            const baseTimelineScroll = Math.round(
              Math.min(maximumTimelineScroll, Math.max(400, maximumTimelineScroll * 0.6)),
            );
            const originalGetComputedStyle = window.getComputedStyle;
            let styleReadCount = 0;
            window.getComputedStyle = (...args) => {
              styleReadCount += 1;
              return originalGetComputedStyle.apply(window, args);
            };
            const run = async (region, requestedTop, deltaY) => {
              timeline.scrollTop = baseTimelineScroll;
              await frame();
              region.scrollTop = requestedTop;
              const nestedStart = region.scrollTop;
              const maximumNestedScroll = Math.max(0, region.scrollHeight - region.clientHeight);
              const desiredNestedScroll = nestedStart + deltaY;
              const expectedNestedScroll = Math.min(
                maximumNestedScroll,
                Math.max(0, desiredNestedScroll),
              );
              const expectedTimelineDelta = desiredNestedScroll - expectedNestedScroll;
              const wheel = new WheelEvent("wheel", {
                bubbles: true,
                cancelable: true,
                deltaMode: 0,
                deltaY,
              });
              const timelineStart = timeline.scrollTop;
              region.dispatchEvent(wheel);
              const targetTimelineScroll = timelineStart + expectedTimelineDelta;
              const timelinePositions = [timeline.scrollTop];
              const deadline = performance.now() + 1200;
              while (
                Math.abs(timeline.scrollTop - targetTimelineScroll) > 1 &&
                performance.now() < deadline
              ) {
                await frame();
                timelinePositions.push(timeline.scrollTop);
              }
              await frame();
              timelinePositions.push(timeline.scrollTop);
              const direction = Math.sign(expectedTimelineDelta);
              const frameDeltas = timelinePositions.slice(1).map(
                (position, index) => position - (timelinePositions[index] ?? position),
              );
              return {
                defaultPrevented: wheel.defaultPrevented,
                distinctTimelinePositions: new Set(
                  timelinePositions.map((position) => Math.round(position * 10)),
                ).size,
                expectedNestedScroll,
                expectedTimelineDelta,
                maximumFrameDelta: Math.max(0, ...frameDeltas.map((delta) => Math.abs(delta))),
                monotonic:
                  direction === 0 ||
                  frameDeltas.every((delta) => direction * delta >= -0.5),
                nestedScrollTop: region.scrollTop,
                targetTimelineScroll,
                timelineDelta: timeline.scrollTop - timelineStart,
                timelineStart,
              };
            };
            try {
              const handoffStartedAt = performance.now();
              window.__previewNestedScrollMetrics = {
                command: await run(commandScroll, 40, -100),
                diff: await run(diffScroll, 0, -120),
                handoffDurationMs: performance.now() - handoffStartedAt,
                source: await run(sourceScroll, 0, -80),
                styleReadCount,
              };
            } finally {
              window.getComputedStyle = originalGetComputedStyle;
            }
            return;
          }
        }
        throw new Error("As atividades-alvo do scroll aninhado não foram montadas.");
      } catch (error) {
        window.__previewNestedScrollError =
          error instanceof Error ? error.stack ?? error.message : String(error);
      } finally {
        window.__previewNestedScrollReady = true;
      }
    })();
  })()`;
}

function nestedScrollWheelOwnershipPrepareExpression() {
  return `(() => {
    void (async () => {
      try {
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const waitUntil = async (label, predicate) => {
          const deadline = performance.now() + 3000;
          while (!predicate()) {
            if (performance.now() > deadline) {
              throw new Error("Tempo esgotado preparando " + label + ".");
            }
            await frame();
          }
        };
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Estresse de timeline expandida"),
        );
        if (!(threadButton instanceof HTMLButtonElement)) {
          throw new Error("O chat de estresse da timeline está ausente.");
        }
        threadButton.click();
        await waitUntil(
          "o turno de estresse",
          () =>
            document.getElementById("user-message-timeline-stress-user-message") !== null,
        );
        document.querySelector('button[aria-label="Mostrar trabalho do agente"]')?.click();
        await frame();
        document.querySelector(".agent-activity-group:not([open]) > summary")?.click();
        await waitUntil(
          "a lista virtualizada de atividades",
          () => document.querySelector(".agent-activity-virtual-list") !== null,
        );
        const timeline = document.querySelector(".timeline");
        if (!(timeline instanceof HTMLElement)) {
          throw new Error("A timeline do cenário de wheel nativo está ausente.");
        }
        for (let attempt = 0; attempt < 5; attempt += 1) {
          timeline.dispatchEvent(
            new WheelEvent("wheel", {
              bubbles: true,
              cancelable: true,
              deltaMode: 0,
              deltaY: -1,
            }),
          );
          timeline.scrollTop = 0;
          await new Promise((resolve) => setTimeout(resolve, 180));
          await frame();
          if (timeline.scrollTop <= 1) {
            break;
          }
        }
        if (timeline.scrollTop > 1) {
          throw new Error(
            "A timeline não estabilizou no topo antes do teste de wheel aninhado.",
          );
        }
        const materializationSamples = [];
        for (let index = 0; index < 24; index += 1) {
          const sourceWrapper = document.querySelector(
            '[data-virtual-activity-key^="13:toolExecution|22:timeline-stress-tool-2|"]',
          );
          const diffWrapper = document.querySelector(
            '[data-virtual-activity-key^="10:fileChange|24:timeline-stress-change-3|"]',
          );
          const source = sourceWrapper?.querySelector("details");
          const diff = diffWrapper?.querySelector("details");
          materializationSamples.push({
            diffMounted: diffWrapper !== null,
            index,
            sourceMounted: sourceWrapper !== null,
            scrollTop: timeline.scrollTop,
          });
          for (const details of [source, diff]) {
            if (details instanceof HTMLDetailsElement && !details.open) {
              details.querySelector(":scope > summary")?.click();
              await frame();
            }
          }
          await frame();
          const sourceScroll =
            source instanceof HTMLDetailsElement
              ? source.querySelector(".tool-source-viewport")
              : null;
          const diffScroll =
            diff instanceof HTMLDetailsElement ? diff.querySelector(".diff-viewport") : null;
          if (
            sourceScroll instanceof HTMLElement &&
            diffScroll instanceof HTMLElement &&
            sourceScroll.scrollHeight - sourceScroll.clientHeight >= 160 &&
            diffScroll.scrollHeight - diffScroll.clientHeight >= 160
          ) {
            sourceScroll.dataset.previewNestedWheelTarget = "source";
            diffScroll.dataset.previewNestedWheelTarget = "diff";
            return;
          }
          timeline.scrollTop = Math.min(
            timeline.scrollHeight - timeline.clientHeight,
            timeline.scrollTop + 120,
          );
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const describeTarget = (activityKey, regionSelector) => {
          const wrapper = document.querySelector(
            '[data-virtual-activity-key^="' + activityKey + '"]',
          );
          const details = wrapper?.querySelector("details");
          const region = details?.querySelector(regionSelector);
          return {
            mounted: wrapper !== null,
            open: details instanceof HTMLDetailsElement ? details.open : null,
            scrollRange:
              region instanceof HTMLElement ? region.scrollHeight - region.clientHeight : null,
          };
        };
        throw new Error(
          "Os arquivos expandidos não materializaram regiões verticais suficientes: " +
            JSON.stringify({
              diff: describeTarget(
                "10:fileChange|24:timeline-stress-change-3|",
                ".diff-viewport",
              ),
              source: describeTarget(
                "13:toolExecution|22:timeline-stress-tool-2|",
                ".tool-source-viewport",
              ),
              timeline: {
                clientHeight: timeline.clientHeight,
                scrollHeight: timeline.scrollHeight,
                scrollTop: timeline.scrollTop,
              },
              virtualList: {
                materializationSamples,
                mountedKeys: [...document.querySelectorAll(
                  ".agent-activity-virtual-item[data-virtual-activity-key]",
                )].map((element) => element.getAttribute("data-virtual-activity-key")),
                total: document
                  .querySelector(".agent-activity-virtual-list")
                  ?.getAttribute("data-virtual-activity-total"),
              },
              viewport: { height: window.innerHeight, width: window.innerWidth },
            }),
        );
      } catch (error) {
        window.__previewNestedWheelError =
          error instanceof Error ? error.stack ?? error.message : String(error);
      } finally {
        window.__previewNestedWheelReady = true;
      }
    })();
  })()`;
}

async function exerciseNestedScrollWheelOwnership(client) {
  const samples = {};
  for (const label of ["diff", "source"]) {
    const activityKey =
      label === "diff"
        ? "10:fileChange|24:timeline-stress-change-3|"
        : "13:toolExecution|22:timeline-stress-tool-2|";
    await client.evaluate(
      `(() => {
        const timeline = document.querySelector(".timeline");
        if (!(timeline instanceof HTMLElement)) {
          throw new Error("A timeline está ausente antes de localizar ${label}.");
        }
        timeline.scrollTop = 0;
      })()`,
      false,
    );
    await client.evaluate(
      `new Promise((resolve) => setTimeout(
        () => requestAnimationFrame(() => requestAnimationFrame(resolve)),
        140,
      ))`,
      true,
    );
    await client.evaluate(
      `(() => {
        if (window.__previewNestedWheelError !== undefined) {
          throw new Error(window.__previewNestedWheelError);
        }
        const wrapper = document.querySelector(
          '[data-virtual-activity-key^="${activityKey}"]',
        );
        const details = wrapper?.querySelector("details");
        if (!(details instanceof HTMLDetailsElement)) {
          throw new Error("Atividade aninhada ausente: ${label}");
        }
        details.querySelector(":scope > summary")?.scrollIntoView({
          block: "center",
          inline: "nearest",
        });
      })()`,
      false,
    );
    await client.evaluate(
      `new Promise((resolve) => setTimeout(
        () => requestAnimationFrame(() => requestAnimationFrame(resolve)),
        140,
      ))`,
      true,
    );
    const pointer = await client.evaluate(
      `(() => {
        const timeline = document.querySelector(".timeline");
        const wrapper = document.querySelector(
          '[data-virtual-activity-key^="${activityKey}"]',
        );
        const details = wrapper?.querySelector("details");
        const region =
          "${label}" === "diff"
            ? details?.querySelector(".diff-viewport")
            : details?.querySelector(".tool-source-viewport");
        if (!(timeline instanceof HTMLElement) || !(region instanceof HTMLElement)) {
          throw new Error("Viewport de scroll ausente para ${label}.");
        }
        const eventCount = 4;
        const eventDelta = 20;
        const expectedNestedDelta = eventCount * eventDelta;
        const maximumNestedScroll = region.scrollHeight - region.clientHeight;
        const nestedStart = Math.round(maximumNestedScroll / 2);
        region.scrollTop = nestedStart;
        const maximumTimelineScroll = timeline.scrollHeight - timeline.clientHeight;
        const direction =
          maximumTimelineScroll - timeline.scrollTop >= expectedNestedDelta + 2 ? 1 : -1;
        const timelineStart = timeline.scrollTop;
        const bounds = region.getBoundingClientRect();
        const timelineBounds = timeline.getBoundingClientRect();
        const x = Math.min(bounds.right - 8, bounds.left + Math.max(8, bounds.width / 2));
        const visibleTop = Math.max(bounds.top, timelineBounds.top);
        const visibleBottom = Math.min(bounds.bottom, timelineBounds.bottom);
        let y = null;
        for (let candidate = visibleTop + 8; candidate <= visibleBottom - 8; candidate += 16) {
          const hit = document.elementFromPoint(x, candidate);
          if (hit instanceof Node && region.contains(hit)) {
            y = candidate;
            break;
          }
        }
        if (y === null) {
          throw new Error(
            "Nenhum ponto visível pertence à região ${label}: " +
              JSON.stringify({
                activityKey: wrapper?.getAttribute("data-virtual-activity-key") ?? null,
                bounds: bounds.toJSON(),
                detailsOpen:
                  details instanceof HTMLDetailsElement ? details.open : null,
                disclosureExpanded:
                  details?.querySelector(":scope > summary")?.getAttribute("aria-expanded") ??
                  null,
                disclosureKey:
                  details
                    ?.querySelector(":scope > summary")
                    ?.getAttribute("data-timeline-disclosure") ?? null,
                groupDisclosureKey:
                  wrapper
                    ?.closest(".agent-activity-group")
                    ?.querySelector(":scope > summary")
                    ?.getAttribute("data-timeline-disclosure") ?? null,
                hits: document
                  .elementsFromPoint(x, Math.max(0, Math.min(innerHeight - 1, visibleTop + 8)))
                  .slice(0, 6)
                  .map((element) => ({
                    bounds: element.getBoundingClientRect().toJSON(),
                    className:
                      typeof element.className === "string" ? element.className : null,
                    tagName: element.tagName,
                    virtualKey:
                      element
                        .closest("[data-virtual-activity-key]")
                        ?.getAttribute("data-virtual-activity-key") ?? null,
                  })),
                regionScroll: {
                  clientHeight: region.clientHeight,
                  scrollHeight: region.scrollHeight,
                  scrollTop: region.scrollTop,
                },
                timelineBounds: timelineBounds.toJSON(),
                timelineScroll: {
                  clientHeight: timeline.clientHeight,
                  scrollHeight: timeline.scrollHeight,
                  scrollTop: timeline.scrollTop,
                },
                visibleBottom,
                visibleTop,
                wrapperBounds: wrapper?.getBoundingClientRect().toJSON() ?? null,
                wrapperTop: wrapper instanceof HTMLElement ? wrapper.style.top : null,
                x,
              }),
          );
        }
        const events = [];
        const listener = (event) => {
          if (event.target instanceof Node && region.contains(event.target)) {
            events.push({
              cancelable: event.cancelable,
              defaultPrevented: event.defaultPrevented,
              deltaY: event.deltaY,
            });
          }
        };
        timeline.addEventListener("wheel", listener);
        window.__previewNestedWheelSample = {
          canvasBefore: region.querySelector(
            "${label}" === "diff"
              ? ".diff-virtual-canvas"
              : ".tool-source-virtual-canvas",
          ),
          rowSelector:
            "${label}" === "diff" ? ".diff-virtual-row" : ".tool-source-line",
          rowsBefore: null,
          events,
          expectedNestedDelta: direction * expectedNestedDelta,
          label: "${label}",
          listener,
          nestedStart,
          region,
          timeline,
          timelineStart,
        };
        return {
          deltaY: direction * eventDelta,
          eventCount,
          x,
          y,
        };
      })()`,
      false,
    );
    await client.evaluate(
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
      true,
    );
    await client.evaluate(
      `(() => {
        const sample = window.__previewNestedWheelSample;
        if (
          sample === undefined ||
          sample.label !== "${label}" ||
          !(sample.region instanceof HTMLElement)
        ) {
          throw new Error("A janela virtual ficou inconsistente antes do wheel: ${label}.");
        }
        sample.rowsBefore = new Map(
          [...sample.region.querySelectorAll(sample.rowSelector)].map((row) => [
            row.getAttribute("aria-rowindex"),
            row,
          ]),
        );
        sample.canvasBefore = sample.region.querySelector(
          "${label}" === "diff"
            ? ".diff-virtual-canvas"
            : ".tool-source-virtual-canvas",
        );
      })()`,
      false,
    );
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: pointer.x,
      y: pointer.y,
    });
    for (let index = 0; index < pointer.eventCount; index += 1) {
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        deltaX: 0,
        deltaY: pointer.deltaY,
        x: pointer.x,
        y: pointer.y,
      });
    }
    await client.evaluate(
      `new Promise((resolve) => setTimeout(
        () => requestAnimationFrame(() => requestAnimationFrame(resolve)),
        50,
      ))`,
      true,
    );
    const internal = await client.evaluate(
      `(() => {
        const sample = window.__previewNestedWheelSample;
        if (
          sample === undefined ||
          sample.label !== "${label}" ||
          !(sample.region instanceof HTMLElement) ||
          !(sample.timeline instanceof HTMLElement)
        ) {
          throw new Error("A amostra de wheel ficou inconsistente para ${label}.");
        }
        sample.timeline.removeEventListener("wheel", sample.listener);
        const currentCanvas = sample.region.querySelector(
          "${label}" === "diff"
            ? ".diff-virtual-canvas"
            : ".tool-source-virtual-canvas",
        );
        const currentRows = [...sample.region.querySelectorAll(sample.rowSelector)];
        let rowIdentityComparisons = 0;
        let rowIdentityChanges = 0;
        for (const row of currentRows) {
          const key = row.getAttribute("aria-rowindex");
          const previous = sample.rowsBefore?.get(key);
          if (previous === undefined) {
            continue;
          }
          rowIdentityComparisons += 1;
          rowIdentityChanges += previous === row ? 0 : 1;
        }
        return {
          canvasIdentityChanged: sample.canvasBefore !== currentCanvas,
          events: sample.events,
          expectedNestedDelta: sample.expectedNestedDelta,
          mountedRows: currentRows.length,
          nestedDelta: sample.region.scrollTop - sample.nestedStart,
          rowIdentityChanges,
          rowIdentityComparisons,
          timelineDelta: sample.timeline.scrollTop - sample.timelineStart,
        };
      })()`,
      false,
    );
    const handoffPointer = await client.evaluate(
      `(() => {
        const sample = window.__previewNestedWheelSample;
        if (
          sample === undefined ||
          sample.label !== "${label}" ||
          !(sample.region instanceof HTMLElement) ||
          !(sample.timeline instanceof HTMLElement)
        ) {
          throw new Error("A região de handoff ficou inconsistente para ${label}.");
        }
        const eventCount = 4;
        const eventDelta = 20;
        const expectedTimelineDistance = eventCount * eventDelta;
        const maximumNestedScroll = sample.region.scrollHeight - sample.region.clientHeight;
        const maximumTimelineScroll =
          sample.timeline.scrollHeight - sample.timeline.clientHeight;
        const direction =
          maximumTimelineScroll - sample.timeline.scrollTop >= expectedTimelineDistance + 2
            ? 1
            : -1;
        const targetTimelineScroll = Math.min(
          maximumTimelineScroll,
          Math.max(0, sample.timeline.scrollTop + direction * expectedTimelineDistance),
        );
        sample.region.scrollTop = direction > 0 ? maximumNestedScroll : 0;
        const events = [];
        const listener = (event) => {
          if (event.target instanceof Node && sample.region.contains(event.target)) {
            events.push({
              cancelable: event.cancelable,
              defaultPrevented: event.defaultPrevented,
              deltaY: event.deltaY,
            });
          }
        };
        sample.timeline.addEventListener("wheel", listener);
        window.__previewNestedWheelHandoffSample = {
          events,
          expectedTimelineDelta: targetTimelineScroll - sample.timeline.scrollTop,
          label: "${label}",
          listener,
          nestedStart: sample.region.scrollTop,
          region: sample.region,
          targetTimelineScroll,
          timeline: sample.timeline,
          timelineStart: sample.timeline.scrollTop,
        };
        return {
          deltaY: direction * eventDelta,
          eventCount,
          x: ${JSON.stringify(pointer.x)},
          y: ${JSON.stringify(pointer.y)},
        };
      })()`,
      false,
    );
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: handoffPointer.x,
      y: handoffPointer.y,
    });
    for (let index = 0; index < handoffPointer.eventCount; index += 1) {
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        deltaX: 0,
        deltaY: handoffPointer.deltaY,
        x: handoffPointer.x,
        y: handoffPointer.y,
      });
    }
    const handoff = await client.evaluate(
      `new Promise((resolve, reject) => {
        const sample = window.__previewNestedWheelHandoffSample;
        if (
          sample === undefined ||
          sample.label !== "${label}" ||
          !(sample.region instanceof HTMLElement) ||
          !(sample.timeline instanceof HTMLElement)
        ) {
          reject(new Error("A amostra de handoff ficou inconsistente para ${label}."));
          return;
        }
        const positions = [sample.timeline.scrollTop];
        const deadline = performance.now() + 1200;
        const measure = () => {
          positions.push(sample.timeline.scrollTop);
          if (
            Math.abs(sample.timeline.scrollTop - sample.targetTimelineScroll) > 1 &&
            performance.now() < deadline
          ) {
            requestAnimationFrame(measure);
            return;
          }
          sample.timeline.removeEventListener("wheel", sample.listener);
          const direction = Math.sign(sample.expectedTimelineDelta);
          const frameDeltas = positions.slice(1).map(
            (position, index) => position - (positions[index] ?? position),
          );
          resolve({
            distinctTimelinePositions: new Set(
              positions.map((position) => Math.round(position * 10)),
            ).size,
            events: sample.events,
            expectedTimelineDelta: sample.expectedTimelineDelta,
            maximumFrameDelta: Math.max(0, ...frameDeltas.map((delta) => Math.abs(delta))),
            monotonic:
              direction === 0 ||
              frameDeltas.every((delta) => direction * delta >= -0.5),
            nestedDelta: sample.region.scrollTop - sample.nestedStart,
            timelineDelta: sample.timeline.scrollTop - sample.timelineStart,
          });
        };
        requestAnimationFrame(measure);
      })`,
      true,
    );
    const reversalPointer = await client.evaluate(
      `(() => {
        const sample = window.__previewNestedWheelSample;
        if (
          sample === undefined ||
          sample.label !== "${label}" ||
          !(sample.region instanceof HTMLElement) ||
          !(sample.timeline instanceof HTMLElement)
        ) {
          throw new Error("A região de reversão ficou inconsistente para ${label}.");
        }
        const handoffDelta = 80;
        const reverseDelta = 20;
        const maximumNestedScroll = sample.region.scrollHeight - sample.region.clientHeight;
        const maximumTimelineScroll =
          sample.timeline.scrollHeight - sample.timeline.clientHeight;
        const direction =
          maximumTimelineScroll - sample.timeline.scrollTop >= handoffDelta + 2 ? 1 : -1;
        sample.region.scrollTop = direction > 0 ? maximumNestedScroll : 0;
        const events = [];
        const listener = (event) => {
          if (event.target instanceof Node && sample.region.contains(event.target)) {
            events.push({
              cancelable: event.cancelable,
              defaultPrevented: event.defaultPrevented,
              deltaY: event.deltaY,
            });
          }
        };
        sample.timeline.addEventListener("wheel", listener);
        window.__previewNestedWheelReversalSample = {
          direction,
          events,
          expectedNestedDelta: -direction * reverseDelta,
          handoffDelta: direction * handoffDelta,
          label: "${label}",
          listener,
          nestedStart: sample.region.scrollTop,
          region: sample.region,
          timeline: sample.timeline,
          timelineStart: sample.timeline.scrollTop,
        };
        return {
          handoffDeltaY: direction * handoffDelta,
          reverseDeltaY: -direction * reverseDelta,
          x: ${JSON.stringify(pointer.x)},
          y: ${JSON.stringify(pointer.y)},
        };
      })()`,
      false,
    );
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: reversalPointer.x,
      y: reversalPointer.y,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      deltaX: 0,
      deltaY: reversalPointer.handoffDeltaY,
      x: reversalPointer.x,
      y: reversalPointer.y,
    });
    await client.evaluate(`new Promise((resolve) => requestAnimationFrame(resolve))`, true);
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      deltaX: 0,
      deltaY: reversalPointer.reverseDeltaY,
      x: reversalPointer.x,
      y: reversalPointer.y,
    });
    const reversal = await client.evaluate(
      `new Promise((resolve, reject) => {
        const sample = window.__previewNestedWheelReversalSample;
        if (
          sample === undefined ||
          sample.label !== "${label}" ||
          !(sample.region instanceof HTMLElement) ||
          !(sample.timeline instanceof HTMLElement)
        ) {
          reject(new Error("A amostra de reversão ficou inconsistente para ${label}."));
          return;
        }
        const positions = [];
        let remainingFrames = 12;
        const measure = () => {
          positions.push(sample.timeline.scrollTop);
          remainingFrames -= 1;
          if (remainingFrames > 0) {
            requestAnimationFrame(measure);
            return;
          }
          sample.timeline.removeEventListener("wheel", sample.listener);
          resolve({
            events: sample.events,
            expectedNestedDelta: sample.expectedNestedDelta,
            handoffDelta: sample.handoffDelta,
            nestedDelta: sample.region.scrollTop - sample.nestedStart,
            postCancelRange:
              positions.length === 0 ? 0 : Math.max(...positions) - Math.min(...positions),
            timelineDelta: sample.timeline.scrollTop - sample.timelineStart,
          });
        };
        requestAnimationFrame(measure);
      })`,
      true,
    );
    samples[label] = { handoff, internal, reversal };
  }
  await client.evaluate(
    `window.__previewNestedWheelMetrics = ${JSON.stringify(samples)}`,
    false,
  );
}

async function exerciseIntrinsicActivityInteraction(client) {
  await exerciseIntrinsicSummaryInteraction(client, {
    actionSelector: ".file-change-action",
    chevronSelector: ".diff-file-chevron",
    identitySelector: ".diff-file-identity code",
    stateProperty: "__previewIntrinsicActivityInteraction",
    summaryExpression: `[...document.querySelectorAll(".file-change-diff .diff-file-identity code")]
      .find((element) => element.textContent?.trim() === "engine.rs")?.closest("summary")`,
  });
}

async function exerciseHighlightedReadInteraction(client) {
  await exerciseIntrinsicSummaryInteraction(client, {
    actionSelector: ".activity-title",
    chevronSelector: ".activity-chevron",
    identitySelector: ".activity-title",
    stateProperty: "__previewReadActivityInteraction",
    summaryExpression: `[...document.querySelectorAll(".tool-activity-card > summary")]
      .find((element) => element.textContent?.includes("Executou leitura de arquivo"))`,
  });
}

async function exerciseWorkspaceSplitInteraction(client) {
  const initial = await client.evaluate(workspaceSplitVisualStateExpression(), false);
  if (initial.splitterDisplay === "none") {
    await client.evaluate(
      `window.__previewWorkspaceSplitInteraction = ${JSON.stringify({
        dragged: initial,
        initial,
        supported: false,
      })}`,
      false,
    );
    return;
  }
  const pointer = {
    startX: initial.splitter.left + initial.splitter.width / 2,
    targetX: initial.container.left + initial.container.width * 0.64,
    y: initial.splitter.top + Math.min(120, initial.splitter.height / 2),
  };
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: pointer.startX,
    y: pointer.y,
  });
  await client.send("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 1,
    clickCount: 1,
    type: "mousePressed",
    x: pointer.startX,
    y: pointer.y,
  });
  for (let step = 1; step <= 5; step += 1) {
    await client.send("Input.dispatchMouseEvent", {
      button: "left",
      buttons: 1,
      type: "mouseMoved",
      x: pointer.startX + ((pointer.targetX - pointer.startX) * step) / 5,
      y: pointer.y,
    });
  }
  await client.send("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 0,
    clickCount: 1,
    type: "mouseReleased",
    x: pointer.targetX,
    y: pointer.y,
  });
  await client.evaluate(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`,
    true,
  );
  const dragged = await client.evaluate(workspaceSplitVisualStateExpression(), false);
  await client.evaluate(
    `window.__previewWorkspaceSplitInteraction = ${JSON.stringify({
      dragged,
      initial,
      supported: true,
    })}`,
    false,
  );
}

async function exerciseIntrinsicSummaryInteraction(
  client,
  { actionSelector, chevronSelector, identitySelector, stateProperty, summaryExpression },
) {
  const stateKey = JSON.stringify(stateProperty);
  await client.evaluate(
    `(() => {
      const summary = ${summaryExpression};
      if (!(summary instanceof HTMLElement)) {
        throw new Error("A linha para posicionar a interação intrínseca está ausente.");
      }
      summary.scrollIntoView({ block: "center", inline: "nearest" });
    })()`,
    false,
  );
  await client.evaluate(
    `new Promise((resolve) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(resolve)), 180))`,
    true,
  );
  const pointer = await client.evaluate(
    `(() => {
      const summary = ${summaryExpression};
      const row = summary?.closest(".agent-activity-virtual-item") ?? summary?.parentElement;
      const action = summary?.querySelector(${JSON.stringify(actionSelector)});
      const identity = summary?.querySelector(${JSON.stringify(identitySelector)});
      const icon = summary?.querySelector(".activity-icon");
      const chevron = summary?.querySelector(${JSON.stringify(chevronSelector)});
      if (
        !(summary instanceof HTMLElement) ||
        !(row instanceof HTMLElement) ||
        !(action instanceof HTMLElement) ||
        !(identity instanceof HTMLElement) ||
        !(icon instanceof HTMLElement) ||
        !(chevron instanceof HTMLElement)
      ) {
        throw new Error("A linha para validar interação intrínseca está ausente.");
      }
      window.__capturePreviewIntrinsicActivity = () => ({
        actionColor: getComputedStyle(action).color,
        chevronOpacity: Number.parseFloat(getComputedStyle(chevron).opacity),
        expanded: summary.closest("details")?.hasAttribute("open") === true,
        hovered: summary.matches(":hover"),
        iconColor: getComputedStyle(icon).color,
        identityColor: getComputedStyle(identity).color,
        rowWidth: row.getBoundingClientRect().width,
        summaryWidth: summary.getBoundingClientRect().width,
      });
      const bounds = summary.getBoundingClientRect();
      const farX = Math.min(innerWidth - 4, row.getBoundingClientRect().right - 8);
      if (farX <= bounds.right + 16) {
        throw new Error("A linha não possui área externa suficiente para validar o hover.");
      }
      window[${stateKey}] = { rest: window.__capturePreviewIntrinsicActivity() };
      return {
        farX,
        hoverX: Math.max(bounds.left + 4, bounds.right - 8),
        y: bounds.top + bounds.height / 2,
      };
    })()`,
    false,
  );
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: pointer.farX,
    y: pointer.y,
  });
  await settleHoverTransition(client);
  await client.evaluate(
    `window[${stateKey}].far = window.__capturePreviewIntrinsicActivity()`,
    false,
  );
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: pointer.hoverX,
    y: pointer.y,
  });
  await settleHoverTransition(client);
  await client.evaluate(
    `window[${stateKey}].hover = window.__capturePreviewIntrinsicActivity()`,
    false,
  );
}

async function settleHoverTransition(client) {
  await client.evaluate(
    `new Promise((resolve) => setTimeout(() => requestAnimationFrame(resolve), 160))`,
    true,
  );
}

function nestedScrollFollowingPrepareExpression() {
  return `(() => {
    void (async () => {
      try {
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Inspecionar janela de contexto"),
        );
        threadButton?.click();
        let command;
        for (let index = 0; index < 16; index += 1) {
          await frame();
          document.querySelectorAll('button[aria-label="Mostrar trabalho do agente"]').forEach(
            (button) => button.click(),
          );
          const timeline = document.querySelector(".timeline");
          if (timeline instanceof HTMLElement) {
            timeline.scrollTop = timeline.scrollHeight - timeline.clientHeight;
          }
          document.querySelectorAll(".agent-activity-group:not([open]) > summary").forEach(
            (summary) => summary.click(),
          );
          command = [...document.querySelectorAll(".command-activity-card")].find(
            (details) => details.querySelector(":scope > summary .activity-title.is-running") !== null,
          );
          if (command instanceof HTMLDetailsElement) {
            break;
          }
        }
        if (!(command instanceof HTMLDetailsElement)) {
          throw new Error("O comando ativo não foi montado para o teste de acompanhamento.");
        }
        if (!command.open) {
          command.querySelector(":scope > summary")?.click();
        }
        await frame();
        await frame();
        const timeline = document.querySelector(".timeline");
        const region = command.querySelector(".command-card-scroll");
        if (!(timeline instanceof HTMLElement) || !(region instanceof HTMLElement)) {
          throw new Error("A saída interna do comando ativo está ausente.");
        }
        const maximumTimelineScroll = timeline.scrollHeight - timeline.clientHeight;
        timeline.scrollTop = Math.max(0, maximumTimelineScroll - 160);
        await frame();
        await frame();
        const scrollToEndButton = document.querySelector(
          'button[aria-label="Ir para o fim da conversa"]',
        );
        if (!(scrollToEndButton instanceof HTMLButtonElement)) {
          throw new Error("O controle para acompanhar o fim da timeline está ausente.");
        }
        scrollToEndButton.click();
        const followDeadline = performance.now() + 1200;
        while (
          Math.abs(timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop) > 2
        ) {
          if (performance.now() > followDeadline) {
            throw new Error("A timeline não concluiu a navegação para o fim.");
          }
          await frame();
        }
        await frame();
        const maximumNestedScroll = Math.max(0, region.scrollHeight - region.clientHeight);
        const nestedStart = Math.round(maximumNestedScroll / 2);
        const deltaY = Math.min(40, Math.max(1, maximumNestedScroll / 4));
        region.scrollTop = nestedStart;
        const timelineStart = timeline.scrollTop;
        const wheel = new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaMode: 0,
          deltaY,
        });
        region.dispatchEvent(wheel);
        if (!wheel.defaultPrevented) {
          region.scrollTop = nestedStart + deltaY;
        }
        const growth = document.createElement("div");
        growth.dataset.previewNestedFollowGrowth = "";
        growth.style.height = "160px";
        document.querySelector(".timeline-virtual-item:last-child")?.append(growth);
        for (let index = 0; index < 10; index += 1) {
          await frame();
          if (
            Math.abs(timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop) <= 2 &&
            Math.abs(timeline.scrollTop - timelineStart - 160) <= 2
          ) {
            break;
          }
        }
        window.__previewNestedFollowMetrics = {
          defaultPrevented: wheel.defaultPrevented,
          distanceToEnd: timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop,
          expectedNestedDelta: deltaY,
          nestedDelta: region.scrollTop - nestedStart,
          timelineDelta: timeline.scrollTop - timelineStart,
        };
      } catch (error) {
        window.__previewNestedFollowError =
          error instanceof Error ? error.stack ?? error.message : String(error);
      } finally {
        window.__previewNestedFollowReady = true;
      }
    })();
  })()`;
}

function timelinePerformanceStressPrepareExpression() {
  return `(() => {
    void (async () => {
      try {
        window.__timelineStressProgress = { phase: "starting" };
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const waitUntil = async (label, predicate, timeoutMs) => {
          const deadline = performance.now() + timeoutMs;
          while (!predicate()) {
            if (performance.now() > deadline) {
              throw new Error("Tempo esgotado preparando " + label + ".");
            }
            await frame();
          }
        };
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Estresse de timeline expandida"),
        );
        threadButton?.click();
        await waitUntil(
          "o primeiro turno do estresse",
          () => document.querySelector(".conversation-turn") !== null,
          3000,
        );
        document.querySelector('button[aria-label="Mostrar trabalho do agente"]')?.click();
        await frame();
        document.querySelector(".agent-activity-group:not([open]) > summary")?.click();
        await waitUntil(
          "a lista virtualizada de atividades",
          () => document.querySelector(".agent-activity-virtual-list") !== null,
          3000,
        );
        window.__timelineStressProgress = { phase: "activity-list-ready" };
        const timeline = document.querySelector(".timeline");
        if (!(timeline instanceof HTMLElement)) {
          throw new Error("A timeline do cenário de estresse está ausente.");
        }
        const claimScrollOwnership = () => {
          timeline.dispatchEvent(
            new WheelEvent("wheel", {
              bubbles: true,
              cancelable: true,
              deltaMode: 0,
              deltaY: -1,
            }),
          );
        };
        const visited = new Set();
        for (let attempt = 0; attempt < 5; attempt += 1) {
          claimScrollOwnership();
          timeline.scrollTop = 0;
          await new Promise((resolve) => setTimeout(resolve, 180));
          await frame();
          if (timeline.scrollTop <= 1) {
            break;
          }
        }
        if (timeline.scrollTop > 1) {
          throw new Error("A timeline não estabilizou no topo antes da expansão.");
        }
        const expansionStarted = performance.now();
        window.__timelineStressProgress = { phase: "expanding" };
        let iterations = 0;
        let stagnantIterations = 0;
        let direction = 1;
        let boundaryPasses = 0;
        while (visited.size < 180 && iterations < 600 && stagnantIterations < 200) {
          const maximum = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
          const step = Math.max(180, timeline.clientHeight * 0.72);
          let target = Math.min(maximum, Math.max(0, timeline.scrollTop + direction * step));
          if (Math.abs(target - timeline.scrollTop) <= 1) {
            direction *= -1;
            boundaryPasses += 1;
            target = Math.min(maximum, Math.max(0, timeline.scrollTop + direction * step));
          }
          timeline.scrollTop = target;
          await frame();
          let opened = 0;
          for (const wrapper of document.querySelectorAll(".agent-activity-virtual-item")) {
            const key = wrapper.getAttribute("data-virtual-activity-key");
            if (key === null || visited.has(key)) {
              continue;
            }
            const details = wrapper.querySelector("details");
            if (!(details instanceof HTMLDetailsElement)) {
              continue;
            }
            if (!details.open) {
              details.querySelector(":scope > summary")?.click();
            }
            visited.add(key);
            opened += 1;
          }
          stagnantIterations = opened === 0 ? stagnantIterations + 1 : 0;
          window.__timelineStressProgress = {
            iterations,
            phase: "expanding-visible-item",
            scrollHeight: timeline.scrollHeight,
            scrollTop: timeline.scrollTop,
            visited: visited.size,
          };
          await new Promise((resolve) => setTimeout(resolve, 8));
          iterations += 1;
        }
        if (visited.size !== 180) {
          const visitedOrdinals = new Set(
            [...visited]
              .map((key) =>
                Number(
                  key.match(/timeline-stress-(?:command|tool|change)-(\d+)/)?.[1] ?? Number.NaN,
                ),
              )
              .filter(Number.isFinite),
          );
          const missingOrdinals = Array.from({ length: 180 }, (_, index) => index + 1).filter(
            (ordinal) => !visitedOrdinals.has(ordinal),
          );
          throw new Error(
            "A expansão percorreu " +
              visited.size +
              " de 180 atividades em " +
              iterations +
              " iterações. " +
              JSON.stringify({
                missingOrdinals,
                mountedKeys: [...document.querySelectorAll(".agent-activity-virtual-item")].map(
                  (element) => element.getAttribute("data-virtual-activity-key"),
                ),
                scrollMaximum: Math.max(0, timeline.scrollHeight - timeline.clientHeight),
                scrollTop: timeline.scrollTop,
              }),
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 140));
        const expansionMs = performance.now() - expansionStarted;
        window.__timelineStressProgress = {
          expansionMs,
          phase: "expansion-complete",
          visited: visited.size,
        };

        const frameIntervals = [];
        const animationWorkByFrame = new Map();
        const animationCallbackOutliers = [];
        let auditAnimationCallback = null;
        const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (callback) =>
          nativeRequestAnimationFrame((timestamp) => {
            const started = performance.now();
            try {
              callback(timestamp);
            } finally {
              const duration = performance.now() - started;
              let measurement = animationWorkByFrame.get(timestamp);
              if (measurement === undefined) {
                measurement = {
                  applicationDuration: 0,
                  auditDuration: 0,
                  callbacks: 0,
                  duration: 0,
                  durations: [],
                };
                animationWorkByFrame.set(timestamp, measurement);
              }
              measurement.applicationDuration +=
                callback === auditAnimationCallback ? 0 : duration;
              measurement.auditDuration +=
                callback === auditAnimationCallback ? duration : 0;
              measurement.callbacks += 1;
              measurement.duration += duration;
              measurement.durations.push(duration);
              if (callback !== auditAnimationCallback && duration > 8) {
                animationCallbackOutliers.push({
                  duration,
                  elapsed: performance.now() - rapidStarted,
                  name: callback.name,
                  scrollTop: timeline.scrollTop,
                  source: String(callback).slice(0, 240),
                  timestamp,
                });
              }
            }
          });
        const longTasks = [];
        const observer = PerformanceObserver.supportedEntryTypes?.includes("longtask")
          ? new PerformanceObserver((list) => {
              longTasks.push(...list.getEntries().map((entry) => entry.duration));
            })
          : null;
        observer?.observe({ type: "longtask" });
        const rapidStarted = performance.now();
        let previousFrame = rapidStarted;
        let deferredBodyFrames = 0;
        let visibleDeferredBodyFrames = 0;
        let maximumVisibleDeferredBodies = 0;
        let legacyPlaceholderFrames = 0;
        let missingSummaryFrames = 0;
        let visibleEmptyActivityListFrames = 0;
        let maximumVisibleEmptyActivityLists = 0;
        const visibleEmptyActivityListSamples = [];
        const rapidFrameOutliers = [];
        let consecutiveSummaryComparisons = 0;
        let summaryIdentityChanges = 0;
        let previousSummariesByKey = new Map();
        const inspectVisibleActivityCoverage = (phaseLabel, timelineBounds) => {
          let emptyLists = 0;
          for (const list of document.querySelectorAll(".agent-activity-virtual-list")) {
            if (!(list instanceof HTMLElement)) {
              continue;
            }
            const total = Number(list.getAttribute("data-virtual-activity-total") ?? 0);
            const listBounds = list.getBoundingClientRect();
            const visibleTop = Math.max(timelineBounds.top, listBounds.top);
            const visibleBottom = Math.min(timelineBounds.bottom, listBounds.bottom);
            if (total <= 0 || visibleBottom - visibleTop <= 2) {
              continue;
            }
            const mountedCount = Number(
              list.getAttribute("data-virtual-activity-count") ?? 0,
            );
            const visibleItem = [...list.querySelectorAll(".agent-activity-virtual-item")].some(
              (item) => {
                const bounds = item.getBoundingClientRect();
                return bounds.bottom > visibleTop + 1 && bounds.top < visibleBottom - 1;
              },
            );
            if (mountedCount > 0 && visibleItem) {
              continue;
            }
            emptyLists += 1;
            if (visibleEmptyActivityListSamples.length < 12) {
              visibleEmptyActivityListSamples.push({
                listBottom: listBounds.bottom,
                listTop: listBounds.top,
                mountedCount,
                phase: phaseLabel,
                scrollTop: timeline.scrollTop,
                total,
                visibleBottom,
                visibleTop,
              });
            }
          }
          visibleEmptyActivityListFrames += emptyLists === 0 ? 0 : 1;
          maximumVisibleEmptyActivityLists = Math.max(
            maximumVisibleEmptyActivityLists,
            emptyLists,
          );
        };
        await new Promise((resolve) => {
          const tick = (now) => {
            const frameInterval = now - previousFrame;
            frameIntervals.push(frameInterval);
            previousFrame = now;
            const maximum = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
            const phase = ((now - rapidStarted) % 700) / 700;
            const mountedWrappers = document.querySelectorAll(".agent-activity-virtual-item");
            const mountedItems = mountedWrappers.length;
            let mountedSummaries = 0;
            const currentSummariesByKey = new Map();
            for (const wrapper of mountedWrappers) {
              const key = wrapper.getAttribute("data-virtual-activity-key");
              const summary = wrapper.querySelector("summary");
              if (key === null || !(summary instanceof HTMLElement)) {
                continue;
              }
              mountedSummaries += 1;
              const previousSummary = previousSummariesByKey.get(key);
              if (previousSummary !== undefined) {
                consecutiveSummaryComparisons += 1;
                summaryIdentityChanges += previousSummary === summary ? 0 : 1;
              }
              currentSummariesByKey.set(key, summary);
            }
            previousSummariesByKey = currentSummariesByKey;
            const deferredBodyElements = document.querySelectorAll(
              '[data-activity-content="deferred"]',
            );
            const deferredBodies = deferredBodyElements.length;
            const timelineBounds = timeline.getBoundingClientRect();
            inspectVisibleActivityCoverage("rapid", timelineBounds);
            const visibleDeferredBodies = [...deferredBodyElements].filter((element) => {
              const bounds = element.getBoundingClientRect();
              return bounds.bottom > timelineBounds.top && bounds.top < timelineBounds.bottom;
            }).length;
            deferredBodyFrames += deferredBodies === 0 ? 0 : 1;
            visibleDeferredBodyFrames += visibleDeferredBodies === 0 ? 0 : 1;
            maximumVisibleDeferredBodies = Math.max(
              maximumVisibleDeferredBodies,
              visibleDeferredBodies,
            );
            legacyPlaceholderFrames +=
              document.querySelector(".agent-activity-scroll-placeholder") === null ? 0 : 1;
            missingSummaryFrames += mountedSummaries < mountedItems ? 1 : 0;
            if (frameInterval > 20 && rapidFrameOutliers.length < 20) {
              rapidFrameOutliers.push({
                deferredBodies,
                diffRows: document.querySelectorAll(".diff-virtual-row").length,
                visibleDeferredBodies,
                frame: frameIntervals.length - 1,
                intervalMs: frameInterval,
                mountedItems,
                phase,
                sourceRows: document.querySelectorAll(".tool-source-line").length,
              });
            }
            timeline.scrollTop = phase <= 0.5
              ? maximum * phase * 2
              : maximum * (2 - phase * 2);
            if (now - rapidStarted >= 1400) {
              resolve();
            } else {
              requestAnimationFrame(tick);
            }
          };
          auditAnimationCallback = tick;
          requestAnimationFrame(tick);
        });
        window.requestAnimationFrame = nativeRequestAnimationFrame;
        observer?.disconnect();
        const rapidElapsed = performance.now() - rapidStarted;
        const sortedFrames = frameIntervals.slice(1).sort((left, right) => left - right);
        const sortedAnimationWork = [...animationWorkByFrame.values()]
          .map((measurement) => measurement.duration)
          .sort((left, right) => left - right);
        const sortedApplicationAnimationWork = [...animationWorkByFrame.values()]
          .map((measurement) => measurement.applicationDuration)
          .sort((left, right) => left - right);
        const sortedAuditAnimationWork = [...animationWorkByFrame.values()]
          .map((measurement) => measurement.auditDuration)
          .sort((left, right) => left - right);
        const animationCallbackRanks = [0, 1, 2].map((rank) =>
          [...animationWorkByFrame.values()]
            .map(
              (measurement) =>
                measurement.durations.slice().sort((left, right) => right - left)[rank] ?? 0,
            )
            .sort((left, right) => left - right),
        );
        const percentile = (values, percentileValue) =>
          values[Math.min(values.length - 1, Math.floor(values.length * percentileValue))] ?? 0;
        const reversalTargets = [0.94, 0.08, 0.86, 0.14, 0.78, 0.22, 0.7, 0.3, 0.62, 0.38];
        for (const ratio of reversalTargets) {
          const maximum = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
          timeline.scrollTop = maximum * ratio;
          await frame();
          await frame();
          inspectVisibleActivityCoverage(
            "rapid-reversal-" + ratio,
            timeline.getBoundingClientRect(),
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
        window.__timelineStressProgress = { phase: "rapid-scroll-complete" };

        let iconIntegrityComparisons = 0;
        let iconIntegrityFailures = 0;
        const iconIntegrityKinds = new Set();
        const iconIntegritySamples = [];
        const iconCorrectnessStarted = performance.now();
        await new Promise((resolve) => {
          const inspectIcons = (now) => {
            for (const summary of document.querySelectorAll(
              ".tool-activity-card > .activity-summary, .tool-activity-card.tool-activity-row",
            )) {
              const title = summary.querySelector(".activity-title-base")?.textContent ?? "";
              const toolLabel =
                summary.closest(".tool-activity-card")?.querySelector(".command-card-header")
                  ?.textContent ?? "";
              const icon = summary.querySelector(":scope > .activity-icon svg");
              const expectedKind =
                toolLabel === "Leitura de arquivo" || title.includes("leitura de arquivo")
                ? "read"
                : toolLabel === "Busca no projeto" || title.includes("Search ")
                  ? "search"
                  : null;
              if (expectedKind === null || !(icon instanceof SVGSVGElement)) {
                continue;
              }
              iconIntegrityComparisons += 1;
              iconIntegrityKinds.add(expectedKind);
              const valid =
                expectedKind === "read"
                  ? icon.getAttribute("fill") === "currentColor" &&
                    icon.getAttribute("stroke") === "none" &&
                    icon.getAttribute("viewBox") === "0 0 20 20" &&
                    icon.querySelectorAll(":scope > path").length === 1 &&
                    icon.querySelector(":scope > circle") === null
                  : icon.getAttribute("fill") === "none" &&
                    icon.getAttribute("stroke") === "currentColor" &&
                    icon.getAttribute("viewBox") === "0 0 24 24" &&
                    icon.querySelectorAll(":scope > path").length === 1 &&
                    icon.querySelectorAll(":scope > circle").length === 1;
              if (!valid) {
                iconIntegrityFailures += 1;
                if (iconIntegritySamples.length < 5) {
                  iconIntegritySamples.push({ expectedKind, markup: icon.outerHTML, title });
                }
              }
            }
            const maximum = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
            const phase = ((now - iconCorrectnessStarted) % 500) / 500;
            timeline.scrollTop = phase <= 0.5
              ? maximum * phase * 2
              : maximum * (2 - phase * 2);
            if (now - iconCorrectnessStarted >= 1000) {
              resolve();
            } else {
              requestAnimationFrame(inspectIcons);
            }
          };
          requestAnimationFrame(inspectIcons);
        });

        const lightButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Chat leve de controle"),
        );
        lightButton?.click();
        window.__timelineStressProgress = { phase: "opening-light-thread" };
        await waitUntil(
          "o chat leve de controle",
          () => document.body.textContent?.includes("Chat de controle pronto."),
          3000,
        );
        const reopenStarted = performance.now();
        const reopenButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Estresse de timeline expandida"),
        );
        reopenButton?.click();
        window.__timelineStressProgress = { phase: "reopening-stress-thread" };
        await waitUntil(
          "a reabertura da lista virtualizada",
          () =>
            document.querySelector(".agent-activity-group[open]") !== null &&
            document.querySelector(".agent-activity-virtual-item") !== null,
          5000,
        );
        await frame();
        await frame();
        const reopenMs = performance.now() - reopenStarted;
        await new Promise((resolve) => setTimeout(resolve, 120));
        window.__timelineStressProgress = { phase: "stress-thread-restored", reopenMs };

        const restoredTimeline = document.querySelector(".timeline");
        if (!(restoredTimeline instanceof HTMLElement)) {
          throw new Error("A timeline restaurada está ausente.");
        }
        for (let attempt = 0; attempt < 5; attempt += 1) {
          restoredTimeline.dispatchEvent(
            new WheelEvent("wheel", {
              bubbles: true,
              cancelable: true,
              deltaMode: 0,
              deltaY: -1,
            }),
          );
          restoredTimeline.scrollTop = 0;
          await new Promise((resolve) => setTimeout(resolve, 180));
          await frame();
          await frame();
          if (restoredTimeline.scrollTop <= 1) {
            break;
          }
        }
        if (restoredTimeline.scrollTop > 1) {
          throw new Error(
            "A timeline não liberou o ownership manual no topo (scrollTop=" +
              restoredTimeline.scrollTop +
              ").",
          );
        }
        const timelineTop = restoredTimeline.getBoundingClientRect().top;
        const topWrappers = [...document.querySelectorAll(".agent-activity-virtual-item")];
        const sourceAtTop = topWrappers.find(
          (element) => element.querySelector("details[open] > summary") !== null,
        );
        const sourceBottom = sourceAtTop?.getBoundingClientRect().bottom;
        const targetAtTop =
          sourceBottom === undefined
            ? undefined
            : topWrappers.find((element) => {
                const distance = element.getBoundingClientRect().top - sourceBottom;
                return distance >= 160 && distance <= restoredTimeline.clientHeight - 20;
              });
        const sourceKey = sourceAtTop?.getAttribute("data-virtual-activity-key") ?? null;
        const targetKey = targetAtTop?.getAttribute("data-virtual-activity-key") ?? null;
        if (
          !(sourceAtTop instanceof HTMLElement) ||
          !(targetAtTop instanceof HTMLElement) ||
          sourceBottom === undefined ||
          sourceKey === null ||
          targetKey === null
        ) {
          throw new Error(
            "As chaves da âncora não foram materializadas no topo: " +
              JSON.stringify({
                sourceKey,
                targetKey,
                wrappers: topWrappers.map((element) => ({
                  key: element.getAttribute("data-virtual-activity-key"),
                  open: element.querySelector("details[open]") !== null,
                  top: element.getBoundingClientRect().top,
                })),
              }),
          );
        }
        let visualDriftPx = null;
        {
          restoredTimeline.scrollTop = Math.min(
            restoredTimeline.scrollHeight - restoredTimeline.clientHeight,
            restoredTimeline.scrollTop + sourceBottom - timelineTop + 60,
          );
          await new Promise((resolve) => setTimeout(resolve, 180));
          await frame();
          await frame();
          const positionedWrappers = [...document.querySelectorAll(
            ".agent-activity-virtual-item",
          )];
          const source = positionedWrappers.find(
            (element) => element.getAttribute("data-virtual-activity-key") === sourceKey,
          );
          const target = positionedWrappers.find(
            (element) => element.getAttribute("data-virtual-activity-key") === targetKey,
          );
          if (!(source instanceof HTMLElement) || !(target instanceof HTMLElement)) {
            throw new Error("A virtualização substituiu a âncora posicionada antes da medição.");
          }
          const targetTop = target.getBoundingClientRect().top;
          source.querySelector("details[open] > summary")?.click();
          await new Promise((resolve) => setTimeout(resolve, 250));
          await frame();
          await frame();
          const currentTarget = [...document.querySelectorAll(
            ".agent-activity-virtual-item",
          )].find((element) => element.getAttribute("data-virtual-activity-key") === targetKey);
          if (!(currentTarget instanceof HTMLElement)) {
            throw new Error("A âncora-alvo deixou de ser materializada após o colapso.");
          }
          visualDriftPx = currentTarget.getBoundingClientRect().top - targetTop;
        }
        const diffViewportIntegrity = [...document.querySelectorAll(".diff-viewport")].map(
          (viewport) => {
            const rows = [...viewport.querySelectorAll(".diff-virtual-row")];
            const rowTops = rows.map((row) => row.getBoundingClientRect().top);
            const canvas = viewport.querySelector(".diff-virtual-canvas");
            return {
              canvasConnected:
                canvas instanceof HTMLElement &&
                canvas.isConnected &&
                canvas.parentElement?.classList.contains("diff-virtual-table") === true,
              canvasHeight:
                canvas instanceof HTMLElement ? canvas.getBoundingClientRect().height : null,
              clientHeight: viewport.clientHeight,
              declaredRows: Number(
                viewport.querySelector(".diff-virtual-table")?.getAttribute("aria-rowcount") ??
                  Number.NaN,
              ),
              mountedRows: rows.length,
              rowGaps: rowTops.slice(1).map((top, index) => top - (rowTops[index] ?? top)),
              scrollHeight: viewport.scrollHeight,
            };
          },
        );

        window.__timelinePerformanceStressMetrics = {
          visitedItems: visited.size,
          expansionBoundaryPasses: boundaryPasses,
          expansionIterations: iterations,
          expansionMs,
          rapidFrames: sortedFrames.length,
          rapidElapsedMs: rapidElapsed,
          rapidAverageFps: sortedFrames.length / (rapidElapsed / 1000),
          rapidMedianFrameMs: percentile(sortedFrames, 0.5),
          rapidP95FrameMs: percentile(sortedFrames, 0.95),
          rapidP99FrameMs: percentile(sortedFrames, 0.99),
          rapidMaximumFrameMs: sortedFrames.at(-1) ?? 0,
          rapidAnimationWorkFrames: sortedAnimationWork.length,
          rapidAnimationCallbacks: [...animationWorkByFrame.values()].reduce(
            (total, measurement) => total + measurement.callbacks,
            0,
          ),
          rapidMedianAnimationWorkMs: percentile(sortedAnimationWork, 0.5),
          rapidP95AnimationWorkMs: percentile(sortedAnimationWork, 0.95),
          rapidP99AnimationWorkMs: percentile(sortedAnimationWork, 0.99),
          rapidMaximumAnimationWorkMs: sortedAnimationWork.at(-1) ?? 0,
          rapidP95ApplicationAnimationWorkMs: percentile(sortedApplicationAnimationWork, 0.95),
          rapidP99ApplicationAnimationWorkMs: percentile(sortedApplicationAnimationWork, 0.99),
          rapidMaximumApplicationAnimationWorkMs: sortedApplicationAnimationWork.at(-1) ?? 0,
          rapidAnimationCallbackOutliers: animationCallbackOutliers,
          rapidP95AuditAnimationWorkMs: percentile(sortedAuditAnimationWork, 0.95),
          rapidP95AnimationCallbackRanksMs: animationCallbackRanks.map((durations) =>
            percentile(durations, 0.95),
          ),
          rapidFramesOver20Ms: sortedFrames.filter((value) => value > 20).length,
          rapidFramesOver34Ms: sortedFrames.filter((value) => value > 34).length,
          rapidLongTasks: longTasks.length,
          rapidLongTaskTotalMs: longTasks.reduce((total, value) => total + value, 0),
          rapidFrameOutliers,
          deferredBodyFrames,
          visibleDeferredBodyFrames,
          maximumVisibleDeferredBodies,
          legacyPlaceholderFrames,
          missingSummaryFrames,
          visibleEmptyActivityListFrames,
          maximumVisibleEmptyActivityLists,
          visibleEmptyActivityListSamples,
          consecutiveSummaryComparisons,
          summaryIdentityChanges,
          iconIntegrityComparisons,
          iconIntegrityFailures,
          iconIntegrityKinds: [...iconIntegrityKinds].sort(),
          iconIntegritySamples,
          reopenMs,
          visualDriftPx,
          domNodes: document.getElementsByTagName("*").length,
          mountedActivityItems: document.querySelectorAll(".agent-activity-virtual-item").length,
          mountedSourceRows: document.querySelectorAll(".tool-source-line").length,
          mountedDiffRows: document.querySelectorAll(".diff-virtual-row").length,
          diffViewportIntegrity,
          settledDeferredBodies: document.querySelectorAll(
            '[data-activity-content="deferred"]',
          ).length,
          settledLegacyPlaceholders: document.querySelectorAll(
            ".agent-activity-scroll-placeholder",
          ).length,
          horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
        };
      } catch (error) {
        window.__timelinePerformanceStressError =
          error instanceof Error ? error.stack ?? error.message : String(error);
      } finally {
        window.__timelinePerformanceStressReady = true;
      }
    })();
  })()`;
}

function activityReconciliationPrepareExpression() {
  return `(() => {
    void (async () => {
      try {
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const waitUntil = async (label, predicate, timeoutMs) => {
          const deadline = performance.now() + timeoutMs;
          while (!predicate()) {
            if (performance.now() > deadline) {
              throw new Error("Tempo esgotado preparando " + label + ".");
            }
            await frame();
          }
        };
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Reconciliação de comandos paralelos"),
        );
        threadButton?.click();
        await waitUntil(
          "o turno de reconciliação",
          () => document.querySelector(".conversation-turn") !== null,
          3000,
        );
        document.querySelector('button[aria-label="Mostrar trabalho do agente"]')?.click();
        await waitUntil(
          "o grupo inicial de comandos",
          () => document.querySelector(".agent-activity-group > summary") !== null,
          3000,
        );
        document.querySelector(".agent-activity-group:not([open]) > summary")?.click();
        await waitUntil(
          "a lista montada de comandos",
          () => document.querySelector(".agent-activity-virtual-item") !== null,
          3000,
        );
        await waitUntil(
          "a conclusão fora de ordem dos comandos",
          () => document.documentElement.dataset.activityReconciliationState === "completed",
          10000,
        );
        document.querySelector('button[aria-label="Mostrar trabalho do agente"]')?.click();
        await frame();
        document.querySelector(".agent-activity-group:not([open]) > summary")?.click();
        await frame();
        await frame();
      } catch (error) {
        window.__activityReconciliationError =
          error instanceof Error ? error.stack ?? error.message : String(error);
      } finally {
        window.__activityReconciliationReady = true;
      }
    })();
  })()`;
}

function activityShimmerPrepareExpression() {
  return `(() => {
    void (async () => {
      try {
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const waitUntil = async (label, predicate, timeoutMs) => {
          const deadline = performance.now() + timeoutMs;
          while (!predicate()) {
            if (performance.now() > deadline) {
              throw new Error("Tempo esgotado aguardando " + label + ".");
            }
            await frame();
          }
        };
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Inspecionar janela de contexto"),
        );
        threadButton?.click();
        await waitUntil(
          "o título de comando em execução",
          () => document.querySelector(".command-activity-card .activity-title.is-running") !== null,
          3000,
        );
        const title = document.querySelector(
          ".command-activity-card .activity-title.is-running",
        );
        if (!(title instanceof HTMLElement)) {
          throw new Error("O título animado do comando não foi encontrado.");
        }
        const isActive = () => title.classList.contains("is-shimmer-active");
        if (isActive()) {
          await waitUntil("o fim do pulso já iniciado", () => !isActive(), 2500);
        }
        await waitUntil("o início do primeiro pulso", isActive, 5000);
        const firstStartedAt = performance.now();
        const sweep = title.querySelector(".activity-title-sweep");
        if (!(sweep instanceof HTMLElement)) {
          throw new Error("A camada visual do shimmer não foi encontrada.");
        }
        const activeStyle = getComputedStyle(sweep);
        const activeAnimation = {
          duration: activeStyle.animationDuration,
          iterationCount: activeStyle.animationIterationCount,
          name: activeStyle.animationName,
          timingFunction: activeStyle.animationTimingFunction,
        };
        await waitUntil("o fim do primeiro pulso", () => !isActive(), 2500);
        const firstFinishedAt = performance.now();
        const inactiveAnimationName = getComputedStyle(sweep).animationName;
        await waitUntil("o início do segundo pulso", isActive, 5000);
        const secondStartedAt = performance.now();
        window.__activityShimmerMetrics = {
          activeDurationMs: firstFinishedAt - firstStartedAt,
          cadenceMs: secondStartedAt - firstStartedAt,
          activeAnimation,
          inactiveAnimationName,
          titleText: title.textContent?.trim() ?? "",
        };
      } catch (error) {
        window.__activityShimmerError =
          error instanceof Error ? error.stack ?? error.message : String(error);
      } finally {
        window.__activityShimmerReady = true;
      }
    })();
  })()`;
}

function activityShimmerAuditExpression() {
  return `(() => {
    if (window.__activityShimmerError !== undefined) {
      throw new Error(window.__activityShimmerError);
    }
    if (window.__activityShimmerMetrics === undefined) {
      throw new Error("As métricas temporais do shimmer estão ausentes.");
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      ...window.__activityShimmerMetrics,
      activeTargets: document.querySelectorAll(
        ".activity-title.is-running.is-shimmer-active",
      ).length,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`;
}

function timelinePerformanceStressAuditExpression() {
  return `(() => {
    if (window.__timelinePerformanceStressError !== undefined) {
      throw new Error(window.__timelinePerformanceStressError);
    }
    if (window.__timelinePerformanceStressMetrics === undefined) {
      throw new Error("As métricas de estresse da timeline estão ausentes.");
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      ...window.__timelinePerformanceStressMetrics,
    };
  })()`;
}

function activityReconciliationAuditExpression() {
  return `(() => {
    if (window.__activityReconciliationError !== undefined) {
      throw new Error(window.__activityReconciliationError);
    }
    const root = document.documentElement;
    const virtualList = document.querySelector(".agent-activity-virtual-list");
    const mountedKeys = [...document.querySelectorAll(
      ".agent-activity-virtual-item[data-virtual-activity-key]",
    )].map((element) => element.getAttribute("data-virtual-activity-key"));
    const activityGroup = document.querySelector(".agent-activity-group");
    const newerCommentary = [...document.querySelectorAll(".commentary")].find(
      (element) =>
        element.textContent?.includes(
          "Mensagem mais recente preservada depois dos comandos antigos.",
        ),
    );
    return {
      viewport: { width: innerWidth, height: innerHeight },
      state: root.dataset.activityReconciliationState ?? null,
      started: Number(root.dataset.activityReconciliationStarted ?? Number.NaN),
      completed: Number(root.dataset.activityReconciliationCompleted ?? Number.NaN),
      commentaryState: root.dataset.activityReconciliationCommentary ?? null,
      durationMs: Number(root.dataset.activityReconciliationDurationMs ?? Number.NaN),
      identityComparisons: Number(
        root.dataset.activityReconciliationIdentityComparisons ?? Number.NaN,
      ),
      identityChanges: Number(root.dataset.activityReconciliationIdentityChanges ?? Number.NaN),
      commentaryCount: document.querySelectorAll(".commentary").length,
      causalOrderPreserved:
        activityGroup !== null &&
        newerCommentary !== undefined &&
        Boolean(
          activityGroup.compareDocumentPosition(newerCommentary) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      turnFailures: document.querySelectorAll(".turn-failure").length,
      totalActivities: Number(
        virtualList?.getAttribute("data-virtual-activity-total") ?? Number.NaN,
      ),
      mountedActivities: mountedKeys.length,
      uniqueMountedActivities: new Set(mountedKeys).size,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`;
}

function composerFastModeVisualAuditExpression() {
  return `(() => {
    const rectangle = (element, label) => {
      if (!(element instanceof HTMLElement)) {
        throw new Error("Elemento ausente: " + label);
      }
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
        display: style.display,
        visibility: style.visibility,
        fontSize: style.fontSize,
      };
    };
    const chromeElement = document.querySelector(".window-chrome");
    const contentElement = document.querySelector(".application-frame-content");
    const controlsElement = document.querySelector(".window-chrome-controls");
    const indicatorElement = document.querySelector(".model-speed-indicator");
    const buttonElement = indicatorElement?.closest(".model-button");
    const nameElement = buttonElement?.querySelector(".model-button-name");
    const fullAccessElement = document.querySelector(".permission-button.elevated");
    const coloredProjectIcon = document.querySelector(".project-icon-slot[style]");
    const rootStyle = getComputedStyle(document.documentElement);
    const chrome = rectangle(chromeElement, ".window-chrome");
    const content = rectangle(contentElement, ".application-frame-content");
    const controls = rectangle(controlsElement, ".window-chrome-controls");
    const indicator = rectangle(indicatorElement, ".model-speed-indicator");
    const button = rectangle(buttonElement, ".model-button");
    const name = rectangle(nameElement, ".model-button-name");
    return {
      viewport: { width: innerWidth, height: innerHeight },
      chrome,
      content,
      controls,
      indicator,
      button,
      name,
      indicatorCount: document.querySelectorAll(".model-speed-indicator").length,
      accessibleLabel: buttonElement?.textContent?.includes("Modo rápido ativo") === true,
      fullAccessColor:
        fullAccessElement instanceof HTMLElement ? getComputedStyle(fullAccessElement).color : null,
      projectIconColor:
        coloredProjectIcon instanceof HTMLElement ? getComputedStyle(coloredProjectIcon).color : null,
      diffAddedColor: rootStyle.getPropertyValue("--diff-added-foreground").trim(),
      diffDeletedColor: rootStyle.getPropertyValue("--diff-deleted-foreground").trim(),
      buttonHorizontalOverflow:
        buttonElement instanceof HTMLElement
          ? buttonElement.scrollWidth - buttonElement.clientWidth
          : null,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`;
}

function activeActivityReflectionVisualAuditExpression() {
  return `(() => {
    const title = document.querySelector(".activity-title.is-running");
    const base = title?.querySelector(".activity-title-base");
    const sweep = title?.querySelector(".activity-title-sweep");
    const highlight = sweep?.querySelector(".activity-title-highlight");
    if (
      !(title instanceof HTMLElement) ||
      !(base instanceof HTMLElement) ||
      !(sweep instanceof HTMLElement) ||
      !(highlight instanceof HTMLElement)
    ) {
      throw new Error("As camadas da atividade animada estão ausentes.");
    }
    const sidebarList = [...document.querySelectorAll(".sidebar-item-list")].find(
      (list) => list.children.length > 1,
    );
    const sidebarItems = sidebarList === undefined ? [] : [...sidebarList.children];
    const sidebarItemGaps = sidebarItems.slice(1).map((item, index) => {
      const previous = sidebarItems[index];
      return previous === undefined
        ? null
        : item.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
    });
    const selectedThread = document.querySelector(".thread-row.active");
    const selectedThreadStyle =
      selectedThread instanceof HTMLElement ? getComputedStyle(selectedThread) : null;
    const completedTitle =
      [...document.querySelectorAll(".activity-title:not(.is-running)")].find(
        (element) => /(?:Editou|Leu|leu) arquivos/u.test(element.textContent ?? ""),
      ) ?? document.querySelector(".activity-title:not(.is-running):not(.compaction-text)");
    if (!(completedTitle instanceof HTMLElement)) {
      throw new Error("Uma atividade concluída de referência está ausente.");
    }
    const titleStyle = getComputedStyle(title);
    const completedTitleStyle = getComputedStyle(completedTitle);
    const sweepStyle = getComputedStyle(sweep);
    const highlightStyle = getComputedStyle(highlight);
    const sweepAnimation = sweep.getAnimations().find(
      (animation) => animation.animationName === "activity-reflection-sweep",
    );
    const highlightAnimation = highlight.getAnimations().find(
      (animation) => animation.animationName === "activity-reflection-text",
    );
    const timing = sweepAnimation?.effect?.getTiming();
    const duration = Number(timing?.duration);
    const delay = Number(timing?.delay);
    const passPositions = [];
    const pausePositions = [];
    let alignmentError = null;
    if (
      sweepAnimation !== undefined &&
      highlightAnimation !== undefined &&
      Number.isFinite(duration) &&
      Number.isFinite(delay)
    ) {
      sweepAnimation.pause();
      highlightAnimation.pause();
      for (const fraction of [0.05, 0.2]) {
        const sampleTime = delay + duration * fraction;
        sweepAnimation.currentTime = sampleTime;
        highlightAnimation.currentTime = sampleTime;
        passPositions.push(getComputedStyle(sweep).transform);
      }
      for (const fraction of [0.25, 0.5, 0.9]) {
        const sampleTime = delay + duration * fraction;
        sweepAnimation.currentTime = sampleTime;
        highlightAnimation.currentTime = sampleTime;
        pausePositions.push(getComputedStyle(sweep).transform);
      }
      const screenshotTime = delay + duration * 0.12;
      sweepAnimation.currentTime = screenshotTime;
      highlightAnimation.currentTime = screenshotTime;
      const baseBounds = base.getBoundingClientRect();
      const highlightBounds = highlight.getBoundingClientRect();
      alignmentError = Math.max(
        Math.abs(baseBounds.top - highlightBounds.top),
        Math.abs(baseBounds.right - highlightBounds.right),
        Math.abs(baseBounds.bottom - highlightBounds.bottom),
        Math.abs(baseBounds.left - highlightBounds.left),
      );
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      titleText: title.textContent?.trim() ?? null,
      baseText: base.textContent?.trim() ?? null,
      highlightText: highlight.textContent?.trim() ?? null,
      titleColor: titleStyle.color,
      titleFontWeight: titleStyle.fontWeight,
      titleFontSize: titleStyle.fontSize,
      titleDisplay: titleStyle.display,
      completedTitleText: completedTitle.textContent?.trim() ?? null,
      completedTitleColor: completedTitleStyle.color,
      completedTitleFontWeight: completedTitleStyle.fontWeight,
      highlightColor: highlightStyle.color,
      sweepLayerCount: title.querySelectorAll(".activity-title-sweep").length,
      highlightLayerCount: title.querySelectorAll(".activity-title-highlight").length,
      obsoleteLayerCount: title.querySelectorAll(
        ".activity-title-wave, .activity-title-reflection",
      ).length,
      sweepAnimationName: sweepStyle.animationName,
      highlightAnimationName: highlightStyle.animationName,
      animationDuration: sweepStyle.animationDuration,
      animationDelay: sweepStyle.animationDelay,
      animationTimingFunction: sweepStyle.animationTimingFunction,
      animationIterationCount: sweepStyle.animationIterationCount,
      keyframeEasings:
        sweepAnimation?.effect?.getKeyframes().map((keyframe) => keyframe.easing) ?? [],
      maskImage: sweepStyle.maskImage || sweepStyle.webkitMaskImage,
      passPositions,
      pausePositions,
      alignmentError,
      sidebarItemGaps,
      selectedThreadBackground: selectedThreadStyle?.backgroundColor ?? null,
      selectedThreadBoxShadow: selectedThreadStyle?.boxShadow ?? null,
      planExplanationCount: document.querySelectorAll(".plan-progress-explanation").length,
      ariaHidden: sweep.getAttribute("aria-hidden"),
      pointerEvents: sweepStyle.pointerEvents,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`;
}

function userMessageNavigationVisualAuditExpression() {
  return `(() => {
    const timeline = document.querySelector(".timeline");
    const target = document.getElementById("user-message-preview-image-user-message");
    const targetTurn = target?.closest(".timeline-virtual-item");
    const marker = document.querySelectorAll(".user-message-navigator button")[2];
    const activeTurn = [...document.querySelectorAll(".conversation-turn")].at(-1);
    if (
      !(timeline instanceof HTMLElement) ||
      !(target instanceof HTMLElement) ||
      !(targetTurn instanceof HTMLElement) ||
      !(marker instanceof HTMLButtonElement) ||
      !(activeTurn instanceof HTMLElement)
    ) {
      throw new Error("Âncora da terceira mensagem do usuário está ausente.");
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      targetGap:
        target.getBoundingClientRect().top - timeline.getBoundingClientRect().top,
      targetOffsetWithinTurn:
        target.getBoundingClientRect().top - targetTurn.getBoundingClientRect().top,
      markerCurrent: marker.getAttribute("aria-current"),
      expandedGroupCount: activeTurn.querySelectorAll(".agent-activity-group[open]").length,
      scrollTop: timeline.scrollTop,
      maximumScroll: timeline.scrollHeight - timeline.clientHeight,
      expectedTargetGap: (() => {
        const targetOffset =
          timeline.scrollTop +
          target.getBoundingClientRect().top -
          timeline.getBoundingClientRect().top;
        const expectedScroll = Math.min(
          timeline.scrollHeight - timeline.clientHeight,
          Math.max(0, targetOffset - 32),
        );
        return targetOffset - expectedScroll;
      })(),
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`;
}

function manualScrollOwnershipVisualAuditExpression() {
  return `(() => {
    if (window.__previewManualScrollError !== undefined) {
      throw new Error(window.__previewManualScrollError);
    }
    const timeline = document.querySelector(".timeline");
    const state = window.__previewManualScrollState;
    if (!(timeline instanceof HTMLElement) || state === undefined) {
      throw new Error("Cenário de ownership do scroll não foi inicializado.");
    }
    const first = document.querySelector(
      '.timeline-virtual-item[data-virtual-turn-id="' + state.firstId + '"]',
    );
    const anchor = document.querySelector(
      '.timeline-virtual-item[data-virtual-turn-id="' + state.anchorId + '"]',
    );
    if (!(first instanceof HTMLElement) || !(anchor instanceof HTMLElement)) {
      throw new Error("Os itens de referência do scroll manual foram desmontados.");
    }
    const finalAnchorGap =
      anchor.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
    const heightDelta = first.getBoundingClientRect().height - state.beforeItemHeight;
    const scrollCompensation = timeline.scrollTop - state.beforeScrollTop;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      beforeScrollTop: state.beforeScrollTop,
      finalScrollTop: timeline.scrollTop,
      heightDelta,
      scrollCompensation,
      compensationError: scrollCompensation - heightDelta,
      visualDrift: finalAnchorGap - state.beforeAnchorGap,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`;
}

function nestedScrollHandoffVisualAuditExpression() {
  return `(() => {
    if (window.__previewNestedScrollError !== undefined) {
      throw new Error(window.__previewNestedScrollError);
    }
    const metrics = window.__previewNestedScrollMetrics;
    if (metrics === undefined) {
      throw new Error("Cenário de transferência do scroll aninhado não foi inicializado.");
    }
    return {
      ...metrics,
      viewport: { width: innerWidth, height: innerHeight },
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`;
}

function nestedScrollWheelOwnershipAuditExpression() {
  return `(() => {
    if (window.__previewNestedWheelError !== undefined) {
      throw new Error(window.__previewNestedWheelError);
    }
    const metrics = window.__previewNestedWheelMetrics;
    if (metrics === undefined) {
      throw new Error("Cenário de wheel nativo em arquivos expandidos não foi inicializado.");
    }
    return {
      ...metrics,
      viewport: { width: innerWidth, height: innerHeight },
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`;
}

function nestedScrollFollowingVisualAuditExpression() {
  return `(() => {
    if (window.__previewNestedFollowError !== undefined) {
      throw new Error(window.__previewNestedFollowError);
    }
    const metrics = window.__previewNestedFollowMetrics;
    if (metrics === undefined) {
      throw new Error("Cenário de acompanhamento após scroll interno não foi inicializado.");
    }
    return {
      ...metrics,
      viewport: { width: innerWidth, height: innerHeight },
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`;
}

function timelineExtremeFilesPrepareExpression() {
  return `(() => {
    void (async () => {
      try {
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const waitUntil = async (label, predicate, timeoutMs) => {
          const deadline = performance.now() + timeoutMs;
          while (!predicate()) {
            if (performance.now() > deadline) {
              throw new Error("Tempo esgotado preparando " + label + ".");
            }
            await frame();
          }
        };
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Estresse de 100000 arquivos"),
        );
        threadButton?.click();
        await waitUntil(
          "o turno com 100 mil arquivos",
          () => document.querySelector(".conversation-turn") !== null,
          5000,
        );
        document.querySelector('button[aria-label="Mostrar trabalho do agente"]')?.click();
        await frame();
        document.querySelector(".agent-activity-group:not([open]) > summary")?.click();
        await waitUntil(
          "a lista virtual de 100 mil arquivos",
          () =>
            document.querySelector(".agent-activity-virtual-list")?.getAttribute(
              "data-virtual-activity-total",
            ) === "100000",
          10_000,
        );
        await frame();
        await frame();
        const timeline = document.querySelector(".timeline");
        if (!(timeline instanceof HTMLElement)) {
          throw new Error("A timeline extrema está ausente.");
        }

        const frameIntervals = [];
        const animationWorkByFrame = new Map();
        const animationCallbackOutliers = [];
        let auditAnimationCallback = null;
        const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
        window.requestAnimationFrame = (callback) =>
          nativeRequestAnimationFrame((timestamp) => {
            const started = performance.now();
            try {
              callback(timestamp);
            } finally {
              const duration = performance.now() - started;
              let measurement = animationWorkByFrame.get(timestamp);
              if (measurement === undefined) {
                measurement = { applicationDuration: 0, duration: 0 };
                animationWorkByFrame.set(timestamp, measurement);
              }
              measurement.applicationDuration +=
                callback === auditAnimationCallback ? 0 : duration;
              measurement.duration += duration;
              if (callback !== auditAnimationCallback && duration > 8) {
                animationCallbackOutliers.push({
                  duration,
                  elapsed: performance.now() - rapidStarted,
                  name: callback.name,
                  scrollTop: timeline.scrollTop,
                  source: String(callback).slice(0, 240),
                  timestamp,
                });
              }
            }
          });
        const longTasks = [];
        let deferredBodyFrames = 0;
        let visibleDeferredBodyFrames = 0;
        let maximumVisibleDeferredBodies = 0;
        let legacyPlaceholderFrames = 0;
        let maximumMountedItems = 0;
        let missingSummaryFrames = 0;
        let consecutiveSummaryComparisons = 0;
        let summaryIdentityChanges = 0;
        let wrapperIdentityChanges = 0;
        let nextElementIdentity = 0;
        const identityChanges = [];
        const elementIdentities = new WeakMap();
        let previousMountedRange = null;
        let previousSummariesByKey = new Map();
        let previousWrappersByKey = new Map();
        const elementIdentity = (element) => {
          let identity = elementIdentities.get(element);
          if (identity === undefined) {
            identity = nextElementIdentity;
            nextElementIdentity += 1;
            elementIdentities.set(element, identity);
          }
          return identity;
        };
        const observer = PerformanceObserver.supportedEntryTypes?.includes("longtask")
          ? new PerformanceObserver((list) => {
              longTasks.push(...list.getEntries().map((entry) => entry.duration));
            })
          : null;
        observer?.observe({ type: "longtask" });
        const rapidStarted = performance.now();
        let previousFrame = rapidStarted;
        await new Promise((resolve) => {
          const tick = (now) => {
            frameIntervals.push(now - previousFrame);
            previousFrame = now;
            if (now - rapidStarted >= 1400) {
              resolve();
              return;
            }
            const maximum = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
            const phase = ((now - rapidStarted) % 700) / 700;
            timeline.scrollTop = phase <= 0.5
              ? maximum * phase * 2
              : maximum * (2 - phase * 2);
            requestAnimationFrame(tick);
          };
          auditAnimationCallback = tick;
          requestAnimationFrame(tick);
        });
        window.requestAnimationFrame = nativeRequestAnimationFrame;
        observer?.disconnect();
        const rapidElapsed = performance.now() - rapidStarted;
        await frame();
        await frame();

        const correctnessStarted = performance.now();
        await new Promise((resolve) => {
          const inspectFrame = (now) => {
            const virtualList = document.querySelector(".agent-activity-virtual-list");
            const mountedRange = {
              end: Number(virtualList?.getAttribute("data-virtual-activity-end")),
              start: Number(virtualList?.getAttribute("data-virtual-activity-start")),
            };
            const mountedWrappers = document.querySelectorAll(".agent-activity-virtual-item");
            const mountedItems = mountedWrappers.length;
            const mountedSummaries = document.querySelectorAll(
              ".agent-activity-virtual-item summary",
            ).length;
            const currentSummariesByKey = new Map();
            const currentWrappersByKey = new Map();
            for (const wrapper of mountedWrappers) {
              const key = wrapper.getAttribute("data-virtual-activity-key");
              const summary = wrapper.querySelector("summary");
              if (key === null || !(summary instanceof HTMLElement)) {
                continue;
              }
              const previousSummary = previousSummariesByKey.get(key);
              if (previousSummary !== undefined) {
                consecutiveSummaryComparisons += 1;
                summaryIdentityChanges += previousSummary === summary ? 0 : 1;
              }
              const previousWrapper = previousWrappersByKey.get(key);
              if (
                identityChanges.length < 20 &&
                ((previousSummary !== undefined && previousSummary !== summary) ||
                  (previousWrapper !== undefined && previousWrapper !== wrapper))
              ) {
                identityChanges.push({
                  currentSummary: elementIdentity(summary),
                  currentWrapper: elementIdentity(wrapper),
                  key,
                  mountedRange,
                  previousMountedRange,
                  previousSummary:
                    previousSummary === undefined ? null : elementIdentity(previousSummary),
                  previousWrapper:
                    previousWrapper === undefined ? null : elementIdentity(previousWrapper),
                  scrollTop: timeline.scrollTop,
                });
              }
              wrapperIdentityChanges +=
                previousWrapper === undefined || previousWrapper === wrapper ? 0 : 1;
              currentSummariesByKey.set(key, summary);
              currentWrappersByKey.set(key, wrapper);
            }
            previousSummariesByKey = currentSummariesByKey;
            previousWrappersByKey = currentWrappersByKey;
            previousMountedRange = mountedRange;
            maximumMountedItems = Math.max(maximumMountedItems, mountedItems);
            const deferredBodyElements = document.querySelectorAll(
              '[data-activity-content="deferred"]',
            );
            const timelineBounds = timeline.getBoundingClientRect();
            const visibleDeferredBodies = [...deferredBodyElements].filter((element) => {
              const bounds = element.getBoundingClientRect();
              return bounds.bottom > timelineBounds.top && bounds.top < timelineBounds.bottom;
            }).length;
            deferredBodyFrames += deferredBodyElements.length === 0 ? 0 : 1;
            visibleDeferredBodyFrames += visibleDeferredBodies === 0 ? 0 : 1;
            maximumVisibleDeferredBodies = Math.max(
              maximumVisibleDeferredBodies,
              visibleDeferredBodies,
            );
            legacyPlaceholderFrames +=
              document.querySelector(".agent-activity-scroll-placeholder") === null ? 0 : 1;
            missingSummaryFrames += mountedSummaries < mountedItems ? 1 : 0;
            const maximum = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
            const phase = ((now - correctnessStarted) % 700) / 700;
            timeline.scrollTop = phase <= 0.5
              ? maximum * phase * 2
              : maximum * (2 - phase * 2);
            if (now - correctnessStarted >= 1400) {
              resolve();
            } else {
              requestAnimationFrame(inspectFrame);
            }
          };
          requestAnimationFrame(inspectFrame);
        });
        const settlementMaximum = Math.max(
          0,
          timeline.scrollHeight - timeline.clientHeight,
        );
        timeline.scrollTop = Math.round(settlementMaximum * 0.5);
        await waitUntil(
          "uma âncora extrema visível",
          () => {
            const timelineBounds = timeline.getBoundingClientRect();
            return [...document.querySelectorAll(".agent-activity-virtual-item")].some(
              (element) => {
                const bounds = element.getBoundingClientRect();
                return bounds.bottom >= timelineBounds.top && bounds.top <= timelineBounds.bottom;
              },
            );
          },
          3000,
        );
        await frame();
        await frame();
        const timelineRect = timeline.getBoundingClientRect();
        const anchor = [...document.querySelectorAll(".agent-activity-virtual-item")].find(
          (element) => {
            const rect = element.getBoundingClientRect();
            return rect.bottom >= timelineRect.top && rect.top <= timelineRect.bottom;
          },
        );
        const anchorKey = anchor?.getAttribute("data-virtual-activity-key") ?? null;
        const anchorOffset =
          anchor instanceof HTMLElement
            ? anchor.getBoundingClientRect().top - timelineRect.top
            : null;
        await new Promise((resolve) => setTimeout(resolve, 180));
        await frame();
        await frame();
        const settledAnchor =
          anchorKey === null
            ? null
            : [...document.querySelectorAll(".agent-activity-virtual-item")].find(
                (element) =>
                  element.getAttribute("data-virtual-activity-key") === anchorKey,
              );
        const visualDriftPx =
          anchorOffset === null || !(settledAnchor instanceof HTMLElement)
            ? null
            : settledAnchor.getBoundingClientRect().top -
              timeline.getBoundingClientRect().top -
              anchorOffset;
        const sortedFrames = frameIntervals.slice(1).sort((left, right) => left - right);
        const sortedAnimationWork = [...animationWorkByFrame.values()]
          .map((measurement) => measurement.duration)
          .sort((left, right) => left - right);
        const sortedApplicationAnimationWork = [...animationWorkByFrame.values()]
          .map((measurement) => measurement.applicationDuration)
          .sort((left, right) => left - right);
        const percentile = (values, percentileValue) =>
          values[Math.min(values.length - 1, Math.floor(values.length * percentileValue))] ?? 0;
        const list = document.querySelector(".agent-activity-virtual-list");
        window.__timelineExtremeFilesMetrics = {
          totalActivities: Number(list?.getAttribute("data-virtual-activity-total") ?? 0),
          physicalListHeight: list?.getBoundingClientRect().height ?? 0,
          rapidFrames: sortedFrames.length,
          rapidElapsedMs: rapidElapsed,
          rapidAverageFps: sortedFrames.length / (rapidElapsed / 1000),
          rapidMedianFrameMs: percentile(sortedFrames, 0.5),
          rapidP95FrameMs: percentile(sortedFrames, 0.95),
          rapidP99FrameMs: percentile(sortedFrames, 0.99),
          rapidMaximumFrameMs: sortedFrames.at(-1) ?? 0,
          rapidAnimationWorkFrames: sortedAnimationWork.length,
          rapidP95AnimationWorkMs: percentile(sortedAnimationWork, 0.95),
          rapidP99AnimationWorkMs: percentile(sortedAnimationWork, 0.99),
          rapidP95ApplicationAnimationWorkMs: percentile(
            sortedApplicationAnimationWork,
            0.95,
          ),
          rapidP99ApplicationAnimationWorkMs: percentile(
            sortedApplicationAnimationWork,
            0.99,
          ),
          rapidMaximumApplicationAnimationWorkMs:
            sortedApplicationAnimationWork.at(-1) ?? 0,
          rapidAnimationCallbackOutliers: animationCallbackOutliers,
          rapidLongTasks: longTasks.length,
          rapidLongTaskTotalMs: longTasks.reduce((total, value) => total + value, 0),
          deferredBodyFrames,
          visibleDeferredBodyFrames,
          maximumVisibleDeferredBodies,
          legacyPlaceholderFrames,
          maximumMountedItems,
          missingSummaryFrames,
          consecutiveSummaryComparisons,
          summaryIdentityChanges,
          wrapperIdentityChanges,
          identityChanges,
          settledDeferredBodies: document.querySelectorAll(
            '[data-activity-content="deferred"]',
          ).length,
          settledLegacyPlaceholders: document.querySelectorAll(
            ".agent-activity-scroll-placeholder",
          ).length,
          mountedItemsAfterSettle: document.querySelectorAll(
            ".agent-activity-virtual-item",
          ).length,
          domNodes: document.getElementsByTagName("*").length,
          visualDriftPx,
          horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
        };
      } catch (error) {
        window.__timelineExtremeFilesError =
          error instanceof Error ? error.stack ?? error.message : String(error);
      } finally {
        window.__timelineExtremeFilesReady = true;
      }
    })();
  })()`;
}

function timelineExtremeFilesAuditExpression() {
  return `(() => {
    if (window.__timelineExtremeFilesError !== undefined) {
      throw new Error(window.__timelineExtremeFilesError);
    }
    if (window.__timelineExtremeFilesMetrics === undefined) {
      throw new Error("As métricas de 100 mil arquivos estão ausentes.");
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      ...window.__timelineExtremeFilesMetrics,
    };
  })()`;
}

function liveCommandOutputVisualAuditExpression() {
  return `(() => {
    const output = document.querySelector(".command-live-output");
    const card = output?.closest(".command-activity-card");
    const scroll = card?.querySelector(".command-card-scroll");
    const title = card?.querySelector(":scope > summary .activity-title-base");
    const prompt = card?.querySelector(".command-card-prompt");
    if (
      !(card instanceof HTMLDetailsElement) ||
      !(scroll instanceof HTMLElement) ||
      !(output instanceof HTMLElement) ||
      !(title instanceof HTMLElement) ||
      !(prompt instanceof HTMLElement)
    ) {
      throw new Error("Detalhes ao vivo do comando em execução estão ausentes.");
    }
    const outputStyle = getComputedStyle(output);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      title: title.textContent?.trim() ?? null,
      prompt: prompt.textContent?.replace(/\\s+/g, " ").trim() ?? null,
      outputText: output.textContent ?? "",
      open: card.open,
      hasFinalOutputView: card.querySelector(".thread-output-view") instanceof HTMLElement,
      scrollable: scroll.scrollHeight > scroll.clientHeight,
      followGap: scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop,
      maximumHeight: getComputedStyle(scroll).maxHeight,
      whiteSpace: outputStyle.whiteSpace,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      commandHorizontalOverflow: scroll.scrollWidth - scroll.clientWidth,
    };
  })()`;
}

function singleFileChangeVisualAuditExpression() {
  return `(() => {
    const file = [...document.querySelectorAll(".file-change-diff .diff-file-identity code")].find(
      (element) => element.textContent?.trim() === "engine.rs",
    );
    const block = file?.closest(".diff-block");
    if (!(file instanceof HTMLElement) || !(block instanceof HTMLDetailsElement)) {
      throw new Error("Bloco direto da alteração única está ausente.");
    }
    const groupedFile = [
      ...document.querySelectorAll(".file-change-diff .diff-file-identity code"),
    ].find((element) => element.textContent?.trim() === "setupBrowserPreview.ts");
    const groupedBlock = groupedFile?.closest(".file-change-diff");
    const groupedActivity = groupedBlock?.closest(".agent-activity-group");
    const groupedList = groupedBlock?.closest(".agent-activity-virtual-list");
    const newFile = [
      ...document.querySelectorAll(".file-change-diff .diff-file-identity code"),
    ].find((element) => element.textContent?.trim() === "semantic.rs");
    const newFileBlock = newFile?.closest(".file-change-diff");
    const deletedFile = [
      ...document.querySelectorAll(".file-change-diff .diff-file-identity code"),
    ].find((element) => element.textContent?.trim() === "terminal_output.rs");
    const deletedFileBlock = deletedFile?.closest(".file-change-diff");
    if (
      !(groupedFile instanceof HTMLElement) ||
      !(groupedBlock instanceof HTMLDetailsElement) ||
      !(groupedActivity instanceof HTMLDetailsElement) ||
      !(groupedList instanceof HTMLElement) ||
      !(newFile instanceof HTMLElement) ||
      !(newFileBlock instanceof HTMLDetailsElement) ||
      !(deletedFile instanceof HTMLElement) ||
      !(deletedFileBlock instanceof HTMLDetailsElement)
    ) {
      throw new Error("Alteração interna do grupo está ausente.");
    }
    const action = block.querySelector(".file-change-action");
    const blockStyle = getComputedStyle(block);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      fileName: file.textContent?.trim() ?? null,
      action: action?.textContent?.trim() ?? null,
      compact: block.classList.contains("file-change-diff"),
      hasActivityIcon: block.querySelector(".activity-icon") instanceof HTMLElement,
      borderTopWidth: blockStyle.borderTopWidth,
      borderRadius: blockStyle.borderRadius,
      backgroundColor: blockStyle.backgroundColor,
      groupedAction: groupedBlock.querySelector(".file-change-action")?.textContent?.trim() ?? null,
      groupedHasActivityIcon:
        groupedBlock.querySelector(".activity-icon") instanceof HTMLElement,
      groupedHasRedundantHeading:
        groupedActivity.querySelector(".grouped-file-change-heading") instanceof HTMLElement,
      groupedDirectFileCount:
        groupedList.querySelectorAll(".agent-activity-virtual-item .file-change-diff").length,
      groupedNestedCollectionCount: groupedList.querySelectorAll(".file-change-card").length,
      newFileAction:
        newFileBlock.querySelector(".file-change-action")?.textContent?.trim() ?? null,
      newFileBadge: newFileBlock.querySelector(".change-kind")?.textContent?.trim() ?? null,
      newFileAdditions:
        newFileBlock.querySelector(".diff-stat.additions")?.textContent?.trim() ?? null,
      newFileHasDeletions:
        newFileBlock.querySelector(".diff-stat.deletions") instanceof HTMLElement,
      deletedFileAction:
        deletedFileBlock.querySelector(".file-change-action")?.textContent?.trim() ?? null,
      deletedFileBadge:
        deletedFileBlock.querySelector(".change-kind")?.textContent?.trim() ?? null,
      deletedFileDeletions:
        deletedFileBlock.querySelector(".diff-stat.deletions")?.textContent?.trim() ?? null,
      deletedFileHasAdditions:
        deletedFileBlock.querySelector(".diff-stat.additions") instanceof HTMLElement,
      open: block.open,
      aggregateContainerCount: document.querySelectorAll(".file-change-card").length,
      directDiffVisible:
        block.querySelector(".diff-viewport, .diff-empty-state") instanceof HTMLElement,
      intrinsicInteraction: window.__previewIntrinsicActivityInteraction ?? null,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`;
}

function syntaxHighlightedDiffVisualAuditExpression() {
  return `(() => {
    const file = [...document.querySelectorAll(".file-change-diff .diff-file-identity code")].find(
      (element) => element.textContent?.trim() === "engine.rs",
    );
    const block = file?.closest(".file-change-diff");
    const viewport = block?.querySelector(".diff-viewport");
    if (
      !(file instanceof HTMLElement) ||
      !(block instanceof HTMLDetailsElement) ||
      !(viewport instanceof HTMLElement)
    ) {
      throw new Error("Diff Rust realçado está ausente.");
    }
    const tokens = [...viewport.querySelectorAll(".syntax-token")];
    const tokenKinds = [
      ...new Set(
        tokens.flatMap((token) =>
          [...token.classList].filter((className) => className.startsWith("token-")),
        ),
      ),
    ].sort();
    const tokenColors = [...new Set(tokens.map((token) => getComputedStyle(token).color))];
    const addition = viewport.querySelector(".unified-diff-row.is-addition .unified-diff-code");
    const deletion = viewport.querySelector(".unified-diff-row.is-deletion .unified-diff-code");
    const additionRow = addition?.closest(".unified-diff-row");
    const deletionRow = deletion?.closest(".unified-diff-row");
    const context = viewport.querySelector(".unified-diff-row.is-context");
    const panel = block.querySelector(".diff-panel");
    const panelHeader = block.querySelector(".diff-panel-header");
    const panelCopy = panelHeader?.querySelector(".diff-panel-copy");
    const outerSummary = block.querySelector(":scope > summary");
    const rows = [...viewport.querySelectorAll(".unified-diff-row")];
    const table = viewport.querySelector(".diff-virtual-table");
    const lineNumberBounds = rows.flatMap((row) => {
      const cell = row.querySelector(".diff-line-number");
      return cell instanceof HTMLElement ? [cell.getBoundingClientRect()] : [];
    });
    const lineNumberLefts = lineNumberBounds.map((bounds) => bounds.left);
    const lineNumberCells = rows.flatMap((row) => {
      const cell = row.querySelector(".diff-line-number");
      return cell instanceof HTMLElement ? [cell] : [];
    });
    const lineNumberContents = lineNumberCells.flatMap((cell) => {
      const content = cell.querySelector(".diff-line-number-content");
      return content instanceof HTMLElement ? [content] : [];
    });
    const changedLineNumber = viewport.querySelector(
      ".unified-diff-row.is-addition .diff-line-number",
    );
    const changedLineNumberStyle =
      changedLineNumber instanceof HTMLElement ? getComputedStyle(changedLineNumber) : null;
    const changedIndicatorStyle =
      changedLineNumber instanceof HTMLElement
        ? getComputedStyle(changedLineNumber, "::before")
        : null;
    const initialScrollLeft = viewport.scrollLeft;
    const initialStickyLeft = changedLineNumber?.getBoundingClientRect().left ?? null;
    viewport.scrollLeft = viewport.scrollWidth;
    const scrolledStickyLeft = changedLineNumber?.getBoundingClientRect().left ?? null;
    const stickyOffsetFromViewport =
      scrolledStickyLeft === null
        ? null
        : scrolledStickyLeft - viewport.getBoundingClientRect().left;
    viewport.scrollLeft = initialScrollLeft;
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      tokenKinds,
      tokenColorCount: tokenColors.length,
      tokenCount: tokens.length,
      contextHasSyntax: context?.querySelector(".syntax-token") instanceof HTMLElement,
      additionBackground:
        additionRow instanceof HTMLElement ? getComputedStyle(additionRow).backgroundColor : null,
      deletionBackground:
        deletionRow instanceof HTMLElement ? getComputedStyle(deletionRow).backgroundColor : null,
      additionCellBackground:
        addition instanceof HTMLElement ? getComputedStyle(addition).backgroundColor : null,
      deletionCellBackground:
        deletion instanceof HTMLElement ? getComputedStyle(deletion).backgroundColor : null,
      panelBackground:
        panel instanceof HTMLElement ? getComputedStyle(panel).backgroundColor : null,
      viewportBackground: getComputedStyle(viewport).backgroundColor,
      viewportOpacity: getComputedStyle(viewport).opacity,
      viewportFilter: getComputedStyle(viewport).filter,
      viewportBackdropFilter: getComputedStyle(viewport).backdropFilter,
      additionRowWidth:
        additionRow instanceof HTMLElement ? additionRow.getBoundingClientRect().width : null,
      deletionRowWidth:
        deletionRow instanceof HTMLElement ? deletionRow.getBoundingClientRect().width : null,
      tableWidth: table instanceof HTMLElement ? table.getBoundingClientRect().width : null,
      additionRowRightGap:
        additionRow instanceof HTMLElement && table instanceof HTMLElement
          ? table.getBoundingClientRect().right - additionRow.getBoundingClientRect().right
          : null,
      deletionRowRightGap:
        deletionRow instanceof HTMLElement && table instanceof HTMLElement
          ? table.getBoundingClientRect().right - deletionRow.getBoundingClientRect().right
          : null,
      keywordColor: rootStyle.getPropertyValue("--syntax-keyword").trim(),
      stringColor: rootStyle.getPropertyValue("--syntax-string").trim(),
      expandedSummaryHasIdentity:
        block.querySelector(":scope > summary .diff-file-identity") instanceof HTMLElement,
      expandedSummaryAlignItems:
        outerSummary instanceof HTMLElement ? getComputedStyle(outerSummary).alignItems : null,
      expandedSummaryBorderBottomWidth:
        outerSummary instanceof HTMLElement
          ? getComputedStyle(outerSummary).borderBottomWidth
          : null,
      panelHeaderFile: panelHeader?.querySelector("code")?.textContent?.trim() ?? null,
      panelHeaderFileDecoration:
        panelHeader?.querySelector("code") instanceof HTMLElement
          ? getComputedStyle(panelHeader.querySelector("code")).textDecorationLine
          : null,
      panelHeaderStats: [...(panelHeader?.querySelectorAll(".diff-stat") ?? [])].map(
        (element) => element.textContent?.trim() ?? "",
      ),
      panelHeaderHeight:
        panelHeader instanceof HTMLElement ? panelHeader.getBoundingClientRect().height : null,
      panelHeaderAlignItems:
        panelHeader instanceof HTMLElement ? getComputedStyle(panelHeader).alignItems : null,
      panelHeaderChildCenterOffsets:
        panelHeader instanceof HTMLElement
          ? [...panelHeader.querySelectorAll(".diff-file-identity code, .diff-stat")].map(
              (element) => {
                const headerBounds = panelHeader.getBoundingClientRect();
                const elementBounds = element.getBoundingClientRect();
                return (
                  elementBounds.top +
                  elementBounds.height / 2 -
                  (headerBounds.top + headerBounds.height / 2)
                );
              },
            )
          : [],
      panelCopyLabel: panelCopy?.getAttribute("aria-label") ?? null,
      codeText: viewport.querySelector(".unified-diff-code code")?.textContent ?? null,
      codeInset:
        addition instanceof HTMLElement
          ? addition.getBoundingClientRect().left - viewport.getBoundingClientRect().left
          : null,
      lineNumberCellsPerRow: rows.map(
        (row) => row.querySelectorAll(":scope > .diff-line-number").length,
      ),
      lineNumberLeftSpread:
        lineNumberLefts.length === 0
          ? null
          : Math.max(...lineNumberLefts) - Math.min(...lineNumberLefts),
      lineNumberValues: rows.map(
        (row) => row.querySelector(":scope > .diff-line-number")?.textContent?.trim() ?? "",
      ),
      lineNumberContentOverflow: lineNumberContents.map(
        (content) => content.scrollWidth - content.clientWidth,
      ),
      lineNumberContentContainment: lineNumberContents.map((content) => {
        const contentBounds = content.getBoundingClientRect();
        const cellBounds = content.closest(".diff-line-number")?.getBoundingClientRect();
        return cellBounds === undefined
          ? null
          : {
              left: contentBounds.left - cellBounds.left,
              right: cellBounds.right - contentBounds.right,
            };
      }),
      lineNumberWidths: lineNumberBounds.map((bounds) => bounds.width),
      lineNumberBoxSizing: changedLineNumberStyle?.boxSizing ?? null,
      lineNumberPaddingLeft: changedLineNumberStyle?.paddingLeft ?? null,
      lineNumberPaddingRight: changedLineNumberStyle?.paddingRight ?? null,
      lineNumberDividerWidth: changedLineNumberStyle?.borderRightWidth ?? null,
      lineNumberBackground: changedLineNumberStyle?.backgroundColor ?? null,
      changedIndicatorWidth: changedIndicatorStyle?.width ?? null,
      changedIndicatorPosition: changedIndicatorStyle?.position ?? null,
      diffRowHeights: rows.map((row) => row.getBoundingClientRect().height),
      diffRowTopOffsets: rows.map(
        (row) => row.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
      ),
      diffRowInlineTops: rows.map((row) =>
        row instanceof HTMLElement ? row.style.top : null,
      ),
      diffViewportHeight: viewport.getBoundingClientRect().height,
      diffViewportClientHeight: viewport.clientHeight,
      diffViewportScrollHeight: viewport.scrollHeight,
      diffCanvasHeight:
        viewport.querySelector(".diff-virtual-canvas") instanceof HTMLElement
          ? viewport.querySelector(".diff-virtual-canvas").getBoundingClientRect().height
          : null,
      stickyGutterMovement:
        initialStickyLeft === null || scrolledStickyLeft === null
          ? null
          : Math.abs(scrolledStickyLeft - initialStickyLeft),
      stickyOffsetFromViewport,
      markerCellCount: viewport.querySelectorAll(".diff-line-prefix").length,
      newlineMetadataRows: [...viewport.querySelectorAll(".unified-diff-hunk")].filter(
        (element) => element.textContent?.includes("No newline at end of file"),
      ).length,
      structuralMetadataRows: viewport.querySelectorAll(
        ".unified-diff-row.is-hunk, .unified-diff-row.is-meta, .unified-diff-hunk, .split-diff-hunk",
      ).length,
      containsStructuralMetadata: ["@@ ", "diff --git ", "No newline at end of file"].some(
        (marker) => (viewport.textContent ?? "").includes(marker),
      ),
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      viewportHorizontalOverflow: viewport.scrollWidth - viewport.clientWidth,
    };
  })()`;
}

function reviewFileLayoutVisualAuditExpression() {
  return `(() => {
    const panel = document.querySelector(".review-panel");
    const content = panel?.querySelector(".review-panel-content");
    const fileList = panel?.querySelector(".review-file-list");
    const stage = panel?.querySelector(".review-file-stage");
    const header = stage?.querySelector(".review-file-header");
    const diffViewport = stage?.querySelector(".diff-viewport");
    const table = diffViewport?.querySelector(".diff-virtual-table");
    const canvas = diffViewport?.querySelector(".diff-virtual-canvas");
    const selectedFile = fileList?.querySelector(".review-file-option.selected code");
    if (
      !(panel instanceof HTMLElement) ||
      !(content instanceof HTMLElement) ||
      !(fileList instanceof HTMLElement) ||
      !(stage instanceof HTMLElement) ||
      !(header instanceof HTMLElement) ||
      !(diffViewport instanceof HTMLElement) ||
      !(table instanceof HTMLElement) ||
      !(canvas instanceof HTMLElement) ||
      !(selectedFile instanceof HTMLElement)
    ) {
      throw new Error("A estrutura completa da revisão está ausente.");
    }
    const rows = [...diffViewport.querySelectorAll(".diff-virtual-row")];
    const viewportBounds = diffViewport.getBoundingClientRect();
    const rowTopOffsets = rows.map(
      (row) => row.getBoundingClientRect().top - viewportBounds.top,
    );
    return {
      viewport: { width: innerWidth, height: innerHeight },
      workspaceSplit: ${workspaceSplitVisualStateExpression()},
      workspaceSplitInteraction: window.__previewWorkspaceSplitInteraction ?? null,
      panelHeight: panel.getBoundingClientRect().height,
      contentHeight: content.getBoundingClientRect().height,
      contentDisplay: getComputedStyle(content).display,
      contentContainerType: getComputedStyle(content).containerType,
      contentFlexDirection: getComputedStyle(content).flexDirection,
      fileListHeight: fileList.getBoundingClientRect().height,
      fileListMaxHeight: getComputedStyle(fileList).maxHeight,
      fileListFlexGrow: getComputedStyle(fileList).flexGrow,
      fileListFlexShrink: getComputedStyle(fileList).flexShrink,
      fileListScrollHeight: fileList.scrollHeight,
      fileListScrollable: fileList.scrollHeight > fileList.clientHeight,
      fileCount: fileList.querySelectorAll(".review-file-option").length,
      selectedFile: selectedFile.textContent?.trim() ?? null,
      stageHeight: stage.getBoundingClientRect().height,
      stageFlexGrow: getComputedStyle(stage).flexGrow,
      headerHeight: header.getBoundingClientRect().height,
      diffViewportHeight: viewportBounds.height,
      diffViewportClientHeight: diffViewport.clientHeight,
      diffViewportInlineHeight: diffViewport.style.height,
      diffViewportSizing: diffViewport.dataset.viewportSizing ?? null,
      diffViewportScrollHeight: diffViewport.scrollHeight,
      declaredRows: Number.parseInt(table.getAttribute("aria-rowcount") ?? "0", 10),
      mountedRows: rows.length,
      mountedRowIndexes: rows.map((row) =>
        Number.parseInt(row.getAttribute("aria-rowindex") ?? "0", 10),
      ),
      tableRole: table.getAttribute("role"),
      rowGroupRole: canvas.getAttribute("role"),
      rowRoles: rows.map((row) => row.getAttribute("role")),
      rowCellRoles: rows.map((row) =>
        [...row.children].map((cell) => cell.getAttribute("role")),
      ),
      rowTopOffsets,
      rowGaps: rowTopOffsets.slice(1).map(
        (top, index) => top - (rowTopOffsets[index] ?? top),
      ),
      canvasHeight: canvas.getBoundingClientRect().height,
      virtualizationCycle: window.__previewReviewVirtualizationCycle ?? null,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`;
}

function syntaxHighlightedCreatedFileVisualAuditExpression() {
  return `(() => {
    if (window.__previewCreatedFileError !== undefined) {
      throw new Error(window.__previewCreatedFileError);
    }
    if (window.__previewCreatedFileMetrics !== undefined) {
      return {
        viewport: { width: innerWidth, height: innerHeight },
        ...window.__previewCreatedFileMetrics,
      };
    }
    const file = [...document.querySelectorAll(".file-change-diff .diff-file-identity code")].find(
      (element) => element.textContent?.trim() === "semantic.rs",
    );
    const block = file?.closest(".file-change-diff");
    const viewport = block?.querySelector(".diff-viewport");
    const code = viewport?.querySelector(".unified-diff-row.is-addition .unified-diff-code");
    if (
      !(file instanceof HTMLElement) ||
      !(block instanceof HTMLDetailsElement) ||
      !(viewport instanceof HTMLElement) ||
      !(code instanceof HTMLElement)
    ) {
      throw new Error("Diff de arquivo Rust criado está ausente.");
    }
    const tokens = [...viewport.querySelectorAll(".syntax-token")];
    const rows = [...viewport.querySelectorAll(".unified-diff-row")];
    return {
      viewport: { width: innerWidth, height: innerHeight },
      tokenKinds: [
        ...new Set(
          tokens.flatMap((token) =>
            [...token.classList].filter((className) => className.startsWith("token-")),
          ),
        ),
      ].sort(),
      tokenColorCount: new Set(tokens.map((token) => getComputedStyle(token).color)).size,
      tokenCount: tokens.length,
      additionRows: viewport.querySelectorAll(".unified-diff-row.is-addition").length,
      deletionRows: viewport.querySelectorAll(".unified-diff-row.is-deletion").length,
      newlineMetadataRows: [...viewport.querySelectorAll(".unified-diff-hunk")].filter(
        (element) => element.textContent?.includes("No newline at end of file"),
      ).length,
      structuralMetadataRows: viewport.querySelectorAll(
        ".unified-diff-row.is-hunk, .unified-diff-row.is-meta, .unified-diff-hunk, .split-diff-hunk",
      ).length,
      containsStructuralMetadata: ["@@ ", "diff --git ", "No newline at end of file"].some(
        (marker) => (viewport.textContent ?? "").includes(marker),
      ),
      codeInset: code.getBoundingClientRect().left - viewport.getBoundingClientRect().left,
      lineNumberCellsPerRow: rows.map(
        (row) => row.querySelectorAll(":scope > .diff-line-number").length,
      ),
      markerCellCount: viewport.querySelectorAll(".diff-line-prefix").length,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`;
}

function highlightedToolOutputVisualAuditExpression() {
  return `(() => {
    if (window.__previewHighlightedToolMetrics !== undefined) {
      return {
        viewport: { width: innerWidth, height: innerHeight },
        ...window.__previewHighlightedToolMetrics,
        readInteraction: window.__previewReadActivityInteraction ?? null,
      };
    }
    const source = document.querySelector(".tool-source-output");
    const search = document.querySelector(".tool-search-output");
    if (!(source instanceof HTMLElement) || !(search instanceof HTMLElement)) {
      throw new Error("Saídas tipadas de leitura e busca estão ausentes.");
    }
    const sourceTokens = [...source.querySelectorAll(".syntax-token")];
    const searchTokens = [...search.querySelectorAll(".syntax-token")];
    const sourceSummary = source.closest(".tool-activity-card")?.querySelector(":scope > summary");
    const readIcon = sourceSummary?.querySelector(".activity-icon svg");
    const readIconBounds = readIcon?.getBoundingClientRect();
    const readChevron = sourceSummary?.querySelector(".activity-chevron");
    const readChevronIcon = readChevron?.querySelector("svg");
    const readChevronBounds = readChevronIcon?.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      readIconPaths: [
        ...(sourceSummary?.querySelectorAll(".activity-icon svg path") ?? []),
      ].map((path) => path.getAttribute("d")),
      readIconFill: readIcon?.getAttribute("fill") ?? null,
      readIconRtlFlip: readIcon?.hasAttribute("data-rtl-flip") ?? false,
      readIconSize:
        readIconBounds === undefined
          ? null
          : { height: readIconBounds.height, width: readIconBounds.width },
      readIconStroke: readIcon?.getAttribute("stroke") ?? null,
      readIconStrokeWidth: readIcon?.getAttribute("stroke-width") ?? null,
      readIconViewBox: readIcon?.getAttribute("viewBox") ?? null,
      readChevronOpacity:
        readChevron === null || readChevron === undefined
          ? null
          : Number.parseFloat(getComputedStyle(readChevron).opacity),
      readChevronPath: readChevronIcon?.querySelector("path")?.getAttribute("d") ?? null,
      readChevronSize:
        readChevronBounds === undefined
          ? null
          : { height: readChevronBounds.height, width: readChevronBounds.width },
      readChevronTransform:
        readChevronIcon === null || readChevronIcon === undefined
          ? null
          : getComputedStyle(readChevronIcon).transform,
      readTitle:
        sourceSummary?.querySelector(".activity-title-base")?.textContent?.trim() ?? null,
      sourceLineNumbers: [...source.querySelectorAll(".tool-source-line-number")].map(
        (element) => element.textContent?.trim() ?? "",
      ),
      sourceTokenKinds: [
        ...new Set(
          sourceTokens.flatMap((token) =>
            [...token.classList].filter((className) => className.startsWith("token-")),
          ),
        ),
      ].sort(),
      searchTokenKinds: [
        ...new Set(
          searchTokens.flatMap((token) =>
            [...token.classList].filter((className) => className.startsWith("token-")),
          ),
        ),
      ].sort(),
      sourceText: source.textContent ?? "",
      searchText: search.textContent ?? "",
      sourceHorizontalOverflow: source.scrollWidth - source.clientWidth,
      searchHorizontalOverflow: search.scrollWidth - search.clientWidth,
      readInteraction: window.__previewReadActivityInteraction ?? null,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`;
}

function composerPopoverLayeringVisualAuditExpression() {
  return `(() => {
    if (window.__previewComposerPopoverLayeringError !== undefined) {
      throw new Error(window.__previewComposerPopoverLayeringError);
    }
    if (window.__previewComposerPopoverLayeringMetrics === undefined) {
      throw new Error("As métricas de camadas dos painéis do compositor estão ausentes.");
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      ...window.__previewComposerPopoverLayeringMetrics,
      permissionMenuOpen: document.querySelector(".permission-menu") instanceof HTMLElement,
    };
  })()`;
}

function projectOpenWorkspaceVisualAuditExpression() {
  return `(() => ({
    viewport: { width: innerWidth, height: innerHeight },
    openedWorkspace:
      typeof window.__previewOpenedWorkspace === "string"
        ? window.__previewOpenedWorkspace
        : null,
    dialogOpen: document.querySelector('[role="dialog"]') !== null,
    projectEditorOpen: document.querySelector(".project-edit-container") !== null,
    horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
  }))()`;
}

function chatReferenceVisualAuditExpression() {
  return `(() => {
    const rectangle = (element, label) => {
      if (!(element instanceof HTMLElement)) {
        throw new Error("Elemento ausente: " + label);
      }
      const bounds = element.getBoundingClientRect();
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
      };
    };
    const styles = (element, label) => {
      if (!(element instanceof HTMLElement)) {
        throw new Error("Elemento ausente: " + label);
      }
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderRadius: style.borderRadius,
        borderTopWidth: style.borderTopWidth,
        color: style.color,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        paddingTop: style.paddingTop,
        paddingRight: style.paddingRight,
        paddingBottom: style.paddingBottom,
        paddingLeft: style.paddingLeft,
      };
    };
    const timeline = document.querySelector(".timeline");
    const timelineInnerElement = document.querySelector(".timeline-inner");
    const userBubbleElement = document.querySelector(".user-message-bubble");
    const durationElement = document.querySelector(".turn-duration-label");
    const dividerElement = document.querySelector(".turn-header-line");
    const commentaryElements = [...document.querySelectorAll(
      ".agent-message-row.commentary .markdown",
    )];
    const firstCommentaryElement = commentaryElements[0];
    const firstCommandElement = document.querySelector(
      ".command-activity-card:not(.grouped-activity-item) .activity-title",
    );
    const groupSummaryElements = [...document.querySelectorAll(
      ".agent-activity-summary .activity-title",
    )];
    const terminalReadElement = [...document.querySelectorAll(".activity-title")].find(
      (element) => element.textContent?.trim() === "Terminal do chat lido",
    );
    const finalAnswerElement = document.querySelector(
      ".agent-message-row:not(.commentary) .agent-message-markdown",
    );
    const rootStyle = getComputedStyle(document.documentElement);
    const userBubble = rectangle(userBubbleElement, ".user-message-bubble");
    const duration = rectangle(durationElement, ".turn-duration-label");
    const firstCommentary = rectangle(
      firstCommentaryElement,
      ".agent-message-row.commentary .markdown",
    );
    const firstCommand = rectangle(firstCommandElement, "primeiro comando");
    const terminalRead = rectangle(terminalReadElement, "Terminal do chat lido");
    const finalAnswer = rectangle(finalAnswerElement, "resposta final");
    return {
      viewport: { width: innerWidth, height: innerHeight },
      timelineInner: rectangle(timelineInnerElement, ".timeline-inner"),
      userBubble,
      userBubbleStyle: styles(userBubbleElement, ".user-message-bubble"),
      duration,
      durationStyle: styles(durationElement, ".turn-duration-label"),
      divider: rectangle(dividerElement, ".turn-header-line"),
      dividerStyle: styles(dividerElement, ".turn-header-line"),
      firstCommentary,
      commentaryStyle: styles(firstCommentaryElement, "primeiro commentary"),
      firstCommand,
      firstCommandText: firstCommandElement?.textContent?.trim() ?? null,
      activityStyle: styles(firstCommandElement, "primeiro comando"),
      terminalRead,
      terminalReadText: terminalReadElement?.textContent?.trim() ?? null,
      finalAnswer,
      groupSummaries: groupSummaryElements.map((element) => element.textContent?.trim() ?? ""),
      commentaryCount: commentaryElements.length,
      commandRowCount: document.querySelectorAll(".command-activity-card").length,
      activityGroupCount: document.querySelectorAll(".agent-activity-group").length,
      openActivityGroupCount: document.querySelectorAll(".agent-activity-group[open]").length,
      turnExpanded:
        document.querySelector(".turn-header-button")?.getAttribute("aria-expanded") === "true",
      timelineAriaLabel: timeline?.getAttribute("aria-label") ?? null,
      articleCount: document.querySelectorAll(".conversation-turn article.message-row").length,
      detailsCount: document.querySelectorAll(".conversation-turn details").length,
      bodyText:
        document.querySelector(".conversation-turn")?.textContent?.replace(/\\s+/g, " ").trim() ??
        "",
      workOrderIsCorrect:
        userBubble.bottom < duration.top &&
        duration.bottom <= firstCommentary.top &&
        firstCommentary.top < firstCommand.top &&
        firstCommand.top < terminalRead.top &&
        terminalRead.top < finalAnswer.top,
      threadContentMaxWidth: rootStyle
        .getPropertyValue("--thread-content-max-width")
        .trim(),
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      timelineHorizontalOverflow:
        timeline instanceof HTMLElement ? timeline.scrollWidth - timeline.clientWidth : null,
    };
  })()`;
}

function projectColorEditorVisualAuditExpression() {
  return `(() => {
    const rectangle = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        throw new Error("Elemento ausente: " + selector);
      }
      const bounds = element.getBoundingClientRect();
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
      };
    };
    const preview = document.querySelector(".project-icon-preview");
    const hexInput = document.querySelector(".hex-text-input");
    const badge = document.querySelector(".color-hex-badge");
    const hueBar = document.querySelector(".hue-bar");
    const hueCursor = document.querySelector(".hue-cursor");
    const hsvBox = document.querySelector(".hsv-box");
    const hueBounds = hueBar?.getBoundingClientRect();
    const cursorBounds = hueCursor?.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      container: rectangle(".project-edit-container"),
      modal: rectangle(".project-edit-modal"),
      colorPanel: rectangle(".project-color-side-panel"),
      picker: rectangle(".inline-color-picker"),
      hueBar: rectangle(".hue-bar"),
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      verticalOverflow: document.documentElement.scrollHeight - innerHeight,
      dialogCount: document.querySelectorAll('.project-edit-container[role="dialog"]').length,
      previewColor: preview instanceof HTMLElement ? getComputedStyle(preview).color : null,
      hexValue: hexInput instanceof HTMLInputElement ? hexInput.value : null,
      badgeText: badge?.textContent?.trim() ?? null,
      boxColor: hsvBox instanceof HTMLElement ? getComputedStyle(hsvBox).backgroundColor : null,
      hueCursorRightGap:
        hueBounds !== undefined && cursorBounds !== undefined
          ? hueBounds.right - cursorBounds.right
          : null,
    };
  })()`;
}

function settingsVisualAuditExpression() {
  return `(() => {
    const rectangle = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        throw new Error("Elemento ausente: " + selector);
      }
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
        display: style.display,
        visibility: style.visibility,
        fontSize: style.fontSize,
      };
    };
    const overlaps = (left, right) =>
      left.left < right.right &&
      left.right > right.left &&
      left.top < right.bottom &&
      left.bottom > right.top;
    const chrome = rectangle(".window-chrome");
    const content = rectangle(".application-frame-content");
    const controls = rectangle(".window-chrome-controls");
    const overlay = rectangle(".settings-overlay");
    const navigation = rectangle(".settings-nav");
    const back = rectangle(".settings-back");
    const main = rectangle(".settings-main");
    const scrollbar = rectangle(".settings-scrollbar");
    const scrollbarThumb = rectangle(".settings-scrollbar .surface-scrollbar-thumb");
    const page = rectangle(".settings-page");
    const heading = rectangle(".settings-heading h2");
    const firstRowLabel = rectangle(".application-preference-copy strong");
    const firstNavigationSection = document.querySelector(".settings-nav-section");
    const navigationButtons =
      firstNavigationSection === null ? [] : [...firstNavigationSection.querySelectorAll("button")];
    const navigationItemGaps = navigationButtons.slice(1).map((button, index) => {
      const previous = navigationButtons[index];
      return previous === undefined
        ? null
        : button.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
    });
    const selectedNavigation = document.querySelector(".settings-nav nav button.active");
    const selectedNavigationStyle =
      selectedNavigation instanceof HTMLElement ? getComputedStyle(selectedNavigation) : null;
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      chrome,
      content,
      controls,
      overlay,
      navigation,
      back,
      main,
      scrollbar,
      scrollbarThumb,
      page,
      heading,
      firstRowLabel,
      chromeText: document.querySelector(".window-chrome")?.textContent?.trim() ?? null,
      chromeOverlapsSettings: overlaps(chrome, overlay),
      nativeScrollbarWidth: getComputedStyle(
        document.querySelector(".settings-main"),
      ).scrollbarWidth,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      verticalOverflow: document.documentElement.scrollHeight - innerHeight,
      checkboxCount: document.querySelectorAll(
        '.application-preference input[type="checkbox"]',
      ).length,
      navigationLabels: [...document.querySelectorAll(".settings-nav nav button")].map(
        (button) => button.textContent?.trim() ?? "",
      ),
      navigationItemGaps,
      hoverSurface: rootStyle.getPropertyValue("--interactive-hover-surface").trim(),
      selectedSurface: rootStyle.getPropertyValue("--interactive-selected-surface").trim(),
      selectedNavigationBackground: selectedNavigationStyle?.backgroundColor ?? null,
      selectedNavigationBoxShadow: selectedNavigationStyle?.boxShadow ?? null,
      visibleCards: [...document.querySelectorAll(".settings-card")].filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.bottom > content.top && bounds.top < innerHeight;
      }).length,
    };
  })()`;
}

function usageSettingsVisualAuditExpression() {
  return `(() => {
    const rectangle = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        throw new Error("Elemento ausente: " + selector);
      }
      const bounds = element.getBoundingClientRect();
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
      };
    };
    const page = document.querySelector(".settings-page");
    const plan = document.querySelector(".usage-plan");
    const autoTopUp = document.querySelector(".usage-auto-top-up-row");
    const reset = document.querySelector(".usage-reset-row");
    const resetButton = document.querySelector(".usage-reset-button");
    const toggle = document.querySelector(".usage-switch");
    const headings = [...document.querySelectorAll(".settings-section > h3")].map(
      (heading) => heading.textContent?.trim() ?? "",
    );
    return {
      viewport: { width: innerWidth, height: innerHeight },
      page: rectangle(".settings-page"),
      plan: rectangle(".usage-plan"),
      autoTopUp: rectangle(".usage-auto-top-up-row"),
      reset: rectangle(".usage-reset-row"),
      pageText: page?.textContent ?? "",
      planText: plan?.textContent ?? "",
      autoTopUpText: autoTopUp?.textContent ?? "",
      resetText: reset?.textContent ?? "",
      resetButtonText: resetButton?.textContent?.trim() ?? null,
      switchAriaChecked: toggle?.getAttribute("aria-checked") ?? null,
      sectionHeadings: headings,
      meterCount: document.querySelectorAll(".usage-meter-row").length,
      cardCount: document.querySelectorAll(".settings-card").length,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      pageHorizontalOverflow:
        page instanceof HTMLElement ? page.scrollWidth - page.clientWidth : null,
    };
  })()`;
}

function usageSettingsInteractionVisualAuditExpression() {
  return `(() => ({
    resetRows: document.querySelectorAll(".usage-reset-row").length,
    successText: document.querySelector(".usage-inline-success")?.textContent?.trim() ?? null,
    switchAriaChecked: document.querySelector(".usage-switch")?.getAttribute("aria-checked") ?? null,
    autoTopUpText: document.querySelector(".usage-auto-top-up-row")?.textContent ?? "",
    horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
  }))()`;
}

function outputDetailVisualAuditExpression() {
  return `(() => {
    const rectangle = (element, label) => {
      if (!(element instanceof HTMLElement)) {
        throw new Error("Elemento ausente: " + label);
      }
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
        overflow: style.overflow,
      };
    };
    const triggerElement = document.querySelector(".output-detail-trigger");
    const menuElement = document.querySelector(".output-detail-menu");
    const cardElement = triggerElement?.closest(".settings-card");
    const options = [...document.querySelectorAll(".output-detail-option")];
    const visibleOptions = options.filter((option) => {
      const bounds = option.getBoundingClientRect();
      const hit = document.elementFromPoint(
        Math.min(innerWidth - 1, Math.max(0, bounds.left + bounds.width / 2)),
        Math.min(innerHeight - 1, Math.max(0, bounds.top + bounds.height / 2)),
      );
      return hit === option || (hit instanceof Node && option.contains(hit));
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      trigger: rectangle(triggerElement, ".output-detail-trigger"),
      menu: rectangle(menuElement, ".output-detail-menu"),
      card: rectangle(cardElement, ".settings-card"),
      cardAllowsOverflow: getComputedStyle(cardElement).overflow === "visible",
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      optionCount: options.length,
      visibleOptionCount: visibleOptions.length,
      opensAbove: document.querySelector(".output-detail-select")?.classList.contains("open-above"),
    };
  })()`;
}

function settingsInteractionVisualAuditExpression() {
  return `(() => {
    const sections = document.querySelectorAll(".settings-section");
    const currentModelTop = sections[1]?.getBoundingClientRect().top ?? null;
    const previousModelTop =
      typeof window.__settingsModelTopBefore === "number"
        ? window.__settingsModelTopBefore
        : null;
    const visibleStatus = [...document.querySelectorAll(".application-preferences-status")].some(
      (element) => {
        const bounds = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return bounds.width > 0 && bounds.height > 0 && style.visibility !== "hidden";
      },
    );
    const controls = [...document.querySelectorAll(".application-preference input")];
    return {
      viewport: { width: innerWidth, height: innerHeight },
      disabledControls: controls.filter((control) => control.disabled).length,
      modelSectionShift:
        previousModelTop === null || currentModelTop === null
          ? null
          : Math.abs(currentModelTop - previousModelTop),
      savingAnnounced:
        document.querySelector('.visually-hidden[aria-live="polite"]')?.textContent?.includes(
          "Salvando",
        ) === true,
      thirdPreferenceChecked: controls[2]?.checked ?? null,
      visibleStatus,
    };
  })()`;
}

function profileVisualAuditExpression() {
  return `(() => {
    const rectangle = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        throw new Error("Elemento ausente: " + selector);
      }
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
        display: style.display,
        visibility: style.visibility,
      };
    };
    const overlaps = (left, right) =>
      left.left < right.right &&
      left.right > right.left &&
      left.top < right.bottom &&
      left.bottom > right.top;
    const chrome = rectangle(".window-chrome");
    const content = rectangle(".application-frame-content");
    const controls = rectangle(".window-chrome-controls");
    const overlay = rectangle(".settings-overlay");
    const navigation = rectangle(".settings-nav");
    const main = rectangle(".settings-main");
    const page = rectangle(".profile-settings-page");
    const heading = rectangle(".profile-settings-page > .settings-heading");
    const surface = rectangle(".profile-page");
    const profileContent = rectangle(".profile-page-content");
    const avatar = rectangle(".profile-identity .account-avatar-profile");
    const summary = rectangle(".profile-summary");
    const activity = rectangle(".profile-activity-chart");
    const activityGrid = rectangle(".profile-activity-grid");
    const insights = rectangle(".profile-insights-grid");
    const surfaceElement = document.querySelector(".profile-page-scroll");
    const settingsMainElement = document.querySelector(".settings-main");
    if (!(surfaceElement instanceof HTMLElement) || !(settingsMainElement instanceof HTMLElement)) {
      throw new Error("Contêiner de rolagem do perfil ausente.");
    }
    const cells = [...document.querySelectorAll(".profile-activity-cell")];
    return {
      viewport: { width: innerWidth, height: innerHeight },
      chrome,
      content,
      controls,
      overlay,
      navigation,
      main,
      page,
      heading,
      surface,
      profileContent,
      avatar,
      summary,
      activity,
      activityGrid,
      insights,
      chromeOverlapsSettings: overlaps(chrome, overlay),
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      settingsHorizontalOverflow:
        settingsMainElement.scrollWidth - settingsMainElement.clientWidth,
      surfaceHorizontalOverflow: surfaceElement.scrollWidth - surfaceElement.clientWidth,
      centeredInsetDifference: Math.abs(
        profileContent.left - page.left - (page.right - profileContent.right),
      ),
      summaryStats: document.querySelectorAll(".profile-summary-stat").length,
      activityCells: cells.length,
      activeCells: cells.filter((cell) => cell.getAttribute("data-level") !== "0").length,
      futureCells: cells.filter((cell) => cell.classList.contains("future")).length,
      expectedFutureCells: 6 - new Date().getUTCDay(),
      monthLabels: document.querySelectorAll(".profile-activity-months span").length,
      activityTabs: document.querySelectorAll(".profile-activity-tabs button").length,
      selectedActivityTabs: document.querySelectorAll(
        '.profile-activity-tabs button[aria-pressed="true"]',
      ).length,
      insightRows: document.querySelectorAll(".profile-insight-list > div").length,
      invocationRows: document.querySelectorAll(".profile-invocation-list li").length,
      profileAvatarImages: document.querySelectorAll(
        ".profile-identity .account-avatar-profile img",
      ).length,
      selectedProfileNavigation: [...document.querySelectorAll(
        '.settings-nav nav button[aria-current="page"]',
      )].filter((button) => button.textContent?.trim() === "Perfil").length,
      planBadge: document.querySelector(".profile-plan-badge")?.textContent?.trim() ?? null,
      loadingStates: document.querySelectorAll(".profile-skeleton, .profile-load-error").length,
    };
  })()`;
}

function automationsVisualAuditExpression() {
  return `(() => {
    const rectangle = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        throw new Error("Elemento ausente: " + selector);
      }
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
        display: style.display,
        visibility: style.visibility,
        fontSize: style.fontSize,
      };
    };
    const chrome = rectangle(".window-chrome");
    const content = rectangle(".application-frame-content");
    const controls = rectangle(".window-chrome-controls");
    const sidebar = rectangle(".sidebar");
    const sidebarTitlebar = rectangle(".sidebar-titlebar");
    const sidebarBrand = rectangle(".sidebar-brand");
    const primaryNavigation = rectangle(".sidebar-primary-nav");
    const surface = rectangle(".automations-view");
    const header = rectangle(".automations-header");
    const heading = rectangle(".automations-header h1");
    const notice = rectangle(".automation-local-notice");
    const card = rectangle(".automation-card");
    const mainPanel = document.querySelector(".main-panel");
    const surfaceElement = document.querySelector(".automations-view");
    if (!(surfaceElement instanceof HTMLElement) || !(mainPanel instanceof HTMLElement)) {
      throw new Error("Superfície de Automações ou painel principal ausente.");
    }
    const mainPanelStyle = getComputedStyle(mainPanel);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      chrome,
      content,
      controls,
      sidebar,
      sidebarTitlebar,
      sidebarBrand,
      primaryNavigation,
      surface,
      header,
      heading,
      notice,
      card,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      surfaceHorizontalOverflow: surfaceElement.scrollWidth - surfaceElement.clientWidth,
      activeNavigationItems: document.querySelectorAll(
        '.automation-nav-button[aria-current="page"]',
      ).length,
      unreadBadges: document.querySelectorAll(".sidebar-automation-badge").length,
      automationCards: document.querySelectorAll(".automation-card").length,
      runRows: document.querySelectorAll(".automation-run-row").length,
      primaryButtons: document.querySelectorAll(".automations-header .automation-primary-button").length,
      sidebarDividerWidth: mainPanelStyle.borderLeftWidth,
      sidebarDividerColor: mainPanelStyle.borderLeftColor,
    };
  })()`;
}

function automationEditorVisualAuditExpression() {
  return `(() => {
    const rectangle = (selector) => {
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        throw new Error("Elemento ausente: " + selector);
      }
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
        display: style.display,
        visibility: style.visibility,
        fontSize: style.fontSize,
      };
    };
    const chrome = rectangle(".window-chrome");
    const content = rectangle(".application-frame-content");
    const controls = rectangle(".window-chrome-controls");
    const backdrop = rectangle(".automation-editor-backdrop");
    const editor = rectangle(".automation-editor");
    const heading = rectangle(".automation-editor h2");
    const prompt = rectangle(".automation-editor textarea");
    const editorElement = document.querySelector(".automation-editor");
    const switchElement = document.querySelector('.automation-enabled-field input[role="switch"]');
    if (!(editorElement instanceof HTMLElement) || !(switchElement instanceof HTMLInputElement)) {
      throw new Error("Controles do editor de Automação ausentes.");
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      chrome,
      content,
      controls,
      backdrop,
      editor,
      heading,
      prompt,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      editorHorizontalOverflow: editorElement.scrollWidth - editorElement.clientWidth,
      dialogCount: document.querySelectorAll('.automation-editor[role="dialog"][aria-modal="true"]').length,
      namedFields: document.querySelectorAll(".automation-editor input, .automation-editor textarea, .automation-editor select").length,
      footerButtons: document.querySelectorAll(".automation-editor footer button").length,
      switchAriaChecked: switchElement.getAttribute("aria-checked"),
    };
  })()`;
}

function validateChatReferenceMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado no chat em ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "o chat criou overflow horizontal global");
  assert(
    metrics.timelineHorizontalOverflow <= tolerance,
    "a timeline criou overflow horizontal",
  );
  assert(
    metrics.userBubble.top - metrics.timelineInner.top >= 28 &&
      metrics.userBubble.top - metrics.timelineInner.top <= 36,
    "o início da conversa não respeita o espaçamento superior enxuto",
  );
  assert(
    metrics.threadContentMaxWidth === "768px",
    "a largura física oficial equivalente a 48rem foi alterada",
  );
  assert(
    metrics.timelineInner.width <= 768 + tolerance && metrics.timelineInner.width >= 560,
    "a coluna da conversa saiu da largura oficial responsiva",
  );
  assert(
    metrics.userBubbleStyle.backgroundColor === "rgb(34, 34, 34)",
    "a bolha do usuário não usa #222222",
  );
  assert(metrics.userBubbleStyle.borderRadius === "12px", "o raio da bolha não mede 12px");
  assert(metrics.userBubbleStyle.borderTopWidth === "0px", "a bolha ganhou borda indevida");
  assert(
    metrics.userBubbleStyle.paddingTop === "9px" &&
      metrics.userBubbleStyle.paddingRight === "12px" &&
      metrics.userBubbleStyle.paddingBottom === "9px" &&
      metrics.userBubbleStyle.paddingLeft === "12px",
    "o padding da bolha do usuário divergiu da referência",
  );
  assert(metrics.durationStyle.fontSize === "14px", "a duração não usa tipografia de 14px");
  assert(metrics.durationStyle.fontWeight === "400", "a duração ficou pesada demais");
  assert(
    metrics.durationStyle.color === "rgb(144, 144, 144)",
    "a duração não usa o cinza #909090",
  );
  assert(metrics.divider.height <= 1 + tolerance, "o divisor do turno ficou espesso");
  assert(
    metrics.dividerStyle.backgroundColor === "rgb(45, 45, 45)",
    "o divisor do turno não usa #2d2d2d",
  );
  assert(metrics.commentaryStyle.fontSize === "14px", "o commentary não usa 14px");
  assert(metrics.commentaryStyle.lineHeight === "22.4px", "o commentary não usa line-height 1.6");
  assert(
    metrics.commentaryStyle.color === "rgb(223, 223, 223)",
    "o commentary não usa #dfdfdf",
  );
  assert(
    metrics.commentaryStyle.fontFamily.includes("OpenAI Sans"),
    "o chat deixou de priorizar OpenAI Sans",
  );
  assert(metrics.activityStyle.fontSize === "14px", "a atividade não usa 14px");
  assert(metrics.activityStyle.fontWeight === "400", "a atividade ficou pesada demais");
  assert(
    metrics.activityStyle.color === "rgb(144, 144, 144)",
    "a atividade não usa #909090",
  );
  assert(
    metrics.firstCommandText?.startsWith("Comando executado: Get-Content -Raw docs/RULES.md"),
    "o primeiro comando não usa a semântica oficial",
  );
  assert(metrics.terminalReadText === "Terminal do chat lido", "a leitura de terminal está incorreta");
  assert(
    JSON.stringify(metrics.groupSummaries) ===
      JSON.stringify(["Executou comandos", "Executou comandos e leu o terminal do chat"]),
    "os resumos semânticos das atividades divergiram",
  );
  assert(metrics.commentaryCount === 3, "o cenário não renderizou os três commentaries");
  assert(metrics.commandRowCount === 7, "a expansão não renderizou os comandos esperados");
  assert(metrics.activityGroupCount === 2, "a timeline não criou os dois grupos oficiais");
  assert(metrics.openActivityGroupCount === 1, "mais de um grupo ficou expandido");
  assert(metrics.turnExpanded === true, "o trabalho do turno não ficou expandido");
  assert(metrics.timelineAriaLabel === "Conversa", "a timeline perdeu seu nome acessível");
  assert(metrics.articleCount === 5, "as mensagens deixaram de usar artigos semânticos");
  assert(metrics.detailsCount >= 9, "os disclosures de atividade ficaram incompletos");
  assert(metrics.workOrderIsCorrect === true, "a ordem visual do turno foi alterada");
  assert(
    metrics.bodyText.includes("Trabalhou por 1 min 34 s") &&
      metrics.bodyText.includes("Auditoria rápida concluída"),
    "o turno de referência ficou incompleto",
  );
}

function validateComposerFastModeMetrics(metrics, viewport) {
  const tolerance = 1;
  validateChromeMetrics(metrics, viewport);
  assert(metrics.horizontalOverflow <= tolerance, "o compositor criou overflow horizontal");
  assert(metrics.buttonHorizontalOverflow <= tolerance, "o seletor do modelo recorta seu conteúdo");
  assert(metrics.indicatorCount === 1, "o modo rápido não exibe exatamente um indicador");
  assert(metrics.accessibleLabel === true, "o indicador rápido não possui descrição acessível");
  assert(
    metrics.indicator.right <= metrics.name.left + tolerance,
    "o raio não está à esquerda do nome do modelo",
  );
  assert(
    metrics.name.left - metrics.indicator.right <= 8 + tolerance,
    "o raio ficou distante demais do nome do modelo",
  );
  assert(
    Math.abs(
      (metrics.indicator.top + metrics.indicator.bottom) / 2 -
        (metrics.name.top + metrics.name.bottom) / 2,
    ) <= tolerance,
    "o raio não está centralizado com o nome do modelo",
  );
  assert(metrics.indicator.width >= 12, "o raio ficou pequeno demais");
  assert(metrics.fullAccessColor === "rgb(251, 106, 34)", "Acesso completo perdeu o laranja");
  assert(metrics.projectIconColor === "rgb(74, 222, 128)", "a cor do ícone do projeto não foi aplicada");
  assert(metrics.diffAddedColor === "#4ade80", "adições não usam o verde-limão semântico");
  assert(metrics.diffDeletedColor === "#ff6764", "remoções não usam o vermelho semântico");
}

function validateActiveActivityReflectionMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado na reflexão em ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "a reflexão criou overflow horizontal");
  assert(metrics.reducedMotion === false, "a auditoria de movimento não normalizou a preferência");
  assert(
    metrics.titleText === metrics.baseText + metrics.highlightText,
    "a camada visual perdeu o texto do título",
  );
  assert(metrics.baseText === metrics.highlightText, "o reflexo não replica o título ativo");
  assert(
    /^Comando em execução há (?:\d+s|\d+m \d+s|\d+h \d+m \d+s)$/u.test(metrics.baseText),
    `o comando longo não exibe duração no título (${JSON.stringify(metrics.baseText)})`,
  );
  assert(
    metrics.sweepLayerCount === 1 && metrics.highlightLayerCount === 1,
    "a variante de 21 de agosto não manteve uma única faixa visual",
  );
  assert(
    metrics.obsoleteLayerCount === 0,
    "camadas de animações posteriores continuam montadas",
  );
  assert(
    metrics.titleColor === metrics.completedTitleColor &&
      metrics.titleColor === "rgb(144, 144, 144)",
    `o texto-base ativo não acompanha a atividade concluída: ${JSON.stringify({
      active: metrics.titleColor,
      completed: metrics.completedTitleColor,
      reference: metrics.completedTitleText,
    })}`,
  );
  assert(
    metrics.titleFontWeight === metrics.completedTitleFontWeight &&
      metrics.titleFontWeight === "400",
    `o peso do texto-base ativo não acompanha a atividade concluída: ${JSON.stringify({
      active: metrics.titleFontWeight,
      completed: metrics.completedTitleFontWeight,
    })}`,
  );
  assert(metrics.highlightColor === "rgb(255, 255, 255)", "o brilho deixou de usar branco");
  assert(metrics.titleFontSize === "14px", "o título histórico não mede 14 px");
  assert(
    metrics.titleDisplay === "block",
    "o título animado não foi blockificado corretamente como item flex",
  );
  assert(
    metrics.sweepAnimationName === "activity-reflection-sweep" &&
      metrics.highlightAnimationName === "activity-reflection-text",
    "as duas transformações sincronizadas da reflexão estão ausentes",
  );
  assert(metrics.animationDuration === "1s", "o pulso do reflexo não mede 1 segundo");
  assert(metrics.animationDelay === "0s", "o pulso CSS manteve um atraso residual");
  assert(
    metrics.animationTimingFunction.includes("steps(48"),
    "o pulso perdeu a progressão oficial em 48 passos",
  );
  assert(metrics.animationIterationCount === "1", "a reflexão voltou a repetir continuamente");
  assert(
    metrics.keyframeEasings.length >= 2,
    `os keyframes da passagem estão ausentes: ${JSON.stringify(metrics.keyframeEasings)}`,
  );
  assert(
    metrics.sidebarItemGaps.length > 0 &&
      metrics.sidebarItemGaps.every((gap) => gap !== null && gap >= 3.5),
    `os itens da sidebar continuam visualmente colados: ${JSON.stringify(metrics.sidebarItemGaps)}`,
  );
  assert(
    metrics.selectedThreadBackground === "rgba(255, 255, 255, 0.12)",
    `a seleção do chat não usa a superfície forte: ${metrics.selectedThreadBackground}`,
  );
  assert(
    metrics.selectedThreadBoxShadow !== null && metrics.selectedThreadBoxShadow !== "none",
    "a seleção do chat perdeu o contorno de separação",
  );
  assert(metrics.planExplanationCount === 0, "a explicação redundante do plano ainda está visível");
  assert(
    metrics.maskImage.includes("linear-gradient") &&
      metrics.maskImage.includes("20%") &&
      metrics.maskImage.includes("30%") &&
      metrics.maskImage.includes("50%"),
    `a máscara de 21 de agosto foi alterada: ${metrics.maskImage}`,
  );
  assert(
    metrics.passPositions.length === 2 && new Set(metrics.passPositions).size === 2,
    `a faixa não atravessou o título: ${JSON.stringify(metrics.passPositions)}`,
  );
  assert(
    metrics.pausePositions.length === 3 && new Set(metrics.pausePositions).size === 3,
    `a faixa ficou presa antes de concluir a travessia: ${JSON.stringify(metrics.pausePositions)}`,
  );
  assert(
    metrics.alignmentError !== null && metrics.alignmentError <= tolerance,
    `o texto luminoso saiu do alinhamento: ${metrics.alignmentError}`,
  );
  assert(metrics.ariaHidden === "true", "a faixa decorativa entrou na árvore acessível");
  assert(metrics.pointerEvents === "none", "a reflexão passou a interceptar interação");
}

function validateUserMessageNavigationMetrics(metrics, viewport) {
  const tolerance = 2;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado na navegação de mensagens em ${viewport.width}x${viewport.height}`,
  );
  assert(
    metrics.horizontalOverflow <= tolerance,
    "a navegação de mensagens criou overflow horizontal",
  );
  assert(
    Math.abs(metrics.targetGap - metrics.expectedTargetGap) <= tolerance,
    `o marcador não navegou para a posição atual possível da mensagem: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.targetOffsetWithinTurn > 500,
    "o cenário não validou uma mensagem posterior dentro do mesmo turno",
  );
  assert(metrics.markerCurrent === "true", "o marcador selecionado não ficou ativo");
  assert(metrics.expandedGroupCount >= 1, "o turno não permaneceu expandido durante a navegação");
}

function validateManualScrollOwnershipMetrics(metrics, viewport) {
  const tolerance = 2;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado no ownership de scroll em ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "o scroll manual criou overflow horizontal");
  assert(
    Math.abs(metrics.visualDrift) <= tolerance,
    `uma medição virtual deslocou o conteúdo que o usuário estava lendo: ${JSON.stringify(metrics)}`,
  );
  assert(
    Math.abs(metrics.compensationError) <= tolerance,
    `a correção de âncora não compensou exatamente a mudança de altura acima do viewport ` +
      `(altura ${metrics.heightDelta.toFixed(3)} px, scroll ` +
      `${metrics.scrollCompensation.toFixed(3)} px, erro ${metrics.compensationError.toFixed(3)} px)`,
  );
}

function validateNestedScrollHandoffMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado na transferência de scroll em ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "o handoff de scroll criou overflow horizontal");
  assert(metrics.styleReadCount === 0, "o wheel voltou a forçar leitura síncrona de estilos");
  assert(
    metrics.handoffDurationMs <= 2000,
    `três handoffs suaves não estabilizaram a tempo: ${metrics.handoffDurationMs.toFixed(3)} ms`,
  );
  for (const [label, sample] of Object.entries({
    comando: metrics.command,
    diff: metrics.diff,
    leitura: metrics.source,
  })) {
    assert(sample.defaultPrevented === true, `${label} não assumiu ownership do wheel excedente`);
    assert(
      Math.abs(sample.nestedScrollTop - sample.expectedNestedScroll) <= tolerance,
      `${label} não terminou no limite vertical esperado`,
    );
    assert(
      Math.abs(sample.timelineDelta - sample.expectedTimelineDelta) <= tolerance,
      `${label} não transferiu exatamente o delta excedente para a timeline`,
    );
    assert(sample.monotonic === true, `${label} inverteu a direção durante o handoff`);
    assert(
      sample.distinctTimelinePositions >= 3,
      `${label} concluiu o handoff sem passos visuais intermediários`,
    );
    assert(
      sample.maximumFrameDelta < Math.abs(sample.expectedTimelineDelta),
      `${label} aplicou todo o handoff em um único salto`,
    );
  }
}

function validateNestedScrollWheelOwnershipMetrics(metrics, viewport) {
  const tolerance = 2;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado no wheel nativo em ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "o wheel nativo criou overflow horizontal");
  for (const [label, sample] of Object.entries({
    diff: metrics.diff,
    leitura: metrics.source,
  })) {
    const { handoff, internal, reversal } = sample;
    assert(
      internal.events.length === 4,
      `${label} não recebeu os quatro eventos reais de wheel interno`,
    );
    assert(
      internal.events.every((event) => event.cancelable === true),
      `${label} recebeu wheel não cancelável apesar do listener explícito`,
    );
    assert(
      internal.events.every((event) => event.defaultPrevented === false),
      `${label} perdeu o scroll nativo mesmo com faixa interna disponível`,
    );
    assert(
      Math.abs(internal.nestedDelta - internal.expectedNestedDelta) <= tolerance,
      `${label} consumiu ${internal.nestedDelta}px em vez de ${internal.expectedNestedDelta}px`,
    );
    assert(
      Math.abs(internal.timelineDelta) <= tolerance,
      `${label} também deslocou a timeline em ${internal.timelineDelta}px`,
    );
    assert(
      internal.canvasIdentityChanged === false,
      `${label} substituiu o canvas virtual durante o wheel interno`,
    );
    assert(
      internal.rowIdentityComparisons > 0 && internal.mountedRows > 0,
      `${label} não preservou linhas sobrepostas suficientes para validar identidade`,
    );
    assert(
      internal.rowIdentityChanges === 0,
      `${label} remontou ${internal.rowIdentityChanges} linhas ainda visíveis durante o scroll`,
    );
    assert(
      handoff.events.length === 4,
      `${label} não recebeu os quatro eventos reais de wheel no limite`,
    );
    assert(
      handoff.events.every((event) => event.cancelable === true),
      `${label} recebeu wheel não cancelável durante o handoff`,
    );
    assert(
      handoff.events.every((event) => event.defaultPrevented === true),
      `${label} não transferiu deterministicamente o wheel excedente à timeline`,
    );
    assert(
      Math.abs(handoff.nestedDelta) <= tolerance,
      `${label} saiu do limite interno em ${handoff.nestedDelta}px durante o handoff`,
    );
    assert(
      Math.abs(handoff.timelineDelta - handoff.expectedTimelineDelta) <= tolerance,
      `${label} transferiu ${handoff.timelineDelta}px à timeline em vez de ${handoff.expectedTimelineDelta}px`,
    );
    assert(handoff.monotonic, `${label} inverteu a direção durante o handoff`);
    assert(
      handoff.distinctTimelinePositions >= 3,
      `${label} concluiu o handoff sem passos visuais intermediários`,
    );
    assert(
      handoff.maximumFrameDelta < Math.abs(handoff.expectedTimelineDelta),
      `${label} aplicou todo o handoff em um único salto`,
    );
    assert(
      reversal.events.length === 2,
      `${label} não recebeu o par real de wheel usado na reversão`,
    );
    assert(
      reversal.events.every((event) => event.cancelable === true),
      `${label} recebeu wheel não cancelável durante a reversão`,
    );
    assert(
      reversal.events[0]?.defaultPrevented === true,
      `${label} não iniciou o handoff antes da reversão`,
    );
    assert(
      reversal.events[1]?.defaultPrevented === false,
      `${label} não devolveu a direção inversa ao scroll nativo interno`,
    );
    assert(
      Math.abs(reversal.nestedDelta - reversal.expectedNestedDelta) <= tolerance,
      `${label} moveu ${reversal.nestedDelta}px internamente após reverter, esperado ${reversal.expectedNestedDelta}px`,
    );
    assert(
      Math.sign(reversal.handoffDelta) * reversal.timelineDelta >= -tolerance,
      `${label} inverteu indevidamente a timeline após devolver o wheel ao conteúdo interno`,
    );
    assert(
      Math.abs(reversal.timelineDelta) < Math.abs(reversal.handoffDelta) - tolerance,
      `${label} deixou a animação antiga alcançar o destino depois da reversão`,
    );
    assert(
      reversal.postCancelRange <= tolerance,
      `${label} continuou derivando ${reversal.postCancelRange}px depois de cancelar o handoff`,
    );
  }
}

function validateNestedScrollFollowingMetrics(metrics, viewport) {
  const tolerance = 2;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado no acompanhamento de scroll interno em ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "o scroll interno criou overflow horizontal");
  assert(
    metrics.defaultPrevented === false,
    "uma região interna impediu wheel que cabia integralmente em sua própria faixa",
  );
  assert(
    Math.abs(metrics.nestedDelta - metrics.expectedNestedDelta) <= tolerance,
    "a região interna não consumiu integralmente seu próprio wheel",
  );
  assert(
    Math.abs(metrics.timelineDelta - 160) <= tolerance,
    `a timeline deslocou ${metrics.timelineDelta}px em vez de 160px após o crescimento (distância final ${metrics.distanceToEnd}px)`,
  );
  assert(
    Math.abs(metrics.distanceToEnd) <= tolerance,
    "a timeline ficou destacada do fim após crescimento de conteúdo",
  );
}

function validateLiveCommandOutputMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado na saída ao vivo em ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "a saída ao vivo criou overflow horizontal");
  assert(
    metrics.commandHorizontalOverflow <= tolerance,
    "a saída ao vivo criou overflow horizontal no comando",
  );
  assert(metrics.open === true, "o comando em execução não ficou expandido");
  assert(
    /^Comando em execução há (?:\d+s|\d+m \d+s|\d+h \d+m \d+s)$/u.test(metrics.title),
    `o comando aberto perdeu seu estado ou duração (${JSON.stringify(metrics.title)})`,
  );
  assert(
    metrics.prompt?.includes("Get-Content -LiteralPath src/ui/Timeline.tsx -Raw"),
    "o comando original não aparece junto da saída ao vivo",
  );
  assert(
    metrics.outputText.includes("stdout:") &&
      metrics.outputText.includes("✓ 115 modules transformed.") &&
      metrics.outputText.includes("computing gzip size...") &&
      metrics.outputText.includes("stderr:") &&
      metrics.outputText.includes("warning: release validation is still running"),
    "stdout e stderr incrementais não estão visíveis antes da conclusão",
  );
  assert(metrics.hasFinalOutputView === false, "a prévia ao vivo foi confundida com a saída final");
  assert(metrics.scrollable === true, "a saída longa não ativou a rolagem limitada");
  assert(metrics.followGap <= 2, "a saída ao vivo não acompanhou a linha mais recente");
  assert(metrics.maximumHeight === "205px", "a saída ao vivo perdeu seu limite vertical");
  assert(metrics.whiteSpace === "pre-wrap", "a saída ao vivo não preserva quebras de linha");
}

function validateSingleFileChangeMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado no arquivo único em ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "o arquivo único criou overflow horizontal");
  assert(metrics.fileName === "engine.rs", "o arquivo direto mudou de identidade");
  assert(
    metrics.action === "Arquivo editado",
    "a alteração única perdeu o rótulo Arquivo editado",
  );
  assert(metrics.compact === true, "a alteração única não usa a apresentação compacta");
  assert(metrics.hasActivityIcon === true, "a alteração única perdeu o ícone contextual");
  assert(metrics.borderTopWidth === "0px", "a alteração única recuperou o contorno de cartão");
  assert(metrics.borderRadius === "0px", "a alteração única recuperou cantos de balão");
  assert(
    metrics.backgroundColor === "rgba(0, 0, 0, 0)",
    "a alteração única recuperou uma superfície de cartão",
  );
  assert(
    metrics.groupedAction === "Arquivo editado",
    "a alteração interna perdeu o rótulo Arquivo editado",
  );
  assert(
    metrics.groupedHasActivityIcon === true,
    "a alteração interna perdeu o ícone contextual do grupo",
  );
  assert(
    metrics.groupedHasRedundantHeading === false,
    "o grupo manteve o cabeçalho redundante de contagem de arquivos",
  );
  assert(
    metrics.groupedDirectFileCount === 3,
    "o grupo não expôs os arquivos imediatamente após a primeira expansão",
  );
  assert(
    metrics.groupedNestedCollectionCount === 0,
    "o grupo de arquivos manteve uma expansão intermediária redundante",
  );
  assert(
    metrics.newFileAction === "Arquivo criado",
    "o arquivo novo perdeu a semântica Arquivo criado",
  );
  assert(metrics.newFileBadge === "NOVO", "o arquivo novo perdeu o selo NOVO");
  assert(metrics.newFileAdditions === "+256", "o arquivo novo perdeu a contagem de linhas");
  assert(metrics.newFileHasDeletions === false, "o arquivo novo ainda exibe uma remoção zerada");
  assert(
    metrics.deletedFileAction === "Arquivo excluído",
    "o arquivo excluído perdeu a semântica Arquivo excluído",
  );
  assert(metrics.deletedFileBadge === "EXCLUÍDO", "o arquivo excluído perdeu seu selo");
  assert(
    metrics.deletedFileDeletions === "-288",
    "o arquivo excluído não exibe o total autoritativo de linhas removidas",
  );
  assert(
    metrics.deletedFileHasAdditions === false,
    "o arquivo excluído ainda exibe uma adição zerada",
  );
  assert(metrics.open === false, "a alteração única iniciou expandida");
  assert(metrics.aggregateContainerCount === 0, "a alteração única ainda criou um agrupador");
  assert(metrics.directDiffVisible === false, "o diff do arquivo único iniciou visível");
  validateIntrinsicActivityInteraction(metrics.intrinsicInteraction, "alteração", tolerance);
}

function validateIntrinsicActivityInteraction(interaction, label, tolerance) {
  assert(
    interaction?.rest !== undefined &&
      interaction.far !== undefined &&
      interaction.hover !== undefined,
    `a interação intrínseca da ${label} não foi capturada`,
  );
  assert(
    interaction.rest.summaryWidth + 40 < interaction.rest.rowWidth,
    `a área interativa da ${label} ainda ocupa a fileira inteira`,
  );
  assert(
    interaction.rest.expanded === interaction.far.expanded &&
      interaction.rest.expanded === interaction.hover.expanded,
    `a interação alterou indevidamente o estado expandido da ${label}`,
  );
  const restingChevronOpacity = interaction.rest.expanded ? 1 : 0;
  assert(
    interaction.rest.chevronOpacity === restingChevronOpacity &&
      interaction.far.chevronOpacity === restingChevronOpacity,
    interaction.rest.expanded
      ? `a seta da ${label} expandida não permaneceu visível`
      : `a seta da ${label} ficou visível sem proximidade real`,
  );
  assert(
    interaction.rest.hovered === false && interaction.far.hovered === false,
    `uma posição distante ativou indevidamente o hover da ${label}`,
  );
  assert(
    interaction.hover.hovered === true && interaction.hover.chevronOpacity === 1,
    `a proximidade real da ${label} não revelou sua seta`,
  );
  assert(
    interaction.rest.actionColor === interaction.rest.identityColor &&
      interaction.rest.iconColor === interaction.rest.actionColor,
    `a ${label} não usa uma cor discreta uniforme em repouso`,
  );
  assert(
    interaction.hover.actionColor === interaction.hover.identityColor &&
      interaction.hover.iconColor === interaction.hover.actionColor &&
      interaction.hover.actionColor !== interaction.rest.actionColor,
    `o hover não destacou semanticamente a ${label}`,
  );
  assert(
    Math.abs(interaction.hover.summaryWidth - interaction.rest.summaryWidth) <= tolerance,
    `a ${label} mudou de largura ao revelar sua seta`,
  );
}

function validateReviewFileLayoutMetrics(metrics, viewport) {
  const tolerance = 1;
  const maximumListHeight = Math.min(220, metrics.contentHeight * 0.32);
  const expectedMountedRows = Math.min(
    metrics.declaredRows,
    Math.ceil(metrics.diffViewportClientHeight / 20),
  );
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado na revisão em ${viewport.width}x${viewport.height}`,
  );
  validateWorkspaceSplitMetrics(
    metrics.workspaceSplit,
    "revisão",
    metrics.workspaceSplitInteraction,
  );
  assert(metrics.horizontalOverflow <= tolerance, "a revisão criou overflow horizontal global");
  assert(metrics.fileCount === 60, "a revisão não reuniu os sessenta arquivos alterados do turno");
  assert(metrics.fileListScrollable, "a lista extensa da revisão não preservou sua própria rolagem");
  assert(
    metrics.contentDisplay === "flex" &&
      metrics.contentFlexDirection === "column" &&
      metrics.contentContainerType === "size" &&
      metrics.fileListFlexGrow === "0" &&
      metrics.fileListFlexShrink === "1" &&
      metrics.stageFlexGrow === "1",
    "a revisão perdeu o ownership explícito entre a lista limitada e o estágio flexível",
  );
  assert(
    metrics.selectedFile?.endsWith("module-15.ts"),
    "a auditoria não selecionou o diff grande da revisão",
  );
  assert(
    metrics.fileListHeight <= maximumListHeight + tolerance,
    `a lista consumiu ${metrics.fileListHeight.toFixed(1)} px de ${metrics.contentHeight.toFixed(1)} px disponíveis`,
  );
  assert(
    Math.abs(metrics.contentHeight - metrics.fileListHeight - metrics.stageHeight) <= tolerance,
    "a lista e o estágio não dividem integralmente a área útil da revisão",
  );
  assert(
    Math.abs(metrics.stageHeight - metrics.headerHeight - metrics.diffViewportHeight) <= tolerance,
    "o diff não preenche a área restante abaixo do cabeçalho do arquivo",
  );
  assert(
    metrics.diffViewportSizing === "container" && metrics.diffViewportInlineHeight === "",
    "o diff da revisão voltou a disputar altura inline com o contêiner",
  );
  assert(
    metrics.diffViewportHeight >= Math.min(120, metrics.contentHeight * 0.4),
    `a viewport do diff ficou comprimida a ${metrics.diffViewportHeight.toFixed(1)} px`,
  );
  assert(
    metrics.mountedRows === expectedMountedRows &&
      metrics.mountedRowIndexes[0] === 1,
    `a janela virtual montou ${metrics.mountedRows} linhas para ${metrics.diffViewportClientHeight.toFixed(1)} px (${metrics.declaredRows} declaradas)`,
  );
  assert(
    metrics.rowGaps.every((gap) => Math.abs(gap - 20) <= tolerance),
    "as linhas montadas na revisão perderam o passo virtual de 20 px",
  );
  assert(
    metrics.tableRole === "table" &&
      metrics.rowGroupRole === "rowgroup" &&
      metrics.rowRoles.every((role) => role === "row") &&
      metrics.rowCellRoles.every(
        (roles) => JSON.stringify(roles) === JSON.stringify(["rowheader", "cell"]),
      ),
    "o diff unificado perdeu sua grade semântica independente de tabelas nativas",
  );
  assert(
    metrics.canvasHeight >= metrics.diffViewportScrollHeight - tolerance,
    "o canvas virtual da revisão ficou menor que sua área rolável",
  );
  const virtualizationCycle = metrics.virtualizationCycle;
  const virtualizationPhases = [
    virtualizationCycle?.initial,
    virtualizationCycle?.bottom,
    virtualizationCycle?.restored,
  ];
  assert(
    virtualizationPhases.every(
      (phase) =>
        phase !== undefined &&
        Math.abs(phase.canvasHeight - virtualizationCycle.initial.canvasHeight) <= tolerance &&
        phase.clientHeight === virtualizationCycle.initial.clientHeight &&
        Math.abs(phase.scrollHeight - virtualizationCycle.initial.scrollHeight) <= tolerance &&
        phase.rowGaps.every((gap) => Math.abs(gap - 20) <= tolerance) &&
        phase.rowInlineTops.every((top) => /^\d+px$/u.test(top ?? "")),
    ),
    "a geometria virtual da revisão mudou durante a rolagem sob o CSP de produção",
  );
  assert(
    virtualizationCycle.initial.canvasHeight > virtualizationCycle.initial.clientHeight &&
      virtualizationCycle.initial.scrollTop === 0 &&
      virtualizationCycle.initial.mountedRowIndexes[0] === 1 &&
      virtualizationCycle.bottom.scrollTop > 0 &&
      virtualizationCycle.bottom.mountedRowIndexes[0] > 1 &&
      virtualizationCycle.restored.scrollTop === 0 &&
      virtualizationCycle.restored.mountedRowIndexes[0] === 1,
    "a revisão não preservou início, fim e retorno ao topo durante a rematerialização",
  );
}

function validateSyntaxHighlightedDiffMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado no diff colorido em ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "o diff colorido criou overflow horizontal");
  assert(metrics.viewportHorizontalOverflow >= 0, "a viewport do diff perdeu sua largura rolável");
  for (const kind of [
    "token-attribute",
    "token-constant",
    "token-function",
    "token-keyword",
    "token-number",
    "token-operator",
    "token-punctuation",
    "token-string",
    "token-type",
  ]) {
    assert(metrics.tokenKinds.includes(kind), `o diff não produziu ${kind}`);
  }
  assert(metrics.tokenCount >= 20, "o diff produziu poucos tokens sintáticos");
  assert(metrics.tokenColorCount >= 7, "a paleta sintática não possui cores distintas suficientes");
  assert(metrics.contextHasSyntax === true, "linhas de contexto não receberam syntax highlighting");
  assert(
    metrics.additionBackground === "rgb(31, 73, 50)",
    "o fundo semântico de adição não está sólido e nítido",
  );
  assert(
    metrics.deletionBackground === "rgb(82, 39, 37)",
    "o fundo semântico de remoção não está sólido e nítido",
  );
  assert(
    metrics.additionBackground !== metrics.deletionBackground,
    "adição e remoção perderam distinção visual",
  );
  assert(metrics.keywordColor === "#c77dff", "keywords não usam o roxo neon da paleta sintática");
  assert(metrics.stringColor === "#ffb38a", "strings não usam a paleta sintática");
  assert(
    metrics.expandedSummaryHasIdentity === false &&
      metrics.panelHeaderFile === "engine.rs" &&
      metrics.panelHeaderFileDecoration === "none" &&
      metrics.panelHeaderStats.length === 2,
    "o diff expandido não usa o cabeçalho interno enxuto do Codex",
  );
  assert(
    metrics.expandedSummaryAlignItems === "center" &&
      metrics.panelHeaderAlignItems === "center" &&
      metrics.expandedSummaryBorderBottomWidth === "0px" &&
      metrics.panelHeaderChildCenterOffsets.length === 3 &&
      metrics.panelHeaderChildCenterOffsets.every((offset) => Math.abs(offset) <= tolerance),
    "o cabeçalho do diff não centraliza verticalmente o arquivo e as estatísticas",
  );
  assert(
    Math.abs(metrics.panelHeaderHeight - 30) <= tolerance &&
      metrics.panelCopyLabel === "Copiar edição",
    "o cabeçalho interno do diff perdeu altura ou ação de copiar",
  );
  assert(
    metrics.panelBackground === "rgb(24, 24, 24)" &&
      metrics.viewportBackground === "rgba(0, 0, 0, 0)" &&
      metrics.viewportOpacity === "1" &&
      metrics.viewportFilter === "none" &&
      metrics.viewportBackdropFilter === "none",
    "o viewport do diff voltou a sobrepor uma segunda superfície ao código",
  );
  assert(
    metrics.additionCellBackground === "rgba(0, 0, 0, 0)" &&
      metrics.deletionCellBackground === "rgba(0, 0, 0, 0)",
    "as células voltaram a duplicar o preenchimento semântico da linha",
  );
  assert(
    metrics.additionRowWidth !== null &&
      metrics.deletionRowWidth !== null &&
      metrics.tableWidth !== null &&
      metrics.additionRowWidth + tolerance >= metrics.tableWidth &&
      metrics.deletionRowWidth + tolerance >= metrics.tableWidth &&
      Math.abs(metrics.additionRowRightGap) <= tolerance &&
      Math.abs(metrics.deletionRowRightGap) <= tolerance,
    "o preenchimento semântico não alcança o fim da largura rolável do diff",
  );
  assert(metrics.codeText?.includes("use std::time::Instant;"), "o diff perdeu o texto do código");
  assert(metrics.codeInset !== null && metrics.codeInset <= 64, "o gutter do diff continua largo demais");
  assert(
    metrics.lineNumberCellsPerRow.length > 0 &&
      metrics.lineNumberCellsPerRow.every((count) => count === 1),
    "o diff unificado não preserva uma única coluna semântica de números",
  );
  assert(
    metrics.lineNumberLeftSpread !== null && metrics.lineNumberLeftSpread <= tolerance,
    "a coluna numérica do diff perdeu o alinhamento vertical",
  );
  assert(
    metrics.lineNumberValues.every((value) => /^\d+$/u.test(value)),
    "o diff misturou marcadores de edição aos números de linha",
  );
  assert(
    metrics.lineNumberValues.some((value) => Number(value) >= 80),
    "a regressão visual não cobre números de linha com múltiplos dígitos",
  );
  assert(
    metrics.lineNumberContentOverflow.length > 0 &&
      metrics.lineNumberContentOverflow.every((overflow) => overflow <= tolerance),
    "o conteúdo numérico do diff está recortado",
  );
  assert(
    metrics.lineNumberContentContainment.every(
      (containment) =>
        containment !== null && containment.left >= -tolerance && containment.right >= -tolerance,
    ),
    "os números de linha escapam dos limites semânticos do gutter",
  );
  assert(
    metrics.lineNumberWidths.length > 0 &&
      Math.min(...metrics.lineNumberWidths) >= 30 &&
      Math.max(...metrics.lineNumberWidths) - Math.min(...metrics.lineNumberWidths) <= tolerance,
    "o gutter não mantém uma largura intrínseca estável",
  );
  assert(
    metrics.lineNumberBoxSizing === "border-box" &&
      Number.parseFloat(metrics.lineNumberPaddingLeft) > 0 &&
      Number.parseFloat(metrics.lineNumberPaddingRight) > 0 &&
      metrics.lineNumberDividerWidth === "0px" &&
      metrics.lineNumberBackground === metrics.additionBackground,
    "o gutter não forma uma faixa contínua com a linha alterada",
  );
  assert(
    metrics.changedIndicatorWidth === "4px" &&
      metrics.changedIndicatorPosition === "absolute",
    "a barra de alteração não está desacoplada da largura numérica",
  );
  assert(
    metrics.diffRowHeights.length > 0 && metrics.diffRowHeights.every((height) => height === 20),
    "as linhas do diff perderam a métrica vertical oficial de 20 px",
  );
  assert(
    metrics.diffRowTopOffsets.length > 1 &&
      metrics.diffRowTopOffsets.every(
        (top, index) => Math.abs(top - index * 20) <= tolerance,
      ) &&
      metrics.diffRowInlineTops.every((top, index) => top === `${index * 20}px`),
    "as linhas do diff não ocupam posições verticais consecutivas",
  );
  assert(
    metrics.diffCanvasHeight !== null &&
      metrics.diffCanvasHeight >= metrics.diffRowTopOffsets.length * 20 &&
      metrics.diffViewportHeight === metrics.diffViewportClientHeight &&
      metrics.diffViewportScrollHeight >= metrics.diffViewportClientHeight,
    "o canvas virtual do diff não representa a geometria rolável do documento",
  );
  assert(metrics.viewportHorizontalOverflow > 0, "a regressão não exercitou rolagem horizontal");
  assert(
    metrics.stickyGutterMovement !== null &&
      metrics.stickyGutterMovement <= tolerance &&
      metrics.stickyOffsetFromViewport !== null &&
      Math.abs(metrics.stickyOffsetFromViewport) <= tolerance,
    "o gutter numérico não permanece fixo durante a rolagem horizontal",
  );
  assert(metrics.markerCellCount === 0, "o diff mantém marcadores de edição redundantes");
  assert(metrics.newlineMetadataRows === 0, "metadados de newline ainda consomem linhas visuais");
  assert(
    metrics.structuralMetadataRows === 0 && metrics.containsStructuralMetadata === false,
    "metadados estruturais do patch ainda consomem linhas visuais",
  );
}

function validateSyntaxHighlightedCreatedFileMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado no arquivo criado colorido em ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "o arquivo criado gerou overflow horizontal");
  for (const kind of ["token-attribute", "token-keyword", "token-number", "token-type"]) {
    assert(metrics.tokenKinds.includes(kind), `o arquivo criado não produziu ${kind}`);
  }
  assert(metrics.tokenCount >= 20, "o arquivo criado produziu poucos tokens sintáticos");
  assert(metrics.tokenColorCount >= 4, "o arquivo criado não usa uma paleta sintática suficiente");
  assert(metrics.additionRows > 0, "o arquivo criado não renderizou linhas adicionadas");
  assert(metrics.deletionRows === 0, "o arquivo criado inventou linhas removidas");
  assert(metrics.newlineMetadataRows === 0, "o arquivo criado exibe metadado de newline redundante");
  assert(
    metrics.structuralMetadataRows === 0 && metrics.containsStructuralMetadata === false,
    "o arquivo criado ainda exibe metadados estruturais redundantes",
  );
  assert(metrics.codeInset <= 64, "o arquivo criado mantém um gutter largo demais");
  assert(
    metrics.lineNumberCellsPerRow.length > 0 &&
      metrics.lineNumberCellsPerRow.every((count) => count === 1),
    "o arquivo criado não preserva uma única coluna numérica",
  );
  assert(metrics.markerCellCount === 0, "o arquivo criado mantém marcadores redundantes");
}

function validateHighlightedToolOutputMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado nas saídas coloridas em ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "as saídas tipadas criaram overflow global");
  assert(
    JSON.stringify(metrics.sourceLineNumbers) ===
      JSON.stringify(["20", "21", "22", "23", "24", "25", "26", "27", "28", "29"]),
    "a leitura de arquivo perdeu seus números de linha",
  );
  assert(metrics.sourceTokenKinds.includes("token-keyword"), "a leitura de arquivo não coloriu keywords");
  assert(metrics.sourceTokenKinds.includes("token-string"), "a leitura de arquivo não coloriu strings");
  assert(metrics.searchTokenKinds.includes("token-keyword"), "a busca não coloriu os trechos encontrados");
  assert(metrics.sourceText.includes("const continuation"), "a leitura perdeu o código original");
  assert(metrics.searchText.includes("src/ui/syntax/diffHighlighter.test.ts:20"), "a busca perdeu a localização");
  assert(metrics.sourceHorizontalOverflow >= 0, "a leitura perdeu sua largura rolável");
  assert(metrics.searchHorizontalOverflow >= 0, "a busca perdeu sua largura rolável");
  assert(
    metrics.sourceTableRole === "table" &&
      metrics.sourceRowGroupRole === "rowgroup" &&
      metrics.sourceRowRoles.every((role) => role === "row") &&
      metrics.sourceCellRoles.every(
        (roles) => JSON.stringify(roles) === JSON.stringify(["rowheader", "cell"]),
      ),
    "a leitura perdeu sua grade semântica independente de tabelas nativas",
  );
  assert(
    metrics.sourceMountedRowIndexes.length === 10 &&
      metrics.sourceMountedRowIndexes[0] === 1 &&
      metrics.sourceMountedRowIndexes.at(-1) === 10,
    "a leitura não materializou exatamente a janela visível esperada",
  );
  assert(
    metrics.sourceRowGaps.length === 9 &&
      metrics.sourceRowGaps.every((gap) => Math.abs(gap - 22) <= tolerance),
    "as linhas da leitura se sobrepõem ou perderam o passo virtual de 22 px",
  );
  assert(
    metrics.sourceInlineOverlapCount === 0,
    "os fragmentos sintáticos da leitura se sobrepõem na mesma linha",
  );
  assert(
    metrics.sourceCanvasHeight >= metrics.sourceViewportScrollHeight - tolerance &&
      metrics.sourceViewportClientHeight === 205,
    "o canvas da leitura não representa integralmente sua faixa virtual",
  );
  const virtualizationCycle = metrics.sourceVirtualizationCycle;
  const virtualizationPhases = [
    virtualizationCycle?.firstOpen,
    virtualizationCycle?.reopened,
    virtualizationCycle?.bottom,
    virtualizationCycle?.restored,
  ];
  assert(
    virtualizationPhases.every(
      (phase) =>
        phase !== undefined &&
        Math.abs(phase.canvasHeight - 56 * 22) <= tolerance &&
        phase.clientHeight === 205 &&
        Math.abs(phase.scrollHeight - 56 * 22) <= tolerance &&
        phase.rowGaps.length === 9 &&
        phase.rowGaps.every((gap) => Math.abs(gap - 22) <= tolerance) &&
        phase.rowInlineTops.every((top) => /^\d+px$/u.test(top ?? "")),
    ),
    "a geometria virtual mudou ao reabrir ou rolar a leitura sob o CSP de produção",
  );
  assert(
    virtualizationCycle.firstOpen.mountedRowIndexes[0] === 1 &&
      virtualizationCycle.firstOpen.lineNumbers[0] === "20" &&
      virtualizationCycle.reopened.mountedRowIndexes[0] === 1 &&
      virtualizationCycle.reopened.lineNumbers[0] === "20" &&
      virtualizationCycle.bottom.scrollTop > 0 &&
      virtualizationCycle.bottom.mountedRowIndexes[0] > 1 &&
      virtualizationCycle.bottom.lineNumbers.at(-1) === "75" &&
      virtualizationCycle.restored.scrollTop === 0 &&
      virtualizationCycle.restored.mountedRowIndexes[0] === 1 &&
      virtualizationCycle.restored.lineNumbers[0] === "20",
    "a leitura não preservou início, fim e retorno ao topo durante a rematerialização",
  );
  assert(
    metrics.readTitle === "Executou leitura de arquivo: diffHighlighter.test.ts",
    `a leitura perdeu sua semântica de execução (${JSON.stringify(metrics.readTitle)})`,
  );
  assert(
    JSON.stringify(metrics.readIconPaths) === JSON.stringify([OFFICIAL_READ_ICON_PATH]),
    "a leitura não usa fielmente o ícone oficial de livro aberto",
  );
  assert(
    Math.abs(metrics.readIconSize?.width - 16) <= tolerance &&
      Math.abs(metrics.readIconSize?.height - 16) <= tolerance,
    "o livro aberto não preserva a apresentação oficial de 16x16",
  );
  assert(
    metrics.readIconViewBox === "0 0 20 20" &&
      metrics.readIconFill === "currentColor" &&
      metrics.readIconStroke === "none" &&
      metrics.readIconStrokeWidth === null &&
      metrics.readIconRtlFlip === true,
    "o livro aberto não preserva a apresentação preenchida oficial",
  );
  assert(
    Math.abs(metrics.readChevronSize?.width - 14) <= tolerance &&
      Math.abs(metrics.readChevronSize?.height - 14) <= tolerance,
    "a seta da leitura não usa a apresentação oficial de 14x14",
  );
  assert(
    metrics.readChevronPath === "m9 18 6-6-6-6" &&
      metrics.readChevronOpacity === 1 &&
      /^matrix\(0, 1, -1, 0, 0, 0\)$/u.test(metrics.readChevronTransform ?? ""),
    "a seta expandida da leitura não permanece apontada para baixo",
  );
  validateIntrinsicActivityInteraction(metrics.readInteraction, "leitura de arquivo", tolerance);
}

function validateComposerPopoverLayeringMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado nas camadas do compositor em ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "os painéis criaram overflow horizontal");
  assert(
    metrics.chatPageDisplay === "block" &&
      metrics.timelinePosition === "absolute" &&
      metrics.dockPosition === "absolute",
    "a timeline não ocupa mais a janela inteira sob o dock medido",
  );
  assert(metrics.composerIsolation === "isolate", "o compositor não possui isolamento de camadas");
  assert(
    Number(metrics.dockLayer) > metrics.composerLayer &&
      metrics.composerLayer > metrics.statusLayer,
    "a hierarquia semântica do dock, compositor e status está invertida",
  );
  assert(
    Math.abs(metrics.timelineBounds.top - metrics.chatPageBounds.top) <= tolerance &&
      Math.abs(metrics.timelineBounds.bottom - metrics.chatPageBounds.bottom) <= tolerance &&
      Math.abs(metrics.timelineViewportBounds.top - metrics.chatPageBounds.top) <= tolerance &&
      Math.abs(metrics.timelineViewportBounds.bottom - metrics.chatPageBounds.bottom) <= tolerance,
    "a viewport rolável não alcança os dois limites verticais da página de chat",
  );
  assert(
    Math.abs(metrics.timelineDockOverlap - metrics.dockBounds.height) <= tolerance &&
      Math.abs(metrics.timelineDockGap + metrics.dockBounds.height) <= tolerance,
    "o dock não está sobreposto à viewport de tela inteira",
  );
  assert(
    Math.abs(metrics.scrollbarBounds.top - metrics.chatPageBounds.top) <= tolerance &&
      Math.abs(metrics.scrollbarBounds.bottom - metrics.chatPageBounds.bottom) <= tolerance &&
      Math.abs(metrics.scrollbarBottomGap) <= tolerance,
    "a seta inferior do scrollbar não alcança o rodapé da janela",
  );
  assert(
    Math.abs(metrics.chatDockHeight - Math.ceil(metrics.dockBounds.height)) <= tolerance &&
      metrics.timelineBottomPadding + tolerance >= metrics.chatDockHeight + 32 &&
      metrics.timelineAtEnd <= tolerance &&
      metrics.lastTimelineItemDockGap >= 31,
    "o dock de tela inteira voltou a ocultar o último item da conversa",
  );
  assert(
    Number(metrics.popoverLayer) === metrics.permissionMenuLayer &&
      metrics.permissionMenuLayer > metrics.composerLayer,
    "os painéis locais não possuem prioridade sobre o conteúdo do compositor",
  );
  assert(metrics.permissionMenuOpen === true, "o painel de permissões não permaneceu aberto");
  assert(metrics.menus.length === 3, "nem todos os painéis do compositor foram auditados");
  for (const menu of metrics.menus) {
    assert(
      menu.menuBounds.left >= -tolerance &&
        menu.menuBounds.right <= viewport.width + tolerance &&
        menu.menuBounds.top >= -tolerance &&
        menu.menuBounds.bottom <= viewport.height + tolerance,
      `o painel ${menu.name} ultrapassou a viewport`,
    );
    if (menu.overlapWidth > tolerance && menu.overlapHeight > tolerance) {
      assert(
        menu.paintedInFront.length === 6 && menu.paintedInFront.every(Boolean),
        `o painel ${menu.name} foi pintado atrás do resumo de alterações`,
      );
    }
  }
  for (const requiredOverlap of ["add", "permission"]) {
    const menu = metrics.menus.find((candidate) => candidate.name === requiredOverlap);
    assert(
      menu?.overlapWidth > tolerance && menu.overlapHeight > tolerance,
      `o cenário não exercitou a sobreposição do painel ${requiredOverlap}`,
    );
  }
  assert(
    metrics.permissionMenuBounds.left >= -tolerance &&
      metrics.permissionMenuBounds.right <= viewport.width + tolerance &&
      metrics.permissionMenuBounds.top >= -tolerance &&
      metrics.permissionMenuBounds.bottom <= viewport.height + tolerance,
    "o painel final de permissões ultrapassou a viewport",
  );
  assert(
    Math.abs(metrics.commandIconSize?.width - 16) <= tolerance &&
      Math.abs(metrics.commandIconSize?.height - 16) <= tolerance &&
      metrics.commandIconViewBox === "0 0 24 24",
    "o ícone de comando perdeu sua apresentação compacta de 16x16",
  );
  assert(
    JSON.stringify(metrics.commandFrame) ===
      JSON.stringify({ height: "16", rx: "2.25", width: "20", x: "2", y: "4" }) &&
      JSON.stringify(metrics.commandIconPaths) ===
        JSON.stringify(["m7 9 3 3-3 3", "M13 15h4"]),
    "o ícone de comando não preserva a moldura horizontal e o espaçamento interno",
  );
}

function validateProjectOpenWorkspaceMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado ao abrir projeto em ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "abrir projeto criou overflow horizontal");
  assert(
    /[\\/]codex-app$/u.test(metrics.openedWorkspace ?? ""),
    "a ação não encaminhou o caminho persistido do projeto",
  );
  assert(metrics.dialogOpen === false, "a ação abriu um seletor ou diálogo indevido");
  assert(metrics.projectEditorOpen === false, "a ação abriu o editor do projeto");
}

function validateProjectColorEditorMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(metrics.horizontalOverflow <= tolerance, "o editor de projeto criou overflow horizontal");
  assert(metrics.verticalOverflow <= tolerance, "o editor de projeto criou overflow vertical");
  assert(metrics.dialogCount === 1, "o editor de projeto não expõe um único diálogo");
  assert(metrics.container.left >= 0, "o editor de projeto ultrapassa a borda esquerda");
  assert(
    metrics.container.right <= viewport.width + tolerance,
    "o editor de projeto ultrapassa a borda direita",
  );
  assert(metrics.modal.right <= metrics.colorPanel.left, "os painéis do editor se sobrepõem");
  assert(metrics.colorPanel.width >= 200, "o painel de cores ficou estreito");
  assert(metrics.picker.width <= metrics.colorPanel.width, "o seletor ultrapassa o painel de cores");
  assert(metrics.hueBar.height >= 14, "a faixa de matiz ficou baixa demais");
  assert(/^[0-9A-F]{6}$/u.test(metrics.hexValue ?? ""), "o campo HEX saiu de #RRGGBB");
  const expectedPreviewColor = `rgb(${Number.parseInt(metrics.hexValue.slice(0, 2), 16)}, ${Number.parseInt(metrics.hexValue.slice(2, 4), 16)}, ${Number.parseInt(metrics.hexValue.slice(4, 6), 16)})`;
  assert(
    metrics.previewColor === expectedPreviewColor,
    `ícone (${metrics.previewColor}) e campo HEX (${expectedPreviewColor}) divergiram`,
  );
  assert(metrics.badgeText === `#${metrics.hexValue}`, "badge e campo HEX divergiram");
  assert(/^rgb\(255, 0, \d+\)$/u.test(metrics.boxColor ?? ""), "o quadrado HSV não chegou à matiz vermelha final");
  assert(
    metrics.hueCursorRightGap !== null && Math.abs(metrics.hueCursorRightGap) <= tolerance,
    "o cursor de matiz não permaneceu no fim da faixa",
  );
}

function validateSettingsMetrics(metrics, viewport) {
  const tolerance = 1;
  validateChromeMetrics(metrics, viewport);
  assert(metrics.chromeOverlapsSettings === true, "o chrome não está sobreposto às configurações");
  assert(metrics.chromeText === "", "o chrome ainda exibe um título textual");
  assert(
    Math.abs(metrics.navigation.top - metrics.content.top) <= tolerance,
    "a superfície da navegação de configurações não chega ao topo",
  );
  assert(
    Math.abs(metrics.main.top - metrics.content.top) <= tolerance,
    "a superfície principal de configurações não chega ao topo",
  );
  assert(metrics.back.top >= metrics.chrome.bottom, "a ação de voltar invade a área de arraste");
  assert(metrics.heading.top >= metrics.chrome.bottom, "o título das configurações invade o chrome");
  assert(
    Math.abs(metrics.scrollbar.top - metrics.chrome.bottom) <= tolerance,
    "o scrollbar de configurações não começa abaixo do chrome",
  );
  assert(
    Math.abs(metrics.scrollbar.right - viewport.width) <= tolerance &&
      Math.abs(metrics.scrollbar.width - 18) <= tolerance,
    "o scrollbar de configurações não segue a geometria da tela principal",
  );
  assert(metrics.scrollbarThumb.width >= 12, "o thumb das configurações ficou estreito demais");
  assert(metrics.nativeScrollbarWidth === "none", "o scrollbar nativo continua visível");
  assert(metrics.horizontalOverflow <= tolerance, "a página possui overflow horizontal");
  assert(metrics.navigation.width >= 248, "a navegação de configurações ficou estreita");
  assert(metrics.main.width >= 600, "o painel principal de configurações ficou estreito");
  assert(metrics.page.width >= 500, "o conteúdo de configurações ficou excessivamente estreito");
  assert(Number.parseFloat(metrics.heading.fontSize) >= 21, "o título ficou pequeno demais");
  assert(Number.parseFloat(metrics.firstRowLabel.fontSize) >= 11, "os rótulos ficaram pequenos");
  assert(metrics.checkboxCount === 3, "os três controles booleanos não foram renderizados");
  assert(metrics.visibleCards >= 2, "menos de dois cartões de configurações estão visíveis");
  assert(
    !metrics.navigationLabels.includes("Aparência") &&
      !metrics.navigationLabels.includes("Segurança e permissões"),
    "a navegação ainda expõe páginas removidas",
  );
  assert(metrics.navigationLabels.includes("Perfil"), "a página Perfil deixou as configurações");
  assert(
    metrics.navigationItemGaps.length > 0 &&
      metrics.navigationItemGaps.every((gap) => gap !== null && gap >= 3.5),
    `os itens das configurações continuam visualmente colados: ${JSON.stringify(metrics.navigationItemGaps)}`,
  );
  const surfaceAlpha = (value) =>
    Number.parseFloat(value.match(/\/\s*([\d.]+)%/u)?.[1] ?? "0");
  assert(
    surfaceAlpha(metrics.selectedSurface) >= surfaceAlpha(metrics.hoverSurface) * 2,
    `hover e seleção continuam próximos: ${metrics.hoverSurface} / ${metrics.selectedSurface}`,
  );
  assert(
    metrics.selectedNavigationBackground === "rgba(255, 255, 255, 0.12)",
    `a seleção das configurações não usa a superfície forte: ${metrics.selectedNavigationBackground}`,
  );
  assert(
    metrics.selectedNavigationBoxShadow !== null && metrics.selectedNavigationBoxShadow !== "none",
    "a seleção das configurações perdeu o contorno de separação",
  );
}

function validateUsageSettingsMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(metrics.horizontalOverflow <= tolerance, "Uso e faturamento criou overflow horizontal");
  assert(
    metrics.pageHorizontalOverflow !== null && metrics.pageHorizontalOverflow <= tolerance,
    "o conteúdo de Uso e faturamento criou overflow interno horizontal",
  );
  assert(metrics.page.width >= 500, "a página Uso e faturamento ficou estreita demais");
  assert(metrics.plan.right <= viewport.width + tolerance, "o cartão do plano ultrapassa a tela");
  assert(
    metrics.autoTopUp.right <= viewport.width + tolerance,
    "a recarga automática ultrapassa a tela",
  );
  assert(metrics.reset.right <= viewport.width + tolerance, "a redefinição ultrapassa a tela");
  assert(metrics.cardCount >= 5, "faltam seções funcionais em Uso e faturamento");
  assert(metrics.meterCount >= 4, "faltam limites gerais ou do GPT-5.3-Codex-Spark");
  assert(metrics.planText.includes("R$ 525,00/mês"), "o preço mensal localizado não foi exibido");
  assert(
    metrics.autoTopUpText.includes("Até 40% de desconto"),
    "a oferta de recarga automática não foi exibida",
  );
  assert(metrics.switchAriaChecked === "false", "o switch de recarga não reflete o estado inicial");
  assert(
    metrics.resetButtonText === "Usar redefinição",
    "a ação de usar redefinição não foi renderizada",
  );
  assert(metrics.resetText.includes("Redefinição completa"), "o título do reset não foi exibido");
  assert(
    metrics.sectionHeadings.includes("Limites gerais de uso") &&
      metrics.sectionHeadings.includes("Limites de uso do GPT-5.3-Codex-Spark") &&
      metrics.sectionHeadings.includes("Redefinições do limite de uso"),
    "a estrutura oficial de limites e redefinições está incompleta",
  );
}

function validateUsageSettingsInteractionMetrics(metrics) {
  const tolerance = 1;
  assert(
    metrics.horizontalOverflow <= tolerance,
    "a interação de Uso e faturamento criou overflow horizontal",
  );
  assert(metrics.resetRows === 0, "a redefinição consumida continuou disponível");
  assert(
    metrics.successText === "Limites de uso redefinidos.",
    "o sucesso da redefinição não foi anunciado",
  );
  assert(metrics.switchAriaChecked === "true", "a recarga automática não foi habilitada");
  assert(
    metrics.autoTopUpText.includes("Recarrega para 250 créditos"),
    "a configuração ativa da recarga automática não foi refletida",
  );
}

function validateOutputDetailMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(metrics.horizontalOverflow <= tolerance, "o menu criou overflow horizontal global");
  assert(metrics.cardAllowsOverflow === true, "o cartão ainda recorta o menu de detalhamento");
  assert(metrics.optionCount === 4, "as quatro opções de detalhamento não foram renderizadas");
  assert(
    metrics.visibleOptionCount === metrics.optionCount,
    "uma ou mais opções de detalhamento continuam visualmente recortadas",
  );
  assert(metrics.menu.left >= -tolerance, "o menu ultrapassa a borda esquerda");
  assert(metrics.menu.right <= viewport.width + tolerance, "o menu ultrapassa a borda direita");
  assert(metrics.menu.top >= 34 - tolerance, "o menu invade o titlebar");
  assert(metrics.menu.bottom <= viewport.height + tolerance, "o menu ultrapassa o viewport");
}

function validateSettingsInteractionMetrics(metrics) {
  const tolerance = 1;
  assert(metrics.disabledControls === 0, "o salvamento desabilitou controles independentes");
  assert(metrics.modelSectionShift !== null, "não foi possível medir a estabilidade da página");
  assert(metrics.modelSectionShift <= tolerance, "o salvamento deslocou o conteúdo da página");
  assert(metrics.savingAnnounced === true, "o salvamento não foi anunciado de forma acessível");
  assert(metrics.thirdPreferenceChecked === false, "a preferência não foi atualizada de imediato");
  assert(metrics.visibleStatus === false, "o salvamento exibiu um status que desloca a página");
}

function validateProfileMetrics(metrics, viewport) {
  const tolerance = 1;
  validateChromeMetrics(metrics, viewport);
  assert(metrics.chromeOverlapsSettings === true, "o chrome não sobrepõe as configurações");
  assert(metrics.horizontalOverflow <= tolerance, "o perfil criou overflow horizontal global");
  assert(
    metrics.settingsHorizontalOverflow <= tolerance,
    "o painel de configurações possui overflow horizontal",
  );
  assert(
    metrics.surfaceHorizontalOverflow <= tolerance,
    "a superfície do perfil possui overflow horizontal",
  );
  assert(
    Math.abs(metrics.navigation.top - metrics.content.top) <= tolerance,
    "a navegação de configurações não chega ao topo",
  );
  assert(
    Math.abs(metrics.main.top - metrics.content.top) <= tolerance,
    "o painel de configurações não chega ao topo",
  );
  assert(
    metrics.heading.top >= metrics.chrome.bottom,
    "o título do perfil invade a área do chrome",
  );
  assert(
    metrics.surface.top > metrics.heading.bottom,
    "o conteúdo do perfil sobrepõe o cabeçalho de configurações",
  );
  assert(metrics.page.width <= 821, "a página do perfil ultrapassou 820 px");
  assert(
    metrics.profileContent.width <= metrics.page.width,
    "o conteúdo do perfil ultrapassa a página de configurações",
  );
  assert(metrics.centeredInsetDifference <= 3, "o conteúdo do perfil não está centralizado");
  assert(Math.abs(metrics.avatar.width - 80) <= tolerance, "o avatar do perfil não mede 80 px");
  assert(Math.abs(metrics.avatar.height - 80) <= tolerance, "o avatar do perfil não mede 80 px");
  assert(metrics.profileAvatarImages === 1, "a foto do avatar não aparece na página de perfil");
  assert(metrics.summary.height >= 60, "o resumo do perfil ficou baixo demais");
  assert(metrics.summaryStats === 5, "o resumo não contém as cinco métricas oficiais");
  assert(metrics.activityCells === 364, "o calendário não contém 52 semanas completas");
  assert(metrics.activeCells >= 60, "a atividade de preview ficou visualmente vazia");
  assert(
    metrics.futureCells === metrics.expectedFutureCells,
    "os dias futuros da última semana não foram isolados",
  );
  assert(metrics.monthLabels >= 10, "os rótulos mensais do calendário estão incompletos");
  assert(metrics.activityTabs === 3, "as três agregações de atividade estão ausentes");
  assert(metrics.selectedActivityTabs === 1, "a agregação ativa não é única");
  assert(metrics.insightRows === 5, "os cinco insights oficiais não foram renderizados");
  assert(metrics.invocationRows === 1, "o plugin mais usado do preview está ausente");
  assert(
    metrics.selectedProfileNavigation === 1,
    "Configurações não marca Perfil como a página ativa",
  );
  assert(metrics.planBadge === "Pro", "o badge de plano do perfil está incorreto");
  assert(metrics.loadingStates === 0, "o perfil permaneceu em loading ou erro");
  assert(metrics.activity.top > metrics.summary.bottom, "o gráfico sobrepõe o resumo");
  assert(metrics.insights.top > metrics.activityGrid.bottom, "os insights sobrepõem o calendário");
}

function validateAutomationsMetrics(metrics, viewport) {
  const tolerance = 1;
  validateChromeMetrics(metrics, viewport);
  assert(metrics.horizontalOverflow <= tolerance, "Automações possui overflow horizontal global");
  assert(
    metrics.surfaceHorizontalOverflow <= tolerance,
    "a superfície de Automações possui overflow horizontal",
  );
  assert(
    Math.abs(metrics.surface.top - metrics.chrome.bottom) <= tolerance,
    "Automações não começa imediatamente abaixo do chrome",
  );
  assert(
    Math.abs(metrics.sidebar.top - metrics.content.top) <= tolerance &&
      Math.abs(metrics.sidebar.bottom - metrics.content.bottom) <= tolerance,
    "a superfície lateral não ocupa toda a altura da aplicação",
  );
  assert(
    metrics.primaryNavigation.top >= metrics.chrome.bottom,
    "a navegação lateral invade a área de arraste",
  );
  assert(
    metrics.sidebarBrand.top >= metrics.chrome.bottom &&
      metrics.sidebarBrand.top - metrics.chrome.bottom <= 6 + tolerance,
    "a marca Codex não está alinhada próxima ao chrome",
  );
  assert(
    Math.abs(metrics.sidebarTitlebar.bottom - metrics.primaryNavigation.top) <= tolerance,
    "o espaçamento superior da navegação lateral ficou inconsistente",
  );
  assert(metrics.surface.width > 500, "a superfície de Automações ficou estreita");
  assert(metrics.header.width <= metrics.surface.width, "o cabeçalho ultrapassa a superfície");
  assert(metrics.notice.width <= metrics.surface.width, "o aviso local ultrapassa a superfície");
  assert(metrics.card.left >= metrics.surface.left, "o cartão ultrapassa a borda esquerda");
  assert(metrics.card.right <= metrics.surface.right + tolerance, "o cartão ultrapassa a borda direita");
  assert(Number.parseFloat(metrics.heading.fontSize) >= 21, "o título de Automações ficou pequeno");
  assert(metrics.activeNavigationItems === 1, "a navegação não marca Automações como ativa");
  assert(metrics.unreadBadges === 1, "o badge de resultados não revisados não foi renderizado");
  assert(metrics.automationCards >= 1, "nenhum cartão de Automação foi renderizado");
  assert(metrics.runRows >= 2, "fila e histórico não renderizaram as execuções");
  assert(metrics.primaryButtons === 1, "o botão principal de nova Automação está ausente");
  assert(metrics.sidebarDividerWidth === "1px", "o divisor da sidebar perdeu a espessura padrão");
  assert(
    metrics.sidebarDividerColor === "rgba(255, 255, 255, 0.04)",
    "o divisor da sidebar está mais aceso do que os demais separadores sutis",
  );
}

function validateAutomationEditorMetrics(metrics, viewport) {
  const tolerance = 1;
  validateChromeMetrics(metrics, viewport);
  assert(metrics.horizontalOverflow <= tolerance, "o editor possui overflow horizontal global");
  assert(
    metrics.editorHorizontalOverflow <= tolerance,
    "o conteúdo do editor possui overflow horizontal",
  );
  assert(
    Math.abs(metrics.backdrop.top - metrics.chrome.bottom) <= tolerance,
    "o backdrop do editor não acompanha o início da superfície de conteúdo",
  );
  assert(metrics.editor.top >= metrics.chrome.bottom, "o editor ficou acima do conteúdo");
  assert(metrics.editor.bottom <= viewport.height + tolerance, "o editor ultrapassa o viewport");
  assert(metrics.editor.width >= 500, "o editor ficou excessivamente estreito");
  assert(Number.parseFloat(metrics.heading.fontSize) >= 17, "o título do editor ficou pequeno");
  assert(metrics.prompt.height >= 150, "o campo de instruções ficou baixo demais");
  assert(metrics.dialogCount === 1, "o editor não expõe um único diálogo modal");
  assert(metrics.namedFields >= 6, "os campos essenciais do editor não foram renderizados");
  assert(metrics.footerButtons === 2, "as ações de cancelar e salvar não foram renderizadas");
  assert(metrics.switchAriaChecked === "true", "o switch inicial não expõe aria-checked");
}

function validateBrowserPanelMetrics(metrics, viewport) {
  const tolerance = 1;
  validateWorkspaceSplitMetrics(
    metrics.workspaceSplit,
    "navegador",
    metrics.workspaceSplitInteraction,
  );
  assert(metrics.horizontalOverflow <= tolerance, "o navegador criou overflow horizontal global");
  assert(metrics.workspace.top >= 34 - tolerance, "a área de trabalho invadiu o chrome da janela");
  assert(
    metrics.workspace.right <= viewport.width + tolerance &&
      metrics.workspace.bottom <= viewport.height + tolerance,
    "a área de trabalho ultrapassou o viewport",
  );
  assert(metrics.panel.right <= viewport.width + tolerance, "o navegador ultrapassou a borda direita");
  assert(metrics.panel.bottom <= viewport.height + tolerance, "o navegador ultrapassou a altura útil");
  assert(metrics.panel.width >= 420, "o navegador ficou estreito demais");
  assert(
    Math.abs(metrics.surface.right - metrics.panel.right) <= tolerance &&
      metrics.surface.left >= metrics.panel.left &&
      metrics.surface.left - metrics.panel.left <= tolerance,
    `a superfície nativa (${metrics.surface.left}–${metrics.surface.right}) não acompanha o painel (${metrics.panel.left}–${metrics.panel.right})`,
  );
  assert(metrics.surface.height >= 180, "a superfície nativa ficou baixa demais");
  assert(metrics.tabs.bottom <= metrics.toolbar.top + tolerance, "as abas sobrepõem a barra de endereço");
  assert(metrics.toolbar.bottom <= metrics.surface.top + tolerance, "a barra sobrepõe o conteúdo web");
  assert(metrics.address.width >= 180, "a barra de endereço ficou estreita demais");
  assert(metrics.tabCount >= 1, "o navegador não criou a aba inicial");
  assert(metrics.selectedTabs === 1, "o navegador não possui uma única aba ativa");
  assert(metrics.navigationButtons === 6, "faltam controles de navegação/viewport na barra");
  assert(metrics.addressInputs === 1, "a barra de endereço não possui um único campo");
  assert(metrics.previewPages === 1, "a prévia não expõe a superfície substituta do webview nativo");
}

function validateWorkspaceSplitMetrics(metrics, label, interaction = null) {
  const tolerance = 1;
  assert(metrics.chatHidden === false, `o chat foi desmontado ao abrir ${label}`);
  assert(
    metrics.role === "separator" && metrics.ariaOrientation === "vertical",
    `o divisor de ${label} não expõe semântica vertical acessível`,
  );
  assert(
    metrics.ariaMinimum <= metrics.ariaNow && metrics.ariaNow <= metrics.ariaMaximum,
    `o valor acessível do divisor de ${label} saiu dos limites`,
  );
  assert(
    metrics.ariaText?.includes("Chat") && metrics.ariaText.includes("área de trabalho"),
    `o divisor de ${label} não descreve as duas proporções`,
  );
  if (metrics.splitterDisplay === "none") {
    assert(metrics.chatDisplay === "none", `o fallback estreito de ${label} deixou o chat espremido`);
    assert(
      Math.abs(metrics.workspace.left - metrics.container.left) <= tolerance &&
        Math.abs(metrics.workspace.right - metrics.container.right) <= tolerance,
      `o fallback estreito de ${label} não usa toda a área disponível`,
    );
    assert(
      interaction === null || interaction.supported === false,
      `o teste tentou arrastar o divisor oculto de ${label}`,
    );
    return;
  }
  assert(metrics.chatDisplay !== "none", `o chat não permaneceu visível ao lado de ${label}`);
  assert(
    Math.abs(metrics.chat.left - metrics.container.left) <= tolerance &&
      Math.abs(metrics.chat.right - metrics.splitter.left) <= tolerance &&
      Math.abs(metrics.workspace.left - metrics.splitter.right) <= tolerance &&
      Math.abs(metrics.workspace.right - metrics.container.right) <= tolerance,
    `chat, divisor e ${label} não preenchem a área lado a lado`,
  );
  assert(
    Math.abs(metrics.splitter.width - 8) <= tolerance,
    `o alvo de arraste de ${label} não preservou 8 px`,
  );
  assert(
    metrics.chat.width >= 420 - tolerance && metrics.workspace.width >= 420 - tolerance,
    `o redimensionamento de ${label} violou a largura mínima dos painéis`,
  );
  if (interaction === null) {
    assert(
      Math.abs(metrics.chat.width - metrics.workspace.width) <= tolerance,
      `${label} não abriu inicialmente em uma divisão 50/50`,
    );
    return;
  }
  assert(interaction.supported === true, `o arraste de ${label} não foi exercitado`);
  assert(
    Math.abs(interaction.initial.chat.width - interaction.initial.workspace.width) <= tolerance,
    `${label} não iniciou em 50/50 antes do arraste`,
  );
  assert(
    interaction.dragged.chat.width >= interaction.initial.chat.width + 40 &&
      interaction.dragged.workspace.width <= interaction.initial.workspace.width - 40,
    `arrastar o divisor de ${label} não redistribuiu espaço entre os painéis`,
  );
  assert(
    Math.abs(metrics.chat.width - interaction.dragged.chat.width) <= tolerance &&
      Math.abs(metrics.workspace.width - interaction.dragged.workspace.width) <= tolerance,
    `a divisão de ${label} não permaneceu na posição escolhida pelo mouse`,
  );
  const persistedRatio = Number(interaction.dragged.persistedRatio);
  assert(
    Number.isFinite(persistedRatio) &&
      interaction.dragged.paneRatio !== null &&
      Math.abs(persistedRatio - interaction.dragged.paneRatio) <= 0.01,
    `a proporção escolhida para ${label} não foi persistida`,
  );
}

function validateBrowserResponsiveMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport externo inesperado no modo responsivo em ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "o modo responsivo criou overflow global");
  assert(metrics.toolbarOverflow <= tolerance, "os controles responsivos não cabem na barra");
  assert(metrics.width === "7680", "a largura 8K não foi aplicada");
  assert(metrics.height === "4320", "a altura 8K não foi aplicada");
  assert(metrics.scale === "0.25", "a escala de 25% não foi aplicada");
  assert(metrics.preview === "7680 × 4320 · 25%", "a superfície não refletiu o viewport 8K");
  assert(metrics.selectedTabs === 1, "o modo responsivo perdeu a aba ativa");
  assert(
    metrics.toolbar.left >= metrics.workspace.left - tolerance &&
      metrics.toolbar.right <= metrics.workspace.right + tolerance,
    "a barra responsiva saiu da área de trabalho",
  );
  assert(metrics.toolbar.bottom <= metrics.surface.top + tolerance, "a barra responsiva sobrepõe o conteúdo");
  assert(metrics.surface.height > 0, "o modo responsivo eliminou a superfície do navegador");
  assert(
    metrics.resetLabel === "Redefinir viewport responsivo",
    "o reset responsivo não possui nome acessível",
  );
}

function validateBrowserDebugMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(metrics.horizontalOverflow <= tolerance, "o diagnóstico criou overflow horizontal global");
  assert(
    metrics.debugHorizontalOverflow <= tolerance,
    "o conteúdo do diagnóstico criou overflow horizontal",
  );
  assert(metrics.panel.right <= viewport.width + tolerance, "o painel de diagnóstico saiu do viewport");
  assert(
    metrics.debug.left >= metrics.panel.left - tolerance &&
      metrics.debug.right <= metrics.panel.right + tolerance,
    "o diagnóstico não acompanha a largura do navegador",
  );
  assert(metrics.debug.bottom <= metrics.surface.top + tolerance, "o diagnóstico sobrepõe a webview");
  assert(metrics.surface.height >= 180, "abrir o diagnóstico reduziu demais a superfície nativa");
  assert(metrics.summaryCards === 4, "o resumo de diagnóstico não possui quatro métricas");
  assert(metrics.historyRows >= 3, "o histórico de diagnóstico não renderizou as amostras");
  assert(metrics.failedRows >= 1, "o diagnóstico não diferencia falhas");
  assert(metrics.stageBadges === 5, "os estágios de latência não foram renderizados");
  assert(metrics.findingBadges >= 6, "os achados de qualidade não foram renderizados");
}

function validateBrowserPanelLifecycleMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado no ciclo do navegador em ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.panelCount === 0, "o painel do navegador permaneceu montado após fechar");
  assert(metrics.failureCount === 0, "fechar o navegador produziu uma falha de renderização");
  assert(metrics.chatVisible === true, "o chat não voltou após fechar o navegador");
  assert(metrics.horizontalOverflow <= tolerance, "fechar o navegador criou overflow horizontal");
}

function validateImageViewGroupMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado no agrupamento de imagens em ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "o agrupamento de imagens criou overflow");
  assert(metrics.label === "Visualizou 2 imagens", "o plural do agrupamento está incorreto");
  assert(metrics.open === true, "o agrupamento de imagens não permaneceu expandido");
  assert(metrics.imageCount === 2, "o agrupamento não renderizou as duas imagens");
  assert(metrics.previewButtons === 2, "as miniaturas não são duas ações clicáveis");
  assert(metrics.uniqueSources === 2, "as miniaturas foram deduplicadas incorretamente");
  assert(metrics.rawDataUrlText === false, "a data URL bruta ainda aparece como texto");
}

function validateTimelinePerformanceStressMetrics(metrics, viewport) {
  const tolerance = 1;
  const exceptionalApplicationCallbacks = metrics.rapidAnimationCallbackOutliers.filter(
    (outlier) => outlier.duration > 10,
  );
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado no estresse da timeline em ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.visitedItems === 180, "o estresse não abriu todas as 180 atividades");
  assert(metrics.expansionIterations < 1200, "a expansão virtualizada não convergiu");
  assert(metrics.expansionMs <= 20_000, "a expansão virtualizada ultrapassou 20 s");
  assert(metrics.rapidFrames >= 60, "o teste rápido coletou poucos frames");
  assert(
    metrics.visibleDeferredBodyFrames === 0 && metrics.maximumVisibleDeferredBodies === 0,
    `o scroll rápido exibiu corpos vazios em ${metrics.visibleDeferredBodyFrames} frames (máximo ${metrics.maximumVisibleDeferredBodies})`,
  );
  assert(
    metrics.missingSummaryFrames === 0,
    "o scroll rápido removeu resumos reais de atividades montadas",
  );
  assert(
    metrics.visibleEmptyActivityListFrames === 0 &&
      metrics.maximumVisibleEmptyActivityLists === 0,
    `a timeline deixou listas visíveis sem conteúdo em ${metrics.visibleEmptyActivityListFrames} frames: ${JSON.stringify(metrics.visibleEmptyActivityListSamples)}`,
  );
  assert(
    metrics.consecutiveSummaryComparisons > 0,
    "o teste rápido não comparou a identidade de nenhum resumo entre frames consecutivos",
  );
  assert(
    metrics.summaryIdentityChanges === 0,
    `o scroll rápido substituiu ${metrics.summaryIdentityChanges} resumos que continuavam visíveis`,
  );
  assert(
    metrics.iconIntegrityComparisons > 0 &&
      metrics.iconIntegrityKinds.includes("read") &&
      metrics.iconIntegrityKinds.includes("search"),
    "o teste não reciclou ícones de leitura e busca pelo mesmo slot virtual",
  );
  assert(
    metrics.iconIntegrityFailures === 0,
    `a reciclagem deformou ${metrics.iconIntegrityFailures} ícones: ${JSON.stringify(metrics.iconIntegritySamples)}`,
  );
  assert(
    metrics.legacyPlaceholderFrames === 0,
    "o scroll rápido recuperou placeholders de carregamento legados",
  );
  assert(
    metrics.rapidAnimationWorkFrames >= metrics.rapidFrames,
    "a instrumentação não cobriu todos os frames do scroll rápido",
  );
  assert(
    metrics.rapidP95ApplicationAnimationWorkMs <= 10,
    `o trabalho do app no P95 foi ${metrics.rapidP95ApplicationAnimationWorkMs.toFixed(2)} ms`,
  );
  assert(
    metrics.rapidP99AnimationWorkMs <= 20,
    `o trabalho total no P99 foi ${metrics.rapidP99AnimationWorkMs.toFixed(2)} ms`,
  );
  assert(
    metrics.rapidP99ApplicationAnimationWorkMs <= 10,
    `o trabalho do app no P99 foi ${metrics.rapidP99ApplicationAnimationWorkMs.toFixed(2)} ms`,
  );
  assert(
    metrics.rapidMaximumApplicationAnimationWorkMs <= 12 &&
      exceptionalApplicationCallbacks.length <= 1,
    `o trabalho excepcional do app excedeu o contrato: máximo ${metrics.rapidMaximumApplicationAnimationWorkMs.toFixed(2)} ms em ${exceptionalApplicationCallbacks.length} callbacks`,
  );
  assert(
    metrics.rapidP95FrameMs <= 25,
    `o P95 do scroll rápido foi ${metrics.rapidP95FrameMs.toFixed(2)} ms`,
  );
  assert(
    metrics.rapidP99FrameMs <= 34,
    `o P99 do scroll rápido foi ${metrics.rapidP99FrameMs.toFixed(2)} ms em ${metrics.rapidFrames} frames (${metrics.rapidFramesOver34Ms} acima de 34 ms, ${metrics.rapidLongTasks} long tasks, máximo ${metrics.rapidMaximumFrameMs.toFixed(2)} ms)`,
  );
  assert(
    metrics.rapidMaximumFrameMs <= 50,
    `o máximo do scroll rápido foi ${metrics.rapidMaximumFrameMs.toFixed(2)} ms`,
  );
  assert(
    metrics.rapidFramesOver34Ms <= 1,
    `o scroll rápido teve ${metrics.rapidFramesOver34Ms} frames acima de 34 ms (P95 ${metrics.rapidP95FrameMs.toFixed(2)} ms, P99 ${metrics.rapidP99FrameMs.toFixed(2)} ms, máximo ${metrics.rapidMaximumFrameMs.toFixed(2)} ms)`,
  );
  assert(metrics.rapidLongTasks === 0, "o scroll rápido produziu long tasks");
  assert(metrics.reopenMs <= 1_200, "a reabertura do chat expandido ultrapassou 1,2 s");
  assert(metrics.visualDriftPx !== null, "o cenário não encontrou uma âncora interna mensurável");
  assert(Math.abs(metrics.visualDriftPx) <= tolerance, "a âncora interna mudou de posição visual");
  assert(metrics.domNodes <= 7_000, "a timeline virtualizada excedeu 7 mil nós DOM");
  assert(
    metrics.mountedActivityItems <= 80,
    `${metrics.mountedActivityItems} atividades permaneceram montadas`,
  );
  assert(metrics.mountedSourceRows <= 800, "linhas demais de ferramentas permaneceram montadas");
  assert(metrics.mountedDiffRows <= 500, "linhas demais de diff permaneceram montadas");
  assert(
    metrics.diffViewportIntegrity.length > 0 &&
      metrics.diffViewportIntegrity.every(
        (entry) =>
          entry.canvasConnected === true &&
          entry.canvasHeight !== null &&
          entry.canvasHeight >= entry.clientHeight &&
          entry.scrollHeight >= entry.clientHeight &&
          entry.declaredRows > 0 &&
          entry.mountedRows > 0 &&
          entry.rowGaps.every((gap) => Math.abs(gap - 20) <= tolerance),
      ),
    `os canvases de diff perderam linhas ou geometria após a reciclagem: ${JSON.stringify(metrics.diffViewportIntegrity)}`,
  );
  assert(
    metrics.settledDeferredBodies === 0,
    "corpos adiados permaneceram após o scroll estabilizar",
  );
  assert(
    metrics.settledLegacyPlaceholders === 0,
    "placeholders legados permaneceram após o scroll estabilizar",
  );
  assert(metrics.horizontalOverflow <= tolerance, "o estresse criou overflow horizontal");
}

function validateActivityReconciliationMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado na reconciliação em ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.state === "completed", "a reconciliação paralela não foi concluída");
  assert(metrics.started === 64, `somente ${metrics.started} comandos foram iniciados`);
  assert(metrics.completed === 64, `somente ${metrics.completed} comandos foram concluídos`);
  assert(metrics.commentaryState === "emitted", "o comentário mais novo não foi emitido");
  assert(metrics.commentaryCount === 1, "o comentário mais novo foi perdido ou duplicado");
  assert(
    metrics.causalOrderPreserved === true,
    "uma atualização de comando antigo reapareceu depois do comentário mais novo",
  );
  assert(metrics.turnFailures === 0, "a conclusão fora de ordem derrubou a renderização do turno");
  assert(metrics.totalActivities === 64, "a projeção perdeu comandos concluídos fora de ordem");
  assert(metrics.identityComparisons > 0, "nenhum slot retido foi comparado durante o streaming");
  assert(
    metrics.identityChanges === 0,
    `${metrics.identityChanges} atividades retidas recriaram o contêiner DOM`,
  );
  assert(
    metrics.mountedActivities === metrics.uniqueMountedActivities,
    "a janela montada contém chaves duplicadas",
  );
  assert(metrics.durationMs < 10_000, "a reconciliação paralela ultrapassou 10 s");
  assert(metrics.horizontalOverflow <= tolerance, "a reconciliação criou overflow horizontal");
}

function validateActivityShimmerMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado no shimmer em ${viewport.width}x${viewport.height}`,
  );
  assert(
    metrics.activeDurationMs >= 700 && metrics.activeDurationMs <= 1600,
    `o pulso visual durou ${metrics.activeDurationMs.toFixed(1)} ms em vez de cerca de 1 s`,
  );
  assert(
    metrics.cadenceMs >= 3200 && metrics.cadenceMs <= 4800,
    `a cadência visual foi ${metrics.cadenceMs.toFixed(1)} ms em vez de cerca de 4 s`,
  );
  assert(metrics.activeAnimation.duration === "1s", "a animação visual não dura exatamente 1 s");
  assert(
    metrics.activeAnimation.iterationCount === "1",
    "o shimmer voltou a executar em loop infinito",
  );
  assert(
    metrics.activeAnimation.name === "activity-reflection-sweep",
    "a camada do shimmer usa uma animação inesperada",
  );
  assert(
    metrics.activeAnimation.timingFunction.includes("steps(48"),
    "o shimmer perdeu a progressão oficial em 48 passos",
  );
  assert(
    metrics.inactiveAnimationName === "none",
    "a animação permaneceu presa no quadro final depois do pulso",
  );
  assert(metrics.activeTargets === 1, "o segundo pulso não ficou restrito à atividade em execução");
  assert(metrics.titleText.length > 0, "o título animado ficou vazio");
  assert(metrics.horizontalOverflow <= tolerance, "o shimmer criou overflow horizontal");
}

function validateTimelineExtremeFilesMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado em 100 mil arquivos: ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.totalActivities === 100_000, "a projeção extrema perdeu arquivos");
  assert(
    metrics.physicalListHeight > 2_000_000 && metrics.physicalListHeight <= 8_000_000,
    `a altura física extrema ficou inválida (${metrics.physicalListHeight}px)`,
  );
  assert(metrics.rapidFrames >= 60, "o teste de 100 mil arquivos coletou poucos frames");
  assert(
    metrics.rapidAnimationWorkFrames >= metrics.rapidFrames,
    "a instrumentação não cobriu os frames de 100 mil arquivos",
  );
  assert(
    metrics.rapidP95ApplicationAnimationWorkMs <= 8,
    `o trabalho do app em 100 mil arquivos foi ${metrics.rapidP95ApplicationAnimationWorkMs.toFixed(2)} ms no P95`,
  );
  assert(
    metrics.rapidP99AnimationWorkMs <= 10,
    `o trabalho total em 100 mil arquivos foi ${metrics.rapidP99AnimationWorkMs.toFixed(2)} ms no P99`,
  );
  assert(
    metrics.rapidP99ApplicationAnimationWorkMs <= 8,
    `o trabalho do app em 100 mil arquivos foi ${metrics.rapidP99ApplicationAnimationWorkMs.toFixed(2)} ms no P99`,
  );
  assert(
    metrics.rapidMaximumApplicationAnimationWorkMs <= 10,
    `o maior trabalho do app em 100 mil arquivos foi ${metrics.rapidMaximumApplicationAnimationWorkMs.toFixed(2)} ms`,
  );
  assert(metrics.rapidP95FrameMs <= 20, "o P95 de 100 mil arquivos ultrapassou 20 ms");
  assert(metrics.rapidP99FrameMs <= 34, "o P99 de 100 mil arquivos ultrapassou 34 ms");
  assert(metrics.rapidMaximumFrameMs <= 50, "o cenário extremo teve frame acima de 50 ms");
  assert(metrics.rapidLongTasks === 0, "o scroll de 100 mil arquivos produziu long tasks");
  assert(
    metrics.visibleDeferredBodyFrames === 0 && metrics.maximumVisibleDeferredBodies === 0,
    `o cenário extremo exibiu corpos vazios em ${metrics.visibleDeferredBodyFrames} frames (máximo ${metrics.maximumVisibleDeferredBodies})`,
  );
  assert(
    metrics.missingSummaryFrames === 0,
    "o cenário extremo removeu resumos reais durante o scroll",
  );
  assert(
    metrics.summaryIdentityChanges === 0,
    `o cenário extremo substituiu ${metrics.summaryIdentityChanges} resumos que continuavam visíveis`,
  );
  assert(
    metrics.wrapperIdentityChanges === 0,
    `o cenário extremo substituiu ${metrics.wrapperIdentityChanges} contêineres que continuavam visíveis`,
  );
  assert(
    metrics.legacyPlaceholderFrames === 0,
    "o cenário extremo recuperou placeholders legados",
  );
  assert(
    metrics.maximumMountedItems <= 128,
    `${metrics.maximumMountedItems} arquivos ficaram montados no cenário extremo`,
  );
  assert(metrics.domNodes <= 3_000, "o cenário extremo excedeu 3 mil nós DOM");
  assert(
    metrics.settledDeferredBodies === 0,
    "o cenário extremo deixou corpos adiados após estabilizar",
  );
  assert(
    metrics.settledLegacyPlaceholders === 0,
    "o cenário extremo deixou placeholders legados após estabilizar",
  );
  assert(metrics.visualDriftPx !== null, "o cenário extremo não materializou sua âncora");
  assert(
    Math.abs(metrics.visualDriftPx) <= tolerance,
    `a âncora de 100 mil arquivos derivou ${metrics.visualDriftPx}px`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "100 mil arquivos criaram overflow horizontal");
}

function validateChromeMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado em ${viewport.width}x${viewport.height}`,
  );
  assert(Math.abs(metrics.chrome.top) <= tolerance, "o titlebar não começa no topo");
  assert(Math.abs(metrics.chrome.height - 34) <= tolerance, "o titlebar não mede 34 px");
  assert(
    Math.abs(metrics.content.top - metrics.chrome.top) <= tolerance,
    "a superfície da aplicação não continua sob o chrome",
  );
  assert(
    Math.abs(metrics.content.bottom - viewport.height) <= tolerance,
    "a superfície da aplicação não ocupa toda a altura do viewport",
  );
  assert(metrics.controls.top >= 0, "os controles da janela ficaram acima do viewport");
  assert(
    metrics.controls.right <= viewport.width + tolerance,
    "os controles da janela ultrapassam a borda direita",
  );
  assert(metrics.controls.width >= 138, "a área dos controles da janela ficou estreita");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Falha na auditoria visual: ${message}.`);
  }
}

function resolveBrowserPath() {
  const candidates = [
    path.join(process.env["ProgramFiles"] ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(
      process.env["ProgramFiles(x86)"] ?? "",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    path.join(
      process.env["LOCALAPPDATA"] ?? "",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    path.join(
      process.env["ProgramFiles"] ?? "",
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
    path.join(
      process.env["ProgramFiles(x86)"] ?? "",
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
    path.join(
      process.env["LOCALAPPDATA"] ?? "",
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
  ];
  const resolved = candidates.find((candidate) => existsSync(candidate));
  if (resolved === undefined) {
    throw new Error("Edge ou Chrome não foi encontrado para a auditoria visual.");
  }
  return resolved;
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Não foi possível reservar a porta de depuração do navegador.");
  }
  await new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

function captureOutput(child) {
  let output = "";
  const append = (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-16_384);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => output;
}

async function waitForHttp(url, child, output, options = {}) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null && options.allowExited !== true) {
      throw new Error(`Processo encerrou antes de responder em ${url}:\n${output()}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The server or browser is still starting.
    }
    await delay(100);
  }
  throw new Error(`Tempo esgotado aguardando ${url}:\n${output()}`);
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ao acessar ${url}`);
  }
  return response.json();
}

async function terminate(child, options = {}) {
  if (child === undefined || child.exitCode !== null) {
    return;
  }
  if (options.processTree === true && process.platform === "win32" && child.pid !== undefined) {
    const taskkill = spawn(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    await new Promise((resolve) => taskkill.once("exit", resolve));
    return;
  }
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    delay(3_000),
  ]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const EVENT_DEADLINE_MILLISECONDS = 30_000;

class CdpClient {
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.events = new Map();
    socket.addEventListener("message", (event) => this.handleMessage(event));
  }

  send(method, params = {}) {
    this.nextId += 1;
    const id = this.nextId;
    const response = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return response;
  }

  waitForEvent(method) {
    return new Promise((resolve, reject) => {
      const listeners = this.events.get(method) ?? [];
      const settle = (value) => {
        clearTimeout(deadline);
        resolve(value);
      };
      listeners.push(settle);
      this.events.set(method, listeners);
      const deadline = setTimeout(() => {
        const pending = this.events.get(method) ?? [];
        const listenerIndex = pending.indexOf(settle);
        if (listenerIndex >= 0) {
          pending.splice(listenerIndex, 1);
        }
        if ((this.events.get(method) ?? []).length === 0) {
          this.events.delete(method);
        }
        reject(
          new Error(
            `O evento CDP "${method}" não aconteceu em ${EVENT_DEADLINE_MILLISECONDS} ms.`,
          ),
        );
      }, EVENT_DEADLINE_MILLISECONDS);
    });
  }

  async evaluate(expression, awaitPromise) {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (response.exceptionDetails !== undefined) {
      const description =
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.exception?.value ??
        response.exceptionDetails.text ??
        "Falha ao avaliar a prévia.";
      throw new Error(String(description));
    }
    return response.result.value;
  }

  close() {
    this.socket.close();
  }

  handleMessage(event) {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (pending === undefined) {
        return;
      }
      this.pending.delete(message.id);
      if (message.error !== undefined) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    const listeners = this.events.get(message.method);
    if (listeners !== undefined) {
      this.events.delete(message.method);
      for (const listener of listeners) {
        listener(message.params);
      }
    }
  }
}

await main();
