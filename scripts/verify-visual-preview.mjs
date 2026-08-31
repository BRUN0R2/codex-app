import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

import {
  chromiumAuditArguments,
  compareRetainedIdentities,
  loopbackHttpOrigin,
  observeProcess,
  waitForDevToolsEndpoint,
} from "../src/tooling/visualAuditRuntime.ts";
import { PROFILE_STORAGE_KEYS } from "../src/state/profileStorage.ts";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREVIEW_PLACEHOLDER_ORIGIN = "http://127.0.0.1";
const HOME_PREVIEW_URL = `${PREVIEW_PLACEHOLDER_ORIGIN}/?preview=1&chrome=1`;
const MODEL_WARMUP_PREVIEW_URL = `${HOME_PREVIEW_URL}&modelRefreshDelay=180`;
const RUNTIME_RESTRICTIONS_PREVIEW_URL = `${HOME_PREVIEW_URL}&runtimeRestrictions=1`;
const REASONING_REFLECTION_PREVIEW_URL = `${HOME_PREVIEW_URL}&reasoningReflection=1`;
const CHAT_REFERENCE_PREVIEW_URL = `${HOME_PREVIEW_URL}&chatReference=1`;
const TIMELINE_STRESS_PREVIEW_URL = `${HOME_PREVIEW_URL}&timelineStress=1`;
const TIMELINE_EXTREME_PREVIEW_URL = `${TIMELINE_STRESS_PREVIEW_URL}&timelineFiles=100000`;
const ACTIVITY_RECONCILIATION_PREVIEW_URL = `${TIMELINE_STRESS_PREVIEW_URL}&activityReconciliation=1`;
const BROWSER_PANEL_PREVIEW_URL = `${TIMELINE_STRESS_PREVIEW_URL}&browser=1`;
const BROWSER_DEBUG_PREVIEW_URL = `${BROWSER_PANEL_PREVIEW_URL}&browserMetrics=1`;
const OFFICIAL_READ_ICON_PATH =
  "M16.3965 5.01128C16.3963 4.93399 16.3489 4.87691 16.293 4.85406L16.2354 4.84332C13.9306 4.91764 12.5622 5.32101 10.665 6.34722V16.3716C11.3851 15.9994 12.0688 15.7115 12.7861 15.5015C13.8286 15.1965 14.9113 15.0633 16.2402 15.0435L16.2979 15.0308C16.353 15.0063 16.3965 14.9483 16.3965 14.8755V5.01128ZM3.54492 14.8765C3.54492 14.9725 3.62159 15.0422 3.70117 15.0435L4.19629 15.0562C5.94062 15.1247 7.26036 15.4201 8.65918 16.0484C8.05544 15.1706 7.14706 14.436 6.17871 14.1109V14.1099C5.56757 13.9045 5.16816 13.3314 5.16797 12.6988V4.98882C4.86679 4.93786 4.60268 4.8999 4.28223 4.87457L3.72754 4.84429C3.62093 4.84079 3.54505 4.92417 3.54492 5.01226V14.8765ZM17.7266 14.8755C17.7266 15.6314 17.1607 16.2751 16.4121 16.3628L16.2598 16.3736C15.0122 16.3922 14.0555 16.5159 13.1602 16.7779C12.2629 17.0404 11.3966 17.4508 10.3369 18.0738C10.129 18.1959 9.87099 18.1958 9.66309 18.0738C7.71455 16.9283 6.31974 16.4689 4.12988 16.3853L3.68164 16.3736C2.85966 16.3614 2.21484 15.6838 2.21484 14.8765V5.01226C2.21497 4.15391 2.93263 3.4871 3.77246 3.51519L4.39844 3.54937C4.67996 3.57191 4.92258 3.60421 5.16797 3.64214V2.51031C5.16797 1.44939 6.29018 0.645615 7.31055 1.15679L7.31152 1.15582C8.78675 1.89511 10.0656 3.33006 10.5352 4.91461C12.3595 3.98907 13.8688 3.58817 16.1924 3.51324L16.3506 3.51714C17.1285 3.5741 17.7264 4.23496 17.7266 5.01128V14.8755ZM6.49805 12.6988C6.49824 12.7723 6.5442 12.8296 6.60254 12.8492L6.96289 12.9859C7.85245 13.3586 8.68125 13.9846 9.33496 14.7496V5.5816C9.08794 4.37762 8.13648 3.1566 6.95801 2.47613L6.71582 2.34527C6.67779 2.32617 6.6337 2.32502 6.58301 2.35796C6.52946 2.39279 6.49805 2.44863 6.49805 2.51031V12.6988Z";
const SETTINGS_PREVIEW_URL = `${PREVIEW_PLACEHOLDER_ORIGIN}/?preview=1&chrome=1&settings=general`;
const USAGE_SETTINGS_PREVIEW_URL = `${PREVIEW_PLACEHOLDER_ORIGIN}/?preview=1&chrome=1&settings=usage`;
const SETTINGS_INTERACTION_PREVIEW_URL = `${SETTINGS_PREVIEW_URL}&preferenceDelay=400`;
const AUTOMATIONS_PREVIEW_URL = `${PREVIEW_PLACEHOLDER_ORIGIN}/?preview=1&chrome=1&surface=automations`;
const PROFILE_PREVIEW_URL = `${PREVIEW_PLACEHOLDER_ORIGIN}/?preview=1&chrome=1&settings=profile`;
const ARTIFACT_DIRECTORY = path.join(PROJECT_ROOT, ".artifacts", "visual-audit");
const VISUAL_AUDIT_LOCALE = "pt-BR";
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
    id: "composer-ultra-effort",
    url: HOME_PREVIEW_URL,
    initialReadyExpression: `document.querySelector(".model-button") instanceof HTMLButtonElement`,
    prepareExpression: `(() => {
      const modelButton = document.querySelector(".model-button");
      if (!(modelButton instanceof HTMLButtonElement)) {
        throw new Error("The model selector is missing.");
      }
      modelButton.click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const effortRow = [...document.querySelectorAll(".model-menu-row")].find(
          (button) => button.textContent?.includes("Esforço"),
        );
        if (!(effortRow instanceof HTMLButtonElement)) {
          throw new Error("The effort section is missing.");
        }
        effortRow.click();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const ultraOption = [...document.querySelectorAll(".model-menu-option")].find(
            (button) => button.textContent?.trim() === "Ultra",
          );
          if (!(ultraOption instanceof HTMLButtonElement)) {
            throw new Error("The Ultra option is missing.");
          }
          ultraOption.click();
        }));
      }));
    })()`,
    readyExpression: `document.querySelector(".model-button-effort.ultra") instanceof HTMLElement`,
    auditExpression: () => `(() => {
      const effort = document.querySelector(".model-button-effort.ultra");
      if (!(effort instanceof HTMLElement)) {
        throw new Error("The active Ultra effort is missing.");
      }
      const rootStyle = getComputedStyle(document.documentElement);
      return {
        color: getComputedStyle(effort).color,
        expectedColor: rootStyle.getPropertyValue("--reasoning-ultra").trim(),
        text: effort.textContent?.trim() ?? null,
        horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      };
    })()`,
    validate: validateComposerUltraEffortMetrics,
  },
  {
    id: "composer-runtime-restrictions",
    url: RUNTIME_RESTRICTIONS_PREVIEW_URL,
    initialReadyExpression: `document.querySelector(".model-button") instanceof HTMLButtonElement &&
      document.querySelector(".model-button-name")?.textContent?.includes("5.6 Luna") === true`,
    prepareExpression: `(() => {
      const modelButton = document.querySelector(".model-button");
      if (!(modelButton instanceof HTMLButtonElement)) {
        throw new Error("The model selector is missing.");
      }
      modelButton.click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const effortRow = [...document.querySelectorAll(".model-menu-row")].find(
          (button) => button.textContent?.includes("Esforço"),
        );
        if (!(effortRow instanceof HTMLButtonElement)) {
          throw new Error("The effort section is missing.");
        }
        effortRow.click();
      }));
    })()`,
    readyExpression: `[...document.querySelectorAll(".model-menu-option")].some(
      (button) => button.textContent?.includes("Ultra") &&
        button.textContent?.includes("Requer execução multiagente"),
    )`,
    auditExpression: () => `(() => {
      const ultraOption = [...document.querySelectorAll(".model-menu-option")].find(
        (button) => button.textContent?.includes("Ultra"),
      );
      return {
        selectedModel: document.querySelector(".model-button-name")?.textContent?.trim() ?? null,
        persistentCompatibilityNoticeCount: [...document.querySelectorAll(".composer-input-error")]
          .filter((element) => element.textContent?.includes("Requer")).length,
        ultraDisabled: ultraOption instanceof HTMLButtonElement ? ultraOption.disabled : null,
        ultraLabel: ultraOption?.querySelector("strong")?.textContent?.trim() ?? null,
        ultraRequirement: ultraOption?.querySelector("small")?.textContent?.trim() ?? null,
        horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      };
    })()`,
    validate: validateComposerRuntimeRestrictionsMetrics,
  },
  {
    id: "model-catalog-warmup",
    url: MODEL_WARMUP_PREVIEW_URL,
    initialReadyExpression: `document.querySelector(".new-thread-button") instanceof HTMLButtonElement &&
      document.querySelector(".composer textarea") instanceof HTMLTextAreaElement`,
    prepareExpression: modelCatalogWarmupPrepareExpression(),
    readyExpression: `window.__previewModelWarmupReady === true`,
    auditExpression: modelCatalogWarmupVisualAuditExpression,
    validate: validateModelCatalogWarmupMetrics,
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
      ".agent-activity-group > .agent-activity-summary .activity-title.is-running.is-shimmer-active .activity-title-sweep",
    ) !== null`,
    auditExpression: activeActivityReflectionVisualAuditExpression,
    validate: validateActiveActivityReflectionMetrics,
  },
  {
    id: "reasoning-activity-reflection",
    url: REASONING_REFLECTION_PREVIEW_URL,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Inspecionar janela de contexto"),
    )`,
    prepareExpression: `(() => {
      const threadButton = [...document.querySelectorAll(".thread-main")].find(
        (button) => button.textContent?.includes("Inspecionar janela de contexto"),
      );
      threadButton?.click();
    })()`,
    readyExpression: `document.documentElement.dataset.reasoningPreviewReady === "true" &&
      [...document.querySelectorAll(
      ".agent-activity-group > .agent-activity-summary .activity-title.is-running.is-shimmer-active",
    )].some(
      (title) => title.querySelector(".activity-title-base")?.textContent?.trim() ===
        "Running focused checks",
    )`,
    auditExpression: activeActivityReflectionVisualAuditExpression,
    validate: validateReasoningActivityReflectionMetrics,
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
    id: "nested-scroll-containment",
    url: HOME_PREVIEW_URL,
    initialReadyExpression: `[...document.querySelectorAll(".thread-main")].some(
      (button) => button.textContent?.includes("Inspecionar janela de contexto"),
    )`,
    prepareExpression: nestedScrollContainmentPrepareExpression(),
    readyExpression: `window.__previewNestedScrollReady === true`,
    auditExpression: nestedScrollContainmentVisualAuditExpression,
    validate: validateNestedScrollContainmentMetrics,
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
              throw new Error("Timed out while preparing " + label + ".");
            }
            await frame();
          }
        };
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Estresse de timeline expandida"),
        );
        threadButton?.click();
        await waitUntil(
          "the review trigger",
          () => document.querySelector(".plan-review-trigger") instanceof HTMLButtonElement,
        );
        document.querySelector(".plan-review-trigger")?.click();
        await waitUntil(
          "the review file list",
          () => document.querySelector(".review-file-option") instanceof HTMLButtonElement,
        );
        const largeFile = [...document.querySelectorAll(".review-file-option")].find(
          (option) => option.querySelector("code")?.textContent?.endsWith("module-15.ts"),
        );
        if (!(largeFile instanceof HTMLButtonElement)) {
          throw new Error("The large review file is missing.");
        }
        largeFile.click();
        await waitUntil(
          "the virtual review rows",
          () => document.querySelector(".review-panel .diff-virtual-row") instanceof HTMLElement,
        );
        await frame();
        await frame();
        const measureReviewVirtualization = () => {
          const diffViewport = document.querySelector(".review-panel .diff-viewport");
          const canvas = diffViewport?.querySelector(".diff-virtual-canvas");
          if (!(diffViewport instanceof HTMLElement) || !(canvas instanceof HTMLElement)) {
            throw new Error("The virtual review geometry is missing.");
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
          throw new Error("The review viewport is missing.");
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
    initialReadyExpression: `document.querySelector(".settings-dialog") !== null &&
      document.querySelector(".window-chrome-controls") !== null &&
      document.querySelector(".settings-scrollbar:not(.is-hidden)") !== null &&
      document.querySelectorAll(".application-preference").length === 3`,
    prepareExpression: `(() => {
      const languageSelect = document.querySelector(".language-preference-select");
      if (!(languageSelect instanceof HTMLSelectElement)) {
        throw new Error("The language preference selector is missing.");
      }
      languageSelect.value = "auto";
    })()`,
    readyExpression: `document.querySelector(".language-preference-select")?.value === "auto"`,
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
    prepareExpression: `(() => {
      const trigger = document.querySelector(".output-detail-trigger");
      if (!(trigger instanceof HTMLButtonElement)) {
        throw new Error("The output detail trigger is missing.");
      }
      trigger.scrollIntoView({ block: "center", inline: "nearest" });
      requestAnimationFrame(() => requestAnimationFrame(() => trigger.click()));
    })()`,
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
          throw new Error("The responsive controls were not mounted.");
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
            throw new Error("The browser did not open for its disposal check.");
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
  let browserProfile;
  let server;
  let browser;
  let browserController;

  try {
    // Browser fixtures are guarded by import.meta.env.DEV; the production build is validated
    // separately, while this server keeps those deterministic fixtures available to the audit.
    server = await createServer({
      clearScreen: false,
      mode: "production",
      root: PROJECT_ROOT,
      server: {
        host: "127.0.0.1",
        port: 0,
        strictPort: true,
      },
    });
    await server.listen();
    const previewOrigin = loopbackHttpOrigin(server.httpServer?.address() ?? null);
    browserProfile = await mkdtemp(path.join(os.tmpdir(), "codex-app-visual-"));
    browser = spawn(
      browserPath,
      chromiumAuditArguments(browserProfile),
      {
        cwd: PROJECT_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const browserProcess = observeProcess(browser, "Visual audit browser");
    const devToolsEndpoint = await waitForDevToolsEndpoint(browserProfile, browserProcess);
    browserController = await CdpClient.connect(devToolsEndpoint.browserWebSocketUrl);
    await mkdir(ARTIFACT_DIRECTORY, { recursive: true });

    const reports = [];
    const selectedScenarios =
      REQUESTED_SCENARIOS.size === 0
        ? SCENARIOS
        : SCENARIOS.filter((scenario) => REQUESTED_SCENARIOS.has(scenario.id));
    if (selectedScenarios.length !== (REQUESTED_SCENARIOS.size || SCENARIOS.length)) {
      const knownScenarios = new Set(SCENARIOS.map((scenario) => scenario.id));
      const unknownScenarios = [...REQUESTED_SCENARIOS].filter(
        (scenarioId) => !knownScenarios.has(scenarioId),
      );
      throw new Error(`Unknown visual scenarios: ${unknownScenarios.join(", ")}`);
    }
    const scenarios = selectedScenarios.map((scenario) => ({
      ...scenario,
      url: rebasePreviewUrl(scenario.url, previewOrigin),
    }));
    for (const scenario of scenarios) {
      for (const viewport of scenario.viewports ?? VIEWPORTS) {
        reports.push(await auditViewport(devToolsEndpoint.port, viewport, scenario));
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
    await server?.close().catch(() => undefined);
    if (browserProfile !== undefined) {
      await rm(browserProfile, {
        force: true,
        maxRetries: 10,
        recursive: true,
        retryDelay: 200,
      }).catch(() => undefined);
    }
  }
}

function rebasePreviewUrl(url, previewOrigin) {
  const parsed = new URL(url);
  return `${previewOrigin}${parsed.pathname}${parsed.search}${parsed.hash}`;
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
    await client.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `localStorage.setItem(${JSON.stringify(PROFILE_STORAGE_KEYS.locale)}, ${JSON.stringify(VISUAL_AUDIT_LOCALE)});`,
    });
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
        `Scenario ${scenario.id} is invalid at ${viewport.width}x${viewport.height}: ${reason}. Metrics: ${JSON.stringify(metrics)}`,
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
    `Visual preview ${scenarioId} did not become ready within ${timeoutMs / 1000} seconds.\n` +
      `Diagnostics: ${JSON.stringify(diagnostics)}`,
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
      throw new Error("The built-in browser surface is incomplete.");
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
      throw new Error("The split between chat and workspace is incomplete.");
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
      throw new Error("The responsive viewport is incomplete.");
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
      throw new Error("The browser diagnostics are incomplete.");
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
          throw new Error("The image group was not mounted.");
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
        throw new Error("The two thumbnails did not become ready.");
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
          throw new Error("The timeline was not mounted.");
        }
        const marker = document.querySelectorAll(".user-message-navigator button")[1];
        if (!(marker instanceof HTMLButtonElement)) {
          throw new Error("The message marker before the created file is missing.");
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
              throw new Error("The created diff did not materialize its visible rows.");
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
          "File " +
            ${JSON.stringify(fileName)} +
            " was not found in the timeline (scrollTop=" +
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
              throw new Error("The virtual read is not materialized.");
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
          await frame();
          const sourceChevronIcon = sourceSummary?.querySelector(".activity-chevron > svg");
          if (sourceChevronIcon instanceof SVGElement) {
            await Promise.all(
              sourceChevronIcon
                .getAnimations()
                .map((animation) => animation.finished.catch(() => undefined)),
            );
          }
          await frame();
          await frame();
          const reopened = measureSourceVirtualization();
          const sourceViewport = sourceCard.querySelector(".tool-source-viewport");
          if (!(sourceViewport instanceof HTMLElement)) {
            throw new Error("The reopened read viewport is missing.");
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
              throw new Error("Timed out waiting for " + label + ".");
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
          "the composer and change summary",
          () =>
            document.querySelector(".composer-wrap") !== null &&
            document.querySelector(".plan-progress-pill") !== null &&
            document.querySelector(".permission-button") !== null,
        );
        await waitUntil(
          "the stress timeline",
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
          "a materialized command row",
          () =>
            document.querySelector(
              ".command-activity-card > summary .activity-icon svg",
            ) !== null,
        );

        const measureMenu = async (name, triggerSelector, menuSelector) => {
          const trigger = document.querySelector(triggerSelector);
          if (!(trigger instanceof HTMLButtonElement)) {
            throw new Error("Missing control for the " + name + " menu.");
          }
          trigger.click();
          await frame();
          await frame();
          const menu = document.querySelector(menuSelector);
          const status = document.querySelector(".plan-progress-pill");
          if (!(menu instanceof HTMLElement) || !(status instanceof HTMLElement)) {
            throw new Error("Missing surfaces while measuring the " + name + " menu.");
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
          throw new Error("The permission control disappeared during the audit.");
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
          throw new Error("The final dock layer hierarchy is incomplete.");
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
          throw new Error("The last timeline item is not materialized at the lower boundary.");
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
      throw new Error("The image group is missing.");
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
              throw new Error("Timed out while preparing " + label + ".");
            }
            await frame();
          }
        };
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Inspecionar janela de contexto"),
        );
        if (!(threadButton instanceof HTMLButtonElement)) {
          throw new Error("The manual-scroll reference chat is missing.");
        }
        threadButton.click();
        await waitUntil(
          "the reference chat",
          () => document.getElementById("user-message-preview-image-user-message") !== null,
        );
        const timeline = document.querySelector(".timeline");
        if (!(timeline instanceof HTMLElement)) {
          throw new Error("The manual-scroll scenario timeline is missing.");
        }
        await waitUntil(
          "two virtualized turns",
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
          throw new Error("The manual-scroll reference items are missing.");
        }
        const firstId = initialFirst.getAttribute("data-virtual-turn-id");
        const anchorId = initialAnchor.getAttribute("data-virtual-turn-id");
        if (firstId === null || anchorId === null) {
          throw new Error("The reference items lost their virtual identities.");
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
          throw new Error("The reference items were unmounted during preparation.");
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
          throw new Error("The reference items were unmounted before measurement.");
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

function nestedScrollContainmentPrepareExpression() {
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
              throw new Error("The nested regions did not materialize their content.");
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
              const overscrollBehaviorY = originalGetComputedStyle(region).overscrollBehaviorY;
              const wheel = new WheelEvent("wheel", {
                bubbles: true,
                cancelable: true,
                deltaMode: 0,
                deltaY,
              });
              const timelineStart = timeline.scrollTop;
              region.dispatchEvent(wheel);
              await frame();
              return {
                defaultPrevented: wheel.defaultPrevented,
                nestedStart,
                nestedScrollTop: region.scrollTop,
                overscrollBehaviorY,
                timelineDelta: timeline.scrollTop - timelineStart,
              };
            };
            try {
              const containmentStartedAt = performance.now();
              const commandMetrics = await run(commandScroll, 40, -100);
              const diffMetrics = await run(diffScroll, 0, -120);
              const sourceMetrics = await run(sourceScroll, 0, -80);
              window.__previewNestedScrollMetrics = {
                command: commandMetrics,
                containmentDurationMs: performance.now() - containmentStartedAt,
                diff: diffMetrics,
                source: sourceMetrics,
                styleReadCount,
              };
            } finally {
              window.getComputedStyle = originalGetComputedStyle;
            }
            return;
          }
        }
        throw new Error("The nested-scroll target activities were not mounted.");
      } catch (error) {
        window.__previewNestedScrollError =
          error instanceof Error ? error.stack ?? error.message : String(error);
      } finally {
        window.__previewNestedScrollReady = true;
      }
    })();
  })()`;
}

function modelCatalogWarmupPrepareExpression() {
  return `(() => {
    void (async () => {
      try {
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const waitUntil = async (label, predicate) => {
          const deadline = performance.now() + 3000;
          while (!predicate()) {
            if (performance.now() > deadline) {
              throw new Error("Timed out waiting for " + label + ".");
            }
            await frame();
          }
        };
        await waitUntil(
          "the initial catalog",
          () =>
            (window.__previewModelListCallCount ?? 0) >= 1 &&
            (window.__previewModelListActiveCount ?? 0) === 0,
        );
        const baselineCalls = window.__previewModelListCallCount ?? 0;
        const actionStartedAt = performance.now();
        const newThread = document.querySelector(".new-thread-button");
        const textarea = document.querySelector(".composer textarea");
        if (!(newThread instanceof HTMLButtonElement) || !(textarea instanceof HTMLTextAreaElement)) {
          throw new Error("The new-task controls are missing.");
        }
        newThread.click();
        textarea.value = "Preparar catálogo antes do envio";
        textarea.dispatchEvent(
          new InputEvent("input", { bubbles: true, data: textarea.value, inputType: "insertText" }),
        );
        await waitUntil(
          "revalidation to start",
          () => (window.__previewModelListCallCount ?? 0) > baselineCalls,
        );
        const refreshStartedAt = window.__previewModelListLastStartedAt ?? performance.now();
        await waitUntil(
          "revalidation to finish",
          () => (window.__previewModelListActiveCount ?? 0) === 0,
        );
        await new Promise((resolve) => setTimeout(resolve, 240));
        await frame();
        window.__previewModelWarmupMetrics = {
          callDelta: (window.__previewModelListCallCount ?? 0) - baselineCalls,
          draft: textarea.value,
          refreshDurationMs: performance.now() - refreshStartedAt,
          startLatencyMs: refreshStartedAt - actionStartedAt,
        };
      } catch (error) {
        window.__previewModelWarmupError =
          error instanceof Error ? error.stack ?? error.message : String(error);
      } finally {
        window.__previewModelWarmupReady = true;
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
              throw new Error("Timed out while preparing " + label + ".");
            }
            await frame();
          }
        };
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Estresse de timeline expandida"),
        );
        if (!(threadButton instanceof HTMLButtonElement)) {
          throw new Error("The timeline stress chat is missing.");
        }
        threadButton.click();
        await waitUntil(
          "the stress turn",
          () =>
            document.getElementById("user-message-timeline-stress-user-message") !== null,
        );
        document.querySelector('button[aria-label="Mostrar trabalho do agente"]')?.click();
        await frame();
        document.querySelector(".agent-activity-group:not([open]) > summary")?.click();
        await waitUntil(
          "the virtualized activity list",
          () => document.querySelector(".agent-activity-virtual-list") !== null,
        );
        const timeline = document.querySelector(".timeline");
        if (!(timeline instanceof HTMLElement)) {
          throw new Error("The native-wheel scenario timeline is missing.");
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
            "The timeline did not stabilize at the top before the nested wheel test.",
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
          "The expanded files did not materialize sufficiently tall regions: " +
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
          throw new Error("The timeline is missing before locating " + label + ".");
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
          throw new Error("Missing nested activity: " + label);
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
          throw new Error("Missing scroll viewport for " + label + ".");
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
        const summary = details.querySelector(":scope > summary");
        if (!(summary instanceof HTMLElement)) {
          throw new Error("Missing outer summary for " + label + ".");
        }
        const summaryBounds = summary.getBoundingClientRect();
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
            "No visible point belongs to the ${label} region: " +
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
        const outerX = Math.min(
          summaryBounds.right - 8,
          summaryBounds.left + Math.max(8, summaryBounds.width / 2),
        );
        const outerY = Math.min(
          timelineBounds.bottom - 4,
          Math.max(timelineBounds.top + 4, summaryBounds.top + summaryBounds.height / 2),
        );
        const outerHit = document.elementFromPoint(outerX, outerY);
        if (!(outerHit instanceof Node) || region.contains(outerHit)) {
          throw new Error("The outer point still belongs to the " + label + " region.");
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
          outerX,
          outerY,
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
          throw new Error(
            "The virtual window became inconsistent before wheel input: " + label + ".",
          );
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
          throw new Error("The wheel sample became inconsistent for " + label + ".");
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
    const boundaryPointer = await client.evaluate(
      `(() => {
        const sample = window.__previewNestedWheelSample;
        if (
          sample === undefined ||
          sample.label !== "${label}" ||
          !(sample.region instanceof HTMLElement) ||
          !(sample.timeline instanceof HTMLElement)
        ) {
          throw new Error("The boundary region became inconsistent for " + label + ".");
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
        window.__previewNestedWheelBoundarySample = {
          events,
          label: "${label}",
          listener,
          nestedStart: sample.region.scrollTop,
          region: sample.region,
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
      x: boundaryPointer.x,
      y: boundaryPointer.y,
    });
    for (let index = 0; index < boundaryPointer.eventCount; index += 1) {
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        deltaX: 0,
        deltaY: boundaryPointer.deltaY,
        x: boundaryPointer.x,
        y: boundaryPointer.y,
      });
    }
    const boundary = await client.evaluate(
      `new Promise((resolve, reject) => {
        const sample = window.__previewNestedWheelBoundarySample;
        if (
          sample === undefined ||
          sample.label !== "${label}" ||
          !(sample.region instanceof HTMLElement) ||
          !(sample.timeline instanceof HTMLElement)
        ) {
          reject(new Error("The boundary sample became inconsistent for ${label}."));
          return;
        }
        const positions = [sample.timeline.scrollTop];
        let remainingFrames = 12;
        const measure = () => {
          positions.push(sample.timeline.scrollTop);
          remainingFrames -= 1;
          if (remainingFrames > 0) {
            requestAnimationFrame(measure);
            return;
          }
          sample.timeline.removeEventListener("wheel", sample.listener);
          const frameDeltas = positions.slice(1).map(
            (position, index) => position - (positions[index] ?? position),
          );
          resolve({
            distinctTimelinePositions: new Set(
              positions.map((position) => Math.round(position * 10)),
            ).size,
            events: sample.events,
            maximumFrameDelta: Math.max(0, ...frameDeltas.map((delta) => Math.abs(delta))),
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
          throw new Error("The reversal region became inconsistent for " + label + ".");
        }
        const boundaryDelta = 80;
        const reverseDelta = 20;
        const maximumNestedScroll = sample.region.scrollHeight - sample.region.clientHeight;
        const maximumTimelineScroll =
          sample.timeline.scrollHeight - sample.timeline.clientHeight;
        const direction =
          maximumTimelineScroll - sample.timeline.scrollTop >= boundaryDelta + 2 ? 1 : -1;
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
          label: "${label}",
          listener,
          nestedStart: sample.region.scrollTop,
          region: sample.region,
          timeline: sample.timeline,
          timelineStart: sample.timeline.scrollTop,
        };
        return {
          boundaryDeltaY: direction * boundaryDelta,
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
      deltaY: reversalPointer.boundaryDeltaY,
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
          reject(new Error("The reversal sample became inconsistent for ${label}."));
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
    const outerPointer = await client.evaluate(
      `(() => {
        const sample = window.__previewNestedWheelSample;
        if (
          sample === undefined ||
          sample.label !== "${label}" ||
          !(sample.region instanceof HTMLElement) ||
          !(sample.timeline instanceof HTMLElement)
        ) {
          throw new Error("The outer region became inconsistent for " + label + ".");
        }
        const delta = 80;
        const maximumTimelineScroll =
          sample.timeline.scrollHeight - sample.timeline.clientHeight;
        const direction =
          maximumTimelineScroll - sample.timeline.scrollTop >= delta + 2 ? 1 : -1;
        window.__previewNestedWheelOuterSample = {
          label: "${label}",
          nestedStart: sample.region.scrollTop,
          region: sample.region,
          timeline: sample.timeline,
          timelineStart: sample.timeline.scrollTop,
        };
        return {
          deltaY: direction * delta,
          x: ${JSON.stringify(pointer.outerX)},
          y: ${JSON.stringify(pointer.outerY)},
        };
      })()`,
      false,
    );
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: outerPointer.x,
      y: outerPointer.y,
    });
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      deltaX: 0,
      deltaY: outerPointer.deltaY,
      x: outerPointer.x,
      y: outerPointer.y,
    });
    await client.evaluate(
      `new Promise((resolve) => setTimeout(
        () => requestAnimationFrame(() => requestAnimationFrame(resolve)),
        80,
      ))`,
      true,
    );
    const outer = await client.evaluate(
      `(() => {
        const sample = window.__previewNestedWheelOuterSample;
        if (
          sample === undefined ||
          sample.label !== "${label}" ||
          !(sample.region instanceof HTMLElement) ||
          !(sample.timeline instanceof HTMLElement)
        ) {
          throw new Error("The outer sample became inconsistent for " + label + ".");
        }
        return {
          nestedDelta: sample.region.scrollTop - sample.nestedStart,
          timelineDelta: sample.timeline.scrollTop - sample.timelineStart,
        };
      })()`,
      false,
    );
    samples[label] = { boundary, internal, outer, reversal };
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
      .find((element) => element.textContent?.includes("Leu arquivo"))`,
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
        throw new Error("The row used to position the intrinsic interaction is missing.");
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
        throw new Error("The row used to validate intrinsic interaction is missing.");
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
        throw new Error("The row has insufficient outer area for the hover check.");
      }
      const candidateBounds = [
        action.getBoundingClientRect(),
        identity.getBoundingClientRect(),
        icon.getBoundingClientRect(),
        bounds,
      ];
      const hoverPoint = candidateBounds
        .flatMap((candidate) => [
          { x: candidate.left + Math.min(4, candidate.width / 2), y: candidate.top + candidate.height / 2 },
          { x: candidate.left + candidate.width / 2, y: candidate.top + candidate.height / 2 },
          { x: candidate.right - Math.min(4, candidate.width / 2), y: candidate.top + candidate.height / 2 },
        ])
        .find(({ x, y }) => {
          const hit = document.elementFromPoint(x, y);
          return hit !== null && summary.contains(hit);
        });
      if (hoverPoint === undefined) {
        throw new Error("The row has no visible point for the hover check.");
      }
      window[${stateKey}] = { rest: window.__capturePreviewIntrinsicActivity() };
      return {
        farX,
        hoverX: hoverPoint.x,
        y: hoverPoint.y,
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
          throw new Error("The active command was not mounted for the follow check.");
        }
        if (!command.open) {
          command.querySelector(":scope > summary")?.click();
        }
        await frame();
        await frame();
        const timeline = document.querySelector(".timeline");
        const region = command.querySelector(".command-card-scroll");
        if (!(timeline instanceof HTMLElement) || !(region instanceof HTMLElement)) {
          throw new Error("The active command's inner output is missing.");
        }
        const maximumTimelineScroll = timeline.scrollHeight - timeline.clientHeight;
        timeline.scrollTop = Math.max(0, maximumTimelineScroll - 160);
        await frame();
        await frame();
        const scrollToEndButton = document.querySelector(
          'button[aria-label="Ir para o fim da conversa"]',
        );
        if (!(scrollToEndButton instanceof HTMLButtonElement)) {
          throw new Error("The control for following the end of the timeline is missing.");
        }
        scrollToEndButton.click();
        const followDeadline = performance.now() + 1200;
        while (
          Math.abs(timeline.scrollHeight - timeline.clientHeight - timeline.scrollTop) > 2
        ) {
          if (performance.now() > followDeadline) {
            throw new Error("The timeline did not finish navigating to the end.");
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
  const compareRetainedIdentitiesSource = compareRetainedIdentities.toString();
  return `(() => {
    void (async () => {
      try {
        window.__timelineStressProgress = { phase: "starting" };
        const compareRetainedIdentities = ${compareRetainedIdentitiesSource};
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        const waitUntil = async (label, predicate, timeoutMs) => {
          const deadline = performance.now() + timeoutMs;
          while (!predicate()) {
            if (performance.now() > deadline) {
              throw new Error("Timed out while preparing " + label + ".");
            }
            await frame();
          }
        };
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Estresse de timeline expandida"),
        );
        threadButton?.click();
        await waitUntil(
          "the first stress turn",
          () => document.querySelector(".conversation-turn") !== null,
          3000,
        );
        document.querySelector('button[aria-label="Mostrar trabalho do agente"]')?.click();
        await frame();
        document.querySelector(".agent-activity-group:not([open]) > summary")?.click();
        await waitUntil(
          "the virtualized activity list",
          () => document.querySelector(".agent-activity-virtual-list") !== null,
          3000,
        );
        window.__timelineStressProgress = { phase: "activity-list-ready" };
        const timeline = document.querySelector(".timeline");
        if (!(timeline instanceof HTMLElement)) {
          throw new Error("The stress-scenario timeline is missing.");
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
          throw new Error("The timeline did not stabilize at the top before expansion.");
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
            "Expansion visited " +
              visited.size +
              " of 180 activities in " +
              iterations +
              " iterations. " +
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

        const mountedSummariesByKey = () => {
          const summaries = new Map();
          for (const wrapper of document.querySelectorAll(".agent-activity-virtual-item")) {
            const key = wrapper.getAttribute("data-virtual-activity-key");
            const summary = wrapper.querySelector("summary");
            if (key !== null && summary instanceof HTMLElement) {
              summaries.set(key, summary);
            }
          }
          return summaries;
        };
        const probeMaximum = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
        if (probeMaximum <= 1) {
          throw new Error("The timeline lacks enough range to probe identity while scrolling.");
        }
        const probeStep = Math.max(
          1,
          Math.min(timeline.clientHeight / 4, probeMaximum / 8),
        );
        timeline.scrollTop = probeMaximum / 4;
        await frame();
        await frame();
        let previousProbeSummaries = mountedSummariesByKey();
        let summaryIdentityProbeComparisons = 0;
        let summaryIdentityProbeChanges = 0;
        for (let probeIndex = 0; probeIndex < 6; probeIndex += 1) {
          timeline.scrollTop = Math.min(probeMaximum, timeline.scrollTop + probeStep);
          await frame();
          await frame();
          const currentProbeSummaries = mountedSummariesByKey();
          const comparison = compareRetainedIdentities(
            previousProbeSummaries,
            currentProbeSummaries,
          );
          summaryIdentityProbeComparisons += comparison.retainedCount;
          summaryIdentityProbeChanges += comparison.replacementCount;
          previousProbeSummaries = currentProbeSummaries;
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
        let rapidSummaryComparisons = 0;
        let rapidSummaryIdentityChanges = 0;
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
              currentSummariesByKey.set(key, summary);
            }
            const rapidIdentityComparison = compareRetainedIdentities(
              previousSummariesByKey,
              currentSummariesByKey,
            );
            rapidSummaryComparisons += rapidIdentityComparison.retainedCount;
            rapidSummaryIdentityChanges += rapidIdentityComparison.replacementCount;
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
          "the lightweight control chat",
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
          "the virtualized list to reopen",
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
          throw new Error("The restored timeline is missing.");
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
            "The timeline did not release manual ownership at the top (scrollTop=" +
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
            "The anchor keys were not materialized at the top: " +
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
            throw new Error("Virtualization replaced the positioned anchor before measurement.");
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
            throw new Error("The target anchor stopped being materialized after collapse.");
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
          summaryIdentityProbeComparisons,
          summaryIdentityProbeChanges,
          rapidSummaryComparisons,
          rapidSummaryIdentityChanges,
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
              throw new Error("Timed out while preparing " + label + ".");
            }
            await frame();
          }
        };
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Reconciliação de comandos paralelos"),
        );
        threadButton?.click();
        await waitUntil(
          "the reconciliation turn",
          () => document.querySelector(".conversation-turn") !== null,
          3000,
        );
        document.querySelector('button[aria-label="Mostrar trabalho do agente"]')?.click();
        await waitUntil(
          "the initial command group",
          () => document.querySelector(".agent-activity-group > summary") !== null,
          3000,
        );
        document.querySelector(".agent-activity-group:not([open]) > summary")?.click();
        await waitUntil(
          "the mounted command list",
          () => document.querySelector(".agent-activity-virtual-item") !== null,
          3000,
        );
        const firstRunningTitle = document.querySelector(
          ".command-activity-card .activity-title.is-running",
        );
        window.__activityReconciliationStartedPresentation = {
          completedAtCapture: Number(
            document.documentElement.dataset.activityReconciliationCompleted ?? 0,
          ),
          title: firstRunningTitle?.textContent?.trim() ?? null,
        };
        await waitUntil(
          "the out-of-order command completion",
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
              throw new Error("Timed out waiting for " + label + ".");
            }
            await frame();
          }
        };
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Inspecionar janela de contexto"),
        );
        threadButton?.click();
        await waitUntil(
          "the running activity parent title",
          () => document.querySelector(
            ".agent-activity-group > .agent-activity-summary .activity-title.is-running",
          ) !== null,
          3000,
        );
        const title = document.querySelector(
          ".agent-activity-group > .agent-activity-summary .activity-title.is-running",
        );
        if (!(title instanceof HTMLElement)) {
          throw new Error("The animated parent activity title was not found.");
        }
        const group = title.closest(".agent-activity-group");
        if (!(group instanceof HTMLElement)) {
          throw new Error("The animated activity group was not found.");
        }
        if (!(group instanceof HTMLDetailsElement)) {
          throw new Error("The animated activity group does not use details semantics.");
        }
        if (!group.open) {
          const summary = group.querySelector(":scope > .agent-activity-summary");
          if (!(summary instanceof HTMLElement)) {
            throw new Error("The animated activity header was not found.");
          }
          summary.click();
          await frame();
          await frame();
        }
        await waitUntil(
          "a running child activity",
          () => group.querySelector(
            ".agent-activity-viewport .activity-title.is-running",
          ) !== null,
          3000,
        );
        const isActive = () => title.classList.contains("is-shimmer-active");
        if (isActive()) {
          await waitUntil("the ongoing pulse to finish", () => !isActive(), 2500);
        }
        await waitUntil("the first pulse to start", isActive, 2500);
        const firstStartedAt = performance.now();
        const sweep = title.querySelector(".activity-title-sweep");
        if (!(sweep instanceof HTMLElement)) {
          throw new Error("The shimmer visual layer was not found.");
        }
        const activeStyle = getComputedStyle(sweep);
        const activeAnimation = {
          duration: activeStyle.animationDuration,
          iterationCount: activeStyle.animationIterationCount,
          name: activeStyle.animationName,
          timingFunction: activeStyle.animationTimingFunction,
        };
        await waitUntil("the first pulse to finish", () => !isActive(), 2500);
        const firstFinishedAt = performance.now();
        const inactiveAnimationName = getComputedStyle(sweep).animationName;
        await waitUntil("the second pulse to start", isActive, 3000);
        const secondStartedAt = performance.now();
        window.__activityShimmerMetrics = {
          activeDurationMs: firstFinishedAt - firstStartedAt,
          cadenceMs: secondStartedAt - firstStartedAt,
          activeAnimation,
          childRunningTargets: group.querySelectorAll(
            ".agent-activity-viewport .activity-title.is-running",
          ).length,
          childShimmerTargets: group.querySelectorAll(
            ".agent-activity-viewport .activity-title.is-shimmer-active",
          ).length,
          childSweepLayers: group.querySelectorAll(
            ".agent-activity-viewport .activity-title-sweep",
          ).length,
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
      throw new Error("The shimmer timing metrics are missing.");
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
      throw new Error("The timeline stress metrics are missing.");
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
      startedPresentation: window.__activityReconciliationStartedPresentation ?? null,
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
        throw new Error("Missing element: " + label);
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
    const title = document.querySelector(
      ".agent-activity-group > .agent-activity-summary .activity-title.is-running",
    );
    const base = title?.querySelector(".activity-title-base");
    const sweep = title?.querySelector(".activity-title-sweep");
    const highlight = sweep?.querySelector(".activity-title-highlight");
    if (
      !(title instanceof HTMLElement) ||
      !(base instanceof HTMLElement) ||
      !(sweep instanceof HTMLElement) ||
      !(highlight instanceof HTMLElement)
    ) {
      throw new Error("The animated activity layers are missing.");
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
      throw new Error("A completed reference activity is missing.");
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
      sweepKeyframeTransforms:
        sweepAnimation?.effect?.getKeyframes().map((keyframe) => keyframe.transform) ?? [],
      highlightKeyframeTransforms:
        highlightAnimation?.effect?.getKeyframes().map((keyframe) => keyframe.transform) ?? [],
      maskImage: sweepStyle.maskImage || sweepStyle.webkitMaskImage,
      passPositions,
      pausePositions,
      alignmentError,
      sidebarItemGaps,
      selectedThreadBackground: selectedThreadStyle?.backgroundColor ?? null,
      selectedThreadBoxShadow: selectedThreadStyle?.boxShadow ?? null,
      planExplanationCount: document.querySelectorAll(".plan-progress-explanation").length,
      standaloneThinkingCount: document.querySelectorAll(".thinking-activity-status").length,
      runningGroupedChildCount: document.querySelectorAll(
        ".grouped-activity-item .activity-title.is-running",
      ).length,
      completedTokenText:
        document.querySelector('.conversation-turn[data-status="completed"] .turn-token-usage')
          ?.textContent?.trim() ?? null,
      activeTokenText:
        document.querySelector('.conversation-turn[data-status="inProgress"] .turn-token-usage')
          ?.textContent?.trim() ?? null,
      reasoningHeadlineSequence: JSON.parse(
        document.documentElement.dataset.reasoningHeadlineSequence ?? "[]",
      ),
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
      throw new Error("The third user-message anchor is missing.");
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
      throw new Error("The scroll-ownership scenario was not initialized.");
    }
    const first = document.querySelector(
      '.timeline-virtual-item[data-virtual-turn-id="' + state.firstId + '"]',
    );
    const anchor = document.querySelector(
      '.timeline-virtual-item[data-virtual-turn-id="' + state.anchorId + '"]',
    );
    if (!(first instanceof HTMLElement) || !(anchor instanceof HTMLElement)) {
      throw new Error("The manual-scroll reference items were unmounted.");
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

function nestedScrollContainmentVisualAuditExpression() {
  return `(() => {
    if (window.__previewNestedScrollError !== undefined) {
      throw new Error(window.__previewNestedScrollError);
    }
    const metrics = window.__previewNestedScrollMetrics;
    if (metrics === undefined) {
      throw new Error("The nested-scroll containment scenario was not initialized.");
    }
    return {
      ...metrics,
      viewport: { width: innerWidth, height: innerHeight },
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`;
}

function modelCatalogWarmupVisualAuditExpression() {
  return `(() => {
    if (window.__previewModelWarmupError !== undefined) {
      throw new Error(window.__previewModelWarmupError);
    }
    const metrics = window.__previewModelWarmupMetrics;
    if (metrics === undefined) {
      throw new Error("The catalog warm-up scenario was not initialized.");
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
      throw new Error("The native-wheel scenario for expanded files was not initialized.");
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
      throw new Error("The follow-after-inner-scroll scenario was not initialized.");
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
              throw new Error("Timed out while preparing " + label + ".");
            }
            await frame();
          }
        };
        const threadButton = [...document.querySelectorAll(".thread-main")].find(
          (button) => button.textContent?.includes("Estresse de 100000 arquivos"),
        );
        threadButton?.click();
        await waitUntil(
          "the turn with 100,000 files",
          () => document.querySelector(".conversation-turn") !== null,
          5000,
        );
        document.querySelector('button[aria-label="Mostrar trabalho do agente"]')?.click();
        await frame();
        document.querySelector(".agent-activity-group:not([open]) > summary")?.click();
        await waitUntil(
          "the virtual list of 100,000 files",
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
          throw new Error("The extreme timeline is missing.");
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
          "a visible extreme anchor",
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
      throw new Error("The 100,000-file metrics are missing.");
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
      throw new Error("Live details for the running command are missing.");
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
      throw new Error("The direct single-change block is missing.");
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
      throw new Error("The group's inner change is missing.");
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
      throw new Error("The highlighted Rust diff is missing.");
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
      throw new Error("The complete review structure is missing.");
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
      throw new Error("The created Rust-file diff is missing.");
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
      throw new Error("Typed read and search outputs are missing.");
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
      throw new Error("The composer-panel layer metrics are missing.");
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
        throw new Error("Missing element: " + label);
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
        throw new Error("Missing element: " + label);
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
    const firstCommand = rectangle(firstCommandElement, "first command");
    const terminalRead = rectangle(terminalReadElement, "read chat terminal");
    const finalAnswer = rectangle(finalAnswerElement, "final answer");
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
      commentaryStyle: styles(firstCommentaryElement, "first commentary"),
      firstCommand,
      firstCommandText: firstCommandElement?.textContent?.trim() ?? null,
      activityStyle: styles(firstCommandElement, "first command"),
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
        throw new Error("Missing element: " + selector);
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
        throw new Error("Missing element: " + selector);
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
    const languageSelect = document.querySelector(".language-preference-select");
    if (!(languageSelect instanceof HTMLSelectElement)) {
      throw new Error("The language preference selector is missing.");
    }
    const languageSelectStyle = getComputedStyle(languageSelect);
    const measurementContext = document.createElement("canvas").getContext("2d");
    if (measurementContext === null) {
      throw new Error("A canvas context is required to measure the selected language label.");
    }
    measurementContext.font = languageSelectStyle.font;
    const selectedLanguageLabel = languageSelect.selectedOptions[0]?.textContent?.trim() ?? "";
    const selectedLanguageLabelWidth = measurementContext.measureText(selectedLanguageLabel).width;
    const languageSelectTextWidth =
      languageSelect.clientWidth -
      Number.parseFloat(languageSelectStyle.paddingLeft) -
      Number.parseFloat(languageSelectStyle.paddingRight);
    const languageSelectLabelClearance =
      languageSelectTextWidth - selectedLanguageLabelWidth;
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
      languageSelect: rectangle(".language-preference-select"),
      languageSelectFieldSizing: languageSelectStyle.fieldSizing,
      languageSelectLabelClearance,
      languageSelectTextWidth,
      selectedLanguageLabel,
      selectedLanguageLabelWidth,
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
        throw new Error("Missing element: " + selector);
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
        throw new Error("Missing element: " + label);
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
        throw new Error("Missing element: " + selector);
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
      throw new Error("The profile scroll container is missing.");
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
        throw new Error("Missing element: " + selector);
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
      throw new Error("The Automations surface or main panel is missing.");
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
        throw new Error("Missing element: " + selector);
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
      throw new Error("The Automation editor controls are missing.");
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
    `unexpected chat viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "chat created global horizontal overflow");
  assert(
    metrics.timelineHorizontalOverflow <= tolerance,
    "the timeline created horizontal overflow",
  );
  assert(
    metrics.userBubble.top - metrics.timelineInner.top >= 28 &&
      metrics.userBubble.top - metrics.timelineInner.top <= 36,
    "the conversation start does not preserve the compact top spacing",
  );
  assert(
    metrics.threadContentMaxWidth === "768px",
    "the canonical physical width equivalent to 48rem changed",
  );
  assert(
    metrics.timelineInner.width <= 768 + tolerance && metrics.timelineInner.width >= 560,
    "the conversation column left the canonical responsive width",
  );
  assert(
    metrics.userBubbleStyle.backgroundColor === "rgb(34, 34, 34)",
    "the user bubble does not use #222222",
  );
  assert(metrics.userBubbleStyle.borderRadius === "12px", "the user bubble radius is not 12px");
  assert(metrics.userBubbleStyle.borderTopWidth === "0px", "the user bubble gained an unexpected border");
  assert(
    metrics.userBubbleStyle.paddingTop === "9px" &&
      metrics.userBubbleStyle.paddingRight === "12px" &&
      metrics.userBubbleStyle.paddingBottom === "9px" &&
      metrics.userBubbleStyle.paddingLeft === "12px",
    "the user bubble padding diverged from the reference",
  );
  assert(metrics.durationStyle.fontSize === "14px", "the duration does not use 14px typography");
  assert(metrics.durationStyle.fontWeight === "400", "the duration became too heavy");
  assert(
    metrics.durationStyle.color === "rgb(144, 144, 144)",
    "the duration does not use #909090 gray",
  );
  assert(metrics.divider.height <= 1 + tolerance, "the turn divider became too thick");
  assert(
    metrics.dividerStyle.backgroundColor === "rgb(45, 45, 45)",
    "the turn divider does not use #2d2d2d",
  );
  assert(metrics.commentaryStyle.fontSize === "14px", "commentary does not use 14px typography");
  assert(metrics.commentaryStyle.lineHeight === "22.4px", "commentary does not use a 1.6 line height");
  assert(
    metrics.commentaryStyle.color === "rgb(223, 223, 223)",
    "commentary does not use #dfdfdf",
  );
  assert(
    metrics.commentaryStyle.fontFamily.includes("OpenAI Sans"),
    "chat no longer prioritizes OpenAI Sans",
  );
  assert(metrics.activityStyle.fontSize === "14px", "the activity does not use 14px typography");
  assert(metrics.activityStyle.fontWeight === "400", "the activity became too heavy");
  assert(
    metrics.activityStyle.color === "rgb(144, 144, 144)",
    "the activity does not use #909090",
  );
  assert(
    metrics.firstCommandText?.startsWith("Executou Get-Content -Raw docs/RULES.md"),
    "the first command does not use the canonical semantics",
  );
  assert(metrics.terminalReadText === "Terminal do chat lido", "the terminal-read label is incorrect");
  assert(
    JSON.stringify(metrics.groupSummaries) ===
      JSON.stringify(["Executou comandos", "Executou comandos e leu o terminal do chat"]),
    "the semantic activity summaries diverged",
  );
  assert(metrics.commentaryCount === 3, "the scenario did not render all three commentary messages");
  assert(metrics.commandRowCount === 7, "the expansion did not render the expected commands");
  assert(metrics.activityGroupCount === 2, "the timeline did not create the two canonical groups");
  assert(metrics.openActivityGroupCount === 1, "more than one group remained expanded");
  assert(metrics.turnExpanded === true, "the turn work did not remain expanded");
  assert(metrics.timelineAriaLabel === "Conversa", "the timeline lost its accessible name");
  assert(metrics.articleCount === 5, "messages no longer use semantic article elements");
  assert(metrics.detailsCount >= 9, "activity disclosures became incomplete");
  assert(metrics.workOrderIsCorrect === true, "the visual turn order changed");
  assert(
    metrics.bodyText.includes("Trabalhou por 1 min 34 s") &&
      metrics.bodyText.includes("Auditoria rápida concluída"),
    "the reference turn became incomplete",
  );
}

function validateComposerFastModeMetrics(metrics, viewport) {
  const tolerance = 1;
  validateChromeMetrics(metrics, viewport);
  assert(metrics.horizontalOverflow <= tolerance, "the composer created horizontal overflow");
  assert(metrics.buttonHorizontalOverflow <= tolerance, "the model selector clips its content");
  assert(metrics.indicatorCount === 1, "fast mode does not display exactly one indicator");
  assert(metrics.accessibleLabel === true, "the fast indicator has no accessible description");
  assert(
    metrics.indicator.right <= metrics.name.left + tolerance,
    "the bolt is not positioned to the left of the model name",
  );
  assert(
    metrics.name.left - metrics.indicator.right <= 8 + tolerance,
    "the bolt is too far from the model name",
  );
  assert(
    Math.abs(
      (metrics.indicator.top + metrics.indicator.bottom) / 2 -
        (metrics.name.top + metrics.name.bottom) / 2,
    ) <= tolerance,
    "the bolt is not centered with the model name",
  );
  assert(metrics.indicator.width >= 12, "the bolt became too small");
  assert(metrics.fullAccessColor === "rgb(251, 106, 34)", "Full access lost its orange color");
  assert(metrics.projectIconColor === "rgb(74, 222, 128)", "the project icon color was not applied");
  assert(metrics.diffAddedColor === "#4ade80", "additions do not use semantic lime green");
  assert(metrics.diffDeletedColor === "#ff6764", "deletions do not use semantic red");
}

function validateComposerUltraEffortMetrics(metrics) {
  assert(metrics.horizontalOverflow <= 1, "the Ultra label created horizontal overflow");
  assert(metrics.text === "Ultra", "the active effort lost the Ultra label");
  assert(metrics.expectedColor === "#a78bfa", "the Ultra semantic token changed");
  assert(metrics.color === "rgb(167, 139, 250)", "active Ultra effort is no longer purple");
}

function validateComposerRuntimeRestrictionsMetrics(metrics) {
  assert(metrics.horizontalOverflow <= 1, "the contextual notice created horizontal overflow");
  assert(metrics.selectedModel === "5.6 Luna", "the configured Code Mode model was replaced");
  assert(
    metrics.persistentCompatibilityNoticeCount === 0,
    "the runtime requirement remained visible outside the selector",
  );
  assert(metrics.ultraDisabled === true, "Ultra became selectable without multi-agent execution");
  assert(
    metrics.ultraLabel === "Ultra" && metrics.ultraRequirement === "Requer execução multiagente",
    "the Ultra requirement was not confined to its option",
  );
}

function validateModelCatalogWarmupMetrics(metrics, viewport) {
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected catalog-warmup viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= 1, "catalog warmup created horizontal overflow");
  assert(metrics.callDelta === 1, `new task and draft triggered ${metrics.callDelta} revalidations`);
  assert(
    metrics.startLatencyMs >= 0 && metrics.startLatencyMs <= 250,
    `revalidation took ${metrics.startLatencyMs.toFixed(3)} ms to start`,
  );
  assert(
    metrics.refreshDurationMs >= 160 && metrics.refreshDurationMs <= 800,
    `simulated revalidation took ${metrics.refreshDurationMs.toFixed(3)} ms`,
  );
  assert(metrics.draft === "Preparar catálogo antes do envio", "catalog warmup changed the draft");
}

function validateActiveActivityReflectionMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected reflection viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "reflection created horizontal overflow");
  assert(metrics.reducedMotion === false, "the motion audit did not normalize the preference");
  assert(
    metrics.titleText === metrics.baseText + metrics.highlightText,
    "the visual layer lost the title text",
  );
  assert(metrics.baseText === metrics.highlightText, "the reflection does not replicate the active title");
  assert(metrics.baseText === "Executando comando", "the parent header duplicated command timing");
  assert(
    metrics.completedTokenText?.includes("10.000 tokens") === true,
    `persisted tokens disappeared from the completed turn (${JSON.stringify(metrics.completedTokenText)})`,
  );
  assert(
    metrics.activeTokenText?.includes("62 tokens") === true,
    `confirmed tokens disappeared from the active turn (${JSON.stringify(metrics.activeTokenText)})`,
  );
  assert(
    metrics.sweepLayerCount === 1 && metrics.highlightLayerCount === 1,
    "the August 21 variant did not preserve a single visual strip",
  );
  assert(
    metrics.obsoleteLayerCount === 0,
    "later animation layers remain mounted",
  );
  assert(
    metrics.titleColor === metrics.completedTitleColor &&
      metrics.titleColor === "rgb(144, 144, 144)",
    `active base text does not match the completed activity: ${JSON.stringify({
      active: metrics.titleColor,
      completed: metrics.completedTitleColor,
      reference: metrics.completedTitleText,
    })}`,
  );
  assert(
    metrics.titleFontWeight === metrics.completedTitleFontWeight &&
      metrics.titleFontWeight === "400",
    `active base-text weight does not match the completed activity: ${JSON.stringify({
      active: metrics.titleFontWeight,
      completed: metrics.completedTitleFontWeight,
    })}`,
  );
  assert(metrics.highlightColor === "rgb(255, 255, 255)", "the highlight no longer uses white");
  assert(metrics.titleFontSize === "14px", "the historical title is not 14px");
  assert(
    metrics.titleDisplay === "block",
    "the animated title was not blockified correctly as a flex item",
  );
  assert(
    metrics.sweepAnimationName === "activity-reflection-sweep" &&
      metrics.highlightAnimationName === "activity-reflection-text",
    "the two synchronized reflection transforms are missing",
  );
  assert(metrics.animationDuration === "1s", "the reflection pulse does not last one second");
  assert(metrics.animationDelay === "0s", "the CSS pulse retained a residual delay");
  assert(
    metrics.animationTimingFunction.includes("steps(48"),
    "the pulse lost its canonical 48-step progression",
  );
  assert(metrics.animationIterationCount === "1", "the reflection started repeating continuously again");
  assert(
    metrics.keyframeEasings.length >= 2,
    `the sweep keyframes are missing: ${JSON.stringify(metrics.keyframeEasings)}`,
  );
  const sweepTransforms = JSON.stringify(metrics.sweepKeyframeTransforms);
  const highlightTransforms = JSON.stringify(metrics.highlightKeyframeTransforms);
  assert(
    sweepTransforms.includes("-50%") &&
      sweepTransforms.includes("125%") &&
      !sweepTransforms.includes("translate3d"),
    `the strip lost the canonical 2D translation: ${sweepTransforms}`,
  );
  assert(
    highlightTransforms.includes("50%") &&
      highlightTransforms.includes("-125%") &&
      !highlightTransforms.includes("translate3d"),
    `the text lost the canonical 2D counter-translation: ${highlightTransforms}`,
  );
  assert(
    metrics.sidebarItemGaps.length > 0 &&
      metrics.sidebarItemGaps.every((gap) => gap !== null && gap >= 3.5),
    `sidebar items remain visually crowded: ${JSON.stringify(metrics.sidebarItemGaps)}`,
  );
  assert(
    metrics.selectedThreadBackground === "rgba(255, 255, 255, 0.12)",
    `chat selection does not use the strong surface: ${metrics.selectedThreadBackground}`,
  );
  assert(
    metrics.selectedThreadBoxShadow !== null && metrics.selectedThreadBoxShadow !== "none",
    "chat selection lost its separating outline",
  );
  assert(metrics.planExplanationCount === 0, "the redundant plan explanation is still visible");
  assert(
    metrics.maskImage.includes("linear-gradient") &&
      metrics.maskImage.includes("20%") &&
      metrics.maskImage.includes("30%") &&
      metrics.maskImage.includes("50%"),
    `the August 21 mask changed: ${metrics.maskImage}`,
  );
  assert(
    metrics.passPositions.length === 2 && new Set(metrics.passPositions).size === 2,
    `the strip did not cross the title: ${JSON.stringify(metrics.passPositions)}`,
  );
  assert(
    metrics.pausePositions.length === 3 && new Set(metrics.pausePositions).size === 3,
    `the strip became stuck before completing the sweep: ${JSON.stringify(metrics.pausePositions)}`,
  );
  assert(
    metrics.alignmentError !== null && metrics.alignmentError <= tolerance,
    `the highlighted text became misaligned: ${metrics.alignmentError}`,
  );
  assert(metrics.ariaHidden === "true", "the decorative strip entered the accessibility tree");
  assert(metrics.pointerEvents === "none", "the reflection started intercepting interaction");
}

function validateReasoningActivityReflectionMetrics(metrics, viewport) {
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected reflected-reasoning viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= 1, "reflected reasoning created horizontal overflow");
  assert(
    metrics.baseText === "Running focused checks" &&
      metrics.highlightText === metrics.baseText &&
      metrics.titleText === metrics.baseText + metrics.highlightText,
    `reasoning did not adopt the same live header (${JSON.stringify(metrics.baseText)})`,
  );
  assert(
    JSON.stringify(metrics.reasoningHeadlineSequence) ===
      JSON.stringify([
        "Implementing keyed Show with stable Index",
        "Planning verification",
        "Running focused checks",
      ]),
    `reasoning exposed partial or non-semantic headlines (${JSON.stringify(metrics.reasoningHeadlineSequence)})`,
  );
  assert(
    metrics.standaloneThinkingCount === 0,
    "reasoning reappeared as a second Thinking message",
  );
  assert(
    metrics.runningGroupedChildCount === 0,
    "a completed tool remained marked active during reasoning",
  );
  assert(
    metrics.sweepLayerCount === 1 &&
      metrics.highlightLayerCount === 1 &&
      metrics.sweepAnimationName === "activity-reflection-sweep",
    "the reasoning header lost the live-activity reflection",
  );
}

function validateUserMessageNavigationMetrics(metrics, viewport) {
  const tolerance = 2;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected message-navigation viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(
    metrics.horizontalOverflow <= tolerance,
    "message navigation created horizontal overflow",
  );
  assert(
    Math.abs(metrics.targetGap - metrics.expectedTargetGap) <= tolerance,
    `the marker did not navigate to the message's currently reachable position: ${JSON.stringify(metrics)}`,
  );
  assert(
    metrics.targetOffsetWithinTurn > 500,
    "the scenario did not validate a later message within the same turn",
  );
  assert(metrics.markerCurrent === "true", "the selected marker did not remain active");
  assert(metrics.expandedGroupCount >= 1, "the turn did not remain expanded during navigation");
}

function validateManualScrollOwnershipMetrics(metrics, viewport) {
  const tolerance = 2;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected scroll-ownership viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "manual scrolling created horizontal overflow");
  assert(
    Math.abs(metrics.visualDrift) <= tolerance,
    `a virtual measurement displaced the content being read: ${JSON.stringify(metrics)}`,
  );
  assert(
    Math.abs(metrics.compensationError) <= tolerance,
    `anchor correction did not exactly compensate the height change above the viewport ` +
      `(height ${metrics.heightDelta.toFixed(3)} px, scroll ` +
      `${metrics.scrollCompensation.toFixed(3)} px, error ${metrics.compensationError.toFixed(3)} px)`,
  );
}

function validateNestedScrollContainmentMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected scroll-containment viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "scroll containment created horizontal overflow");
  assert(metrics.styleReadCount === 0, "wheel handling forced a synchronous style read again");
  assert(
    metrics.containmentDurationMs <= 1000,
    `three internal boundaries did not stabilize in time: ${metrics.containmentDurationMs.toFixed(3)} ms`,
  );
  for (const [label, sample] of Object.entries({
    command: metrics.command,
    diff: metrics.diff,
    source: metrics.source,
  })) {
    assert(sample.defaultPrevented === false, `${label} canceled the internal native wheel event`);
    assert(
      Math.abs(sample.nestedScrollTop - sample.nestedStart) <= tolerance,
      `${label} moved after a synthetic wheel event without native action`,
    );
    assert(
      Math.abs(sample.timelineDelta) <= tolerance,
      `${label} leaked ${sample.timelineDelta}px into the timeline`,
    );
    assert(
      sample.overscrollBehaviorY === "contain",
      `${label} does not declare native vertical containment`,
    );
  }
}

function validateNestedScrollWheelOwnershipMetrics(metrics, viewport) {
  const tolerance = 2;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected native-wheel viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "native wheel handling created horizontal overflow");
  for (const [label, sample] of Object.entries({
    diff: metrics.diff,
    source: metrics.source,
  })) {
    const { boundary, internal, outer, reversal } = sample;
    assert(
      internal.events.length === 4,
      `${label} did not receive all four real internal wheel events`,
    );
    assert(
      internal.events.every((event) => event.cancelable === true),
      `${label} received a non-cancelable wheel event despite the explicit listener`,
    );
    assert(
      internal.events.every((event) => event.defaultPrevented === false),
      `${label} lost native scrolling despite available internal range`,
    );
    assert(
      Math.abs(internal.nestedDelta - internal.expectedNestedDelta) <= tolerance,
      `${label} consumed ${internal.nestedDelta}px instead of ${internal.expectedNestedDelta}px`,
    );
    assert(
      Math.abs(internal.timelineDelta) <= tolerance,
      `${label} also moved the timeline by ${internal.timelineDelta}px`,
    );
    assert(
      internal.canvasIdentityChanged === false,
      `${label} replaced the virtual canvas during internal wheel input`,
    );
    assert(
      internal.rowIdentityComparisons > 0 && internal.mountedRows > 0,
      `${label} did not preserve enough overlapping rows to validate identity`,
    );
    assert(
      internal.rowIdentityChanges === 0,
      `${label} remounted ${internal.rowIdentityChanges} rows that remained visible during scrolling`,
    );
    assert(boundary.events.length === 4, `${label} did not receive all four boundary wheel events`);
    assert(
      boundary.events.every((event) => event.cancelable === true),
      `${label} received a non-cancelable wheel event at the boundary`,
    );
    assert(
      boundary.events.every((event) => event.defaultPrevented === false),
      `${label} canceled the native wheel event at the boundary`,
    );
    assert(
      Math.abs(boundary.nestedDelta) <= tolerance,
      `${label} moved ${boundary.nestedDelta}px beyond the internal boundary`,
    );
    assert(
      Math.abs(boundary.timelineDelta) <= tolerance,
      `${label} leaked ${boundary.timelineDelta}px into the timeline at the boundary`,
    );
    assert(
      boundary.distinctTimelinePositions === 1,
      `${label} animated the timeline while the pointer remained inside the region`,
    );
    assert(
      boundary.maximumFrameDelta <= tolerance,
      `${label} moved an outer frame by ${boundary.maximumFrameDelta}px`,
    );
    assert(
      reversal.events.length === 2,
      `${label} did not receive the real wheel pair used for reversal`,
    );
    assert(
      reversal.events.every((event) => event.cancelable === true),
      `${label} received a non-cancelable wheel event during reversal`,
    );
    assert(
      reversal.events[0]?.defaultPrevented === false,
      `${label} canceled the boundary wheel event before reversal`,
    );
    assert(
      reversal.events[1]?.defaultPrevented === false,
      `${label} did not return the reverse direction to native internal scrolling`,
    );
    assert(
      Math.abs(reversal.nestedDelta - reversal.expectedNestedDelta) <= tolerance,
      `${label} moved ${reversal.nestedDelta}px internally after reversal; expected ${reversal.expectedNestedDelta}px`,
    );
    assert(
      Math.abs(reversal.timelineDelta) <= tolerance,
      `${label} moved the timeline by ${reversal.timelineDelta}px during internal reversal`,
    );
    assert(
      reversal.postCancelRange <= tolerance,
      `${label} continued drifting ${reversal.postCancelRange}px after the boundary wheel event`,
    );
    assert(
      Math.abs(outer.nestedDelta) <= tolerance,
      `${label} moved ${outer.nestedDelta}px after the pointer left the region`,
    );
    assert(
      Math.abs(outer.timelineDelta) > tolerance,
      `${label} did not release the timeline after the pointer moved to the outer surface`,
    );
  }
}

function validateNestedScrollFollowingMetrics(metrics, viewport) {
  const tolerance = 2;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected internal-scroll-following viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "internal scrolling created horizontal overflow");
  assert(
    metrics.defaultPrevented === false,
    "an internal region blocked wheel input that fit entirely within its own range",
  );
  assert(
    Math.abs(metrics.nestedDelta - metrics.expectedNestedDelta) <= tolerance,
    "the internal region did not fully consume its own wheel input",
  );
  assert(
    Math.abs(metrics.timelineDelta - 160) <= tolerance,
    `the timeline moved ${metrics.timelineDelta}px instead of 160px after growth (final distance ${metrics.distanceToEnd}px)`,
  );
  assert(
    Math.abs(metrics.distanceToEnd) <= tolerance,
    "the timeline became detached from the end after content growth",
  );
}

function validateLiveCommandOutputMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected live-output viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "live output created horizontal overflow");
  assert(
    metrics.commandHorizontalOverflow <= tolerance,
    "live output created horizontal overflow inside the command",
  );
  assert(metrics.open === true, "the running command did not remain expanded");
  assert(
    /^Comando em execução há (?:\d+s|\d+m \d+s|\d+h \d+m \d+s)$/u.test(metrics.title),
    `the open command lost its state or duration (${JSON.stringify(metrics.title)})`,
  );
  assert(
    metrics.prompt?.includes("Get-Content -LiteralPath src/ui/Timeline.tsx -Raw"),
    "the original command does not appear with the live output",
  );
  assert(
    metrics.outputText.includes("stdout:") &&
      metrics.outputText.includes("✓ 115 modules transformed.") &&
      metrics.outputText.includes("computing gzip size...") &&
      metrics.outputText.includes("stderr:") &&
      metrics.outputText.includes("warning: release validation is still running"),
    "incremental stdout and stderr are not visible before completion",
  );
  assert(metrics.hasFinalOutputView === false, "the live preview was mistaken for final output");
  assert(metrics.scrollable === true, "long output did not activate bounded scrolling");
  assert(metrics.followGap <= 2, "live output did not follow the latest line");
  assert(metrics.maximumHeight === "205px", "live output lost its vertical limit");
  assert(metrics.whiteSpace === "pre-wrap", "live output does not preserve line breaks");
}

function validateSingleFileChangeMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected single-file viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "the single file created horizontal overflow");
  assert(metrics.fileName === "engine.rs", "the direct file changed identity");
  assert(
    metrics.action === "Arquivo editado",
    "the single change lost the Edited file label",
  );
  assert(metrics.compact === true, "the single change does not use the compact presentation");
  assert(metrics.hasActivityIcon === true, "the single change lost its contextual icon");
  assert(metrics.borderTopWidth === "0px", "the single change regained a card outline");
  assert(metrics.borderRadius === "0px", "the single change regained bubble corners");
  assert(
    metrics.backgroundColor === "rgba(0, 0, 0, 0)",
    "the single change regained a card surface",
  );
  assert(
    metrics.groupedAction === "Arquivo editado",
    "the internal change lost the Edited file label",
  );
  assert(
    metrics.groupedHasActivityIcon === true,
    "the internal change lost the group's contextual icon",
  );
  assert(
    metrics.groupedHasRedundantHeading === false,
    "the group retained the redundant file-count header",
  );
  assert(
    metrics.groupedDirectFileCount === 3,
    "the group did not expose files immediately after the first expansion",
  );
  assert(
    metrics.groupedNestedCollectionCount === 0,
    "the file group retained a redundant intermediate expansion",
  );
  assert(
    metrics.newFileAction === "Arquivo criado",
    "the new file lost the Created file semantics",
  );
  assert(metrics.newFileBadge === "NOVO", "the new file lost the NEW badge");
  assert(metrics.newFileAdditions === "+256", "the new file lost its line count");
  assert(metrics.newFileHasDeletions === false, "the new file still displays a zero deletion count");
  assert(
    metrics.deletedFileAction === "Arquivo excluído",
    "the deleted file lost the Deleted file semantics",
  );
  assert(metrics.deletedFileBadge === "EXCLUÍDO", "the deleted file lost its badge");
  assert(
    metrics.deletedFileDeletions === "-288",
    "the deleted file does not display the authoritative removed-line total",
  );
  assert(
    metrics.deletedFileHasAdditions === false,
    "the deleted file still displays a zero addition count",
  );
  assert(metrics.open === false, "the single change started expanded");
  assert(metrics.aggregateContainerCount === 0, "the single change still created a grouping container");
  assert(metrics.directDiffVisible === false, "the single-file diff started visible");
  validateIntrinsicActivityInteraction(metrics.intrinsicInteraction, "change", tolerance);
}

function validateIntrinsicActivityInteraction(interaction, label, tolerance) {
  assert(
    interaction?.rest !== undefined &&
      interaction.far !== undefined &&
      interaction.hover !== undefined,
    `the intrinsic interaction for ${label} was not captured`,
  );
  assert(
    interaction.rest.summaryWidth + 40 < interaction.rest.rowWidth,
    `the interactive area for ${label} still occupies the entire row`,
  );
  assert(
    interaction.rest.expanded === interaction.far.expanded &&
      interaction.rest.expanded === interaction.hover.expanded,
    `interaction incorrectly changed the expanded state for ${label}`,
  );
  const restingChevronOpacity = interaction.rest.expanded ? 1 : 0;
  assert(
    interaction.rest.chevronOpacity === restingChevronOpacity &&
      interaction.far.chevronOpacity === restingChevronOpacity,
    interaction.rest.expanded
      ? `the expanded ${label} chevron did not remain visible`
      : `the ${label} chevron became visible without actual proximity`,
  );
  assert(
    interaction.rest.hovered === false && interaction.far.hovered === false,
    `a distant position incorrectly activated hover for ${label}`,
  );
  assert(
    interaction.hover.hovered === true && interaction.hover.chevronOpacity === 1,
    `actual proximity did not reveal the ${label} chevron`,
  );
  assert(
    interaction.rest.actionColor === interaction.rest.identityColor &&
      interaction.rest.iconColor === interaction.rest.actionColor,
    `${label} does not use a uniform muted color at rest`,
  );
  assert(
    interaction.hover.actionColor === interaction.hover.identityColor &&
      interaction.hover.iconColor === interaction.hover.actionColor &&
      interaction.hover.actionColor !== interaction.rest.actionColor,
    `hover did not semantically highlight ${label}`,
  );
  assert(
    Math.abs(interaction.hover.summaryWidth - interaction.rest.summaryWidth) <= tolerance,
    `${label} changed width while revealing its chevron`,
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
    `unexpected review viewport at ${viewport.width}x${viewport.height}`,
  );
  validateWorkspaceSplitMetrics(
    metrics.workspaceSplit,
    "review",
    metrics.workspaceSplitInteraction,
  );
  assert(metrics.horizontalOverflow <= tolerance, "review created global horizontal overflow");
  assert(metrics.fileCount === 60, "review did not gather the turn's sixty changed files");
  assert(metrics.fileListScrollable, "the long review list did not preserve its own scrolling");
  assert(
    metrics.contentDisplay === "flex" &&
      metrics.contentFlexDirection === "column" &&
      metrics.contentContainerType === "size" &&
      metrics.fileListFlexGrow === "0" &&
      metrics.fileListFlexShrink === "1" &&
      metrics.stageFlexGrow === "1",
    "review lost explicit ownership between the bounded list and flexible stage",
  );
  assert(
    metrics.selectedFile?.endsWith("module-15.ts"),
    "the audit did not select the large review diff",
  );
  assert(
    metrics.fileListHeight <= maximumListHeight + tolerance,
    `the list consumed ${metrics.fileListHeight.toFixed(1)} px of ${metrics.contentHeight.toFixed(1)} available px`,
  );
  assert(
    Math.abs(metrics.contentHeight - metrics.fileListHeight - metrics.stageHeight) <= tolerance,
    "the list and stage do not fully divide the review's usable area",
  );
  assert(
    Math.abs(metrics.stageHeight - metrics.headerHeight - metrics.diffViewportHeight) <= tolerance,
    "the diff does not fill the remaining area below the file header",
  );
  assert(
    metrics.diffViewportSizing === "container" && metrics.diffViewportInlineHeight === "",
    "the review diff is competing for inline height with its container again",
  );
  assert(
    metrics.diffViewportHeight >= Math.min(120, metrics.contentHeight * 0.4),
    `the diff viewport was compressed to ${metrics.diffViewportHeight.toFixed(1)} px`,
  );
  assert(
    metrics.mountedRows === expectedMountedRows &&
      metrics.mountedRowIndexes[0] === 1,
    `the virtual window mounted ${metrics.mountedRows} rows for ${metrics.diffViewportClientHeight.toFixed(1)} px (${metrics.declaredRows} declared)`,
  );
  assert(
    metrics.rowGaps.every((gap) => Math.abs(gap - 20) <= tolerance),
    "mounted review rows lost the 20px virtual step",
  );
  assert(
    metrics.tableRole === "table" &&
      metrics.rowGroupRole === "rowgroup" &&
      metrics.rowRoles.every((role) => role === "row") &&
      metrics.rowCellRoles.every(
        (roles) => JSON.stringify(roles) === JSON.stringify(["rowheader", "cell"]),
      ),
    "the unified diff lost its semantic grid independent of native tables",
  );
  assert(
    metrics.canvasHeight >= metrics.diffViewportScrollHeight - tolerance,
    "the review's virtual canvas became smaller than its scrollable area",
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
    "review virtual geometry changed while scrolling under the production CSP",
  );
  assert(
    virtualizationCycle.initial.canvasHeight > virtualizationCycle.initial.clientHeight &&
      virtualizationCycle.initial.scrollTop === 0 &&
      virtualizationCycle.initial.mountedRowIndexes[0] === 1 &&
      virtualizationCycle.bottom.scrollTop > 0 &&
      virtualizationCycle.bottom.mountedRowIndexes[0] > 1 &&
      virtualizationCycle.restored.scrollTop === 0 &&
      virtualizationCycle.restored.mountedRowIndexes[0] === 1,
    "review did not preserve start, end, and return to top during rematerialization",
  );
}

function validateSyntaxHighlightedDiffMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected syntax-highlighted diff viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "the syntax-highlighted diff created horizontal overflow");
  assert(metrics.viewportHorizontalOverflow >= 0, "the diff viewport lost its scrollable width");
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
    assert(metrics.tokenKinds.includes(kind), `the diff did not produce ${kind}`);
  }
  assert(metrics.tokenCount >= 20, "the diff produced too few syntax tokens");
  assert(metrics.tokenColorCount >= 7, "the syntax palette does not contain enough distinct colors");
  assert(metrics.contextHasSyntax === true, "context lines did not receive syntax highlighting");
  assert(
    metrics.additionBackground === "rgb(31, 73, 50)",
    "the semantic addition background is not solid and crisp",
  );
  assert(
    metrics.deletionBackground === "rgb(82, 39, 37)",
    "the semantic deletion background is not solid and crisp",
  );
  assert(
    metrics.additionBackground !== metrics.deletionBackground,
    "additions and deletions lost visual distinction",
  );
  assert(metrics.keywordColor === "#c77dff", "keywords do not use the syntax palette's neon purple");
  assert(metrics.stringColor === "#ffb38a", "strings do not use the syntax palette");
  assert(
    metrics.expandedSummaryHasIdentity === false &&
      metrics.panelHeaderFile === "engine.rs" &&
      metrics.panelHeaderFileDecoration === "none" &&
      metrics.panelHeaderStats.length === 2,
    "the expanded diff does not use Codex's compact internal header",
  );
  assert(
    metrics.expandedSummaryAlignItems === "center" &&
      metrics.panelHeaderAlignItems === "center" &&
      metrics.expandedSummaryBorderBottomWidth === "0px" &&
      metrics.panelHeaderChildCenterOffsets.length === 3 &&
      metrics.panelHeaderChildCenterOffsets.every((offset) => Math.abs(offset) <= tolerance),
    "the diff header does not vertically center the file and statistics",
  );
  assert(
    Math.abs(metrics.panelHeaderHeight - 30) <= tolerance &&
      metrics.panelCopyLabel === "Copiar edição",
    "the internal diff header lost its height or copy action",
  );
  assert(
    metrics.panelBackground === "rgb(24, 24, 24)" &&
      metrics.viewportBackground === "rgba(0, 0, 0, 0)" &&
      metrics.viewportOpacity === "1" &&
      metrics.viewportFilter === "none" &&
      metrics.viewportBackdropFilter === "none",
    "the diff viewport overlays a second surface on the code again",
  );
  assert(
    metrics.additionCellBackground === "rgba(0, 0, 0, 0)" &&
      metrics.deletionCellBackground === "rgba(0, 0, 0, 0)",
    "cells duplicate the row's semantic fill again",
  );
  assert(
    metrics.additionRowWidth !== null &&
      metrics.deletionRowWidth !== null &&
      metrics.tableWidth !== null &&
      metrics.additionRowWidth + tolerance >= metrics.tableWidth &&
      metrics.deletionRowWidth + tolerance >= metrics.tableWidth &&
      Math.abs(metrics.additionRowRightGap) <= tolerance &&
      Math.abs(metrics.deletionRowRightGap) <= tolerance,
    "the semantic fill does not reach the end of the diff's scrollable width",
  );
  assert(metrics.codeText?.includes("use std::time::Instant;"), "the diff lost the code text");
  assert(metrics.codeInset !== null && metrics.codeInset <= 64, "the diff gutter remains too wide");
  assert(
    metrics.lineNumberCellsPerRow.length > 0 &&
      metrics.lineNumberCellsPerRow.every((count) => count === 1),
    "the unified diff does not preserve a single semantic number column",
  );
  assert(
    metrics.lineNumberLeftSpread !== null && metrics.lineNumberLeftSpread <= tolerance,
    "the diff's number column lost vertical alignment",
  );
  assert(
    metrics.lineNumberValues.every((value) => /^\d+$/u.test(value)),
    "the diff mixed edit markers with line numbers",
  );
  assert(
    metrics.lineNumberValues.some((value) => Number(value) >= 80),
    "the visual regression does not cover multi-digit line numbers",
  );
  assert(
    metrics.lineNumberContentOverflow.length > 0 &&
      metrics.lineNumberContentOverflow.every((overflow) => overflow <= tolerance),
    "the diff's numeric content is clipped",
  );
  assert(
    metrics.lineNumberContentContainment.every(
      (containment) =>
        containment !== null && containment.left >= -tolerance && containment.right >= -tolerance,
    ),
    "line numbers escape the gutter's semantic bounds",
  );
  assert(
    metrics.lineNumberWidths.length > 0 &&
      Math.min(...metrics.lineNumberWidths) >= 30 &&
      Math.max(...metrics.lineNumberWidths) - Math.min(...metrics.lineNumberWidths) <= tolerance,
    "the gutter does not maintain a stable intrinsic width",
  );
  assert(
    metrics.lineNumberBoxSizing === "border-box" &&
      Number.parseFloat(metrics.lineNumberPaddingLeft) > 0 &&
      Number.parseFloat(metrics.lineNumberPaddingRight) > 0 &&
      metrics.lineNumberDividerWidth === "0px" &&
      metrics.lineNumberBackground === metrics.additionBackground,
    "the gutter does not form a continuous strip with the changed line",
  );
  assert(
    metrics.changedIndicatorWidth === "4px" &&
      metrics.changedIndicatorPosition === "absolute",
    "the change indicator is not decoupled from the numeric width",
  );
  assert(
    metrics.diffRowHeights.length > 0 && metrics.diffRowHeights.every((height) => height === 20),
    "diff rows lost the canonical 20px vertical metric",
  );
  assert(
    metrics.diffRowTopOffsets.length > 1 &&
      metrics.diffRowTopOffsets.every(
        (top, index) => Math.abs(top - index * 20) <= tolerance,
      ) &&
      metrics.diffRowInlineTops.every((top, index) => top === `${index * 20}px`),
    "diff rows do not occupy consecutive vertical positions",
  );
  assert(
    metrics.diffCanvasHeight !== null &&
      metrics.diffCanvasHeight >= metrics.diffRowTopOffsets.length * 20 &&
      metrics.diffViewportHeight === metrics.diffViewportClientHeight &&
      metrics.diffViewportScrollHeight >= metrics.diffViewportClientHeight,
    "the diff's virtual canvas does not represent the document's scrollable geometry",
  );
  assert(metrics.viewportHorizontalOverflow > 0, "the regression did not exercise horizontal scrolling");
  assert(
    metrics.stickyGutterMovement !== null &&
      metrics.stickyGutterMovement <= tolerance &&
      metrics.stickyOffsetFromViewport !== null &&
      Math.abs(metrics.stickyOffsetFromViewport) <= tolerance,
    "the numeric gutter does not remain fixed during horizontal scrolling",
  );
  assert(metrics.markerCellCount === 0, "the diff retains redundant edit markers");
  assert(metrics.newlineMetadataRows === 0, "newline metadata still consumes visual rows");
  assert(
    metrics.structuralMetadataRows === 0 && metrics.containsStructuralMetadata === false,
    "structural patch metadata still consumes visual rows",
  );
}

function validateSyntaxHighlightedCreatedFileMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected syntax-highlighted created-file viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "the created file generated horizontal overflow");
  for (const kind of ["token-attribute", "token-keyword", "token-number", "token-type"]) {
    assert(metrics.tokenKinds.includes(kind), `the created file did not produce ${kind}`);
  }
  assert(metrics.tokenCount >= 20, "the created file produced too few syntax tokens");
  assert(metrics.tokenColorCount >= 4, "the created file does not use a sufficient syntax palette");
  assert(metrics.additionRows > 0, "the created file did not render added lines");
  assert(metrics.deletionRows === 0, "the created file invented deleted lines");
  assert(metrics.newlineMetadataRows === 0, "the created file displays redundant newline metadata");
  assert(
    metrics.structuralMetadataRows === 0 && metrics.containsStructuralMetadata === false,
    "the created file still displays redundant structural metadata",
  );
  assert(metrics.codeInset <= 64, "the created file retains an excessively wide gutter");
  assert(
    metrics.lineNumberCellsPerRow.length > 0 &&
      metrics.lineNumberCellsPerRow.every((count) => count === 1),
    "the created file does not preserve a single numeric column",
  );
  assert(metrics.markerCellCount === 0, "the created file retains redundant markers");
}

function validateHighlightedToolOutputMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected highlighted-output viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "typed outputs created global overflow");
  assert(
    JSON.stringify(metrics.sourceLineNumbers) ===
      JSON.stringify(["20", "21", "22", "23", "24", "25", "26", "27", "28", "29"]),
    "the file read lost its line numbers",
  );
  assert(metrics.sourceTokenKinds.includes("token-keyword"), "the file read did not highlight keywords");
  assert(metrics.sourceTokenKinds.includes("token-string"), "the file read did not highlight strings");
  assert(metrics.searchTokenKinds.includes("token-keyword"), "search did not highlight matched fragments");
  assert(metrics.sourceText.includes("const continuation"), "the file read lost the original code");
  assert(metrics.searchText.includes("src/ui/syntax/diffHighlighter.test.ts:20"), "search lost the location");
  assert(metrics.sourceHorizontalOverflow >= 0, "the file read lost its scrollable width");
  assert(metrics.searchHorizontalOverflow >= 0, "search lost its scrollable width");
  assert(
    metrics.sourceTableRole === "table" &&
      metrics.sourceRowGroupRole === "rowgroup" &&
      metrics.sourceRowRoles.every((role) => role === "row") &&
      metrics.sourceCellRoles.every(
        (roles) => JSON.stringify(roles) === JSON.stringify(["rowheader", "cell"]),
      ),
    "the file read lost its semantic grid independent of native tables",
  );
  assert(
    metrics.sourceMountedRowIndexes.length === 10 &&
      metrics.sourceMountedRowIndexes[0] === 1 &&
      metrics.sourceMountedRowIndexes.at(-1) === 10,
    "the file read did not materialize exactly the expected visible window",
  );
  assert(
    metrics.sourceRowGaps.length === 9 &&
      metrics.sourceRowGaps.every((gap) => Math.abs(gap - 22) <= tolerance),
    "file-read rows overlap or lost the 22px virtual step",
  );
  assert(
    metrics.sourceInlineOverlapCount === 0,
    "syntax fragments in the file read overlap on the same line",
  );
  assert(
    metrics.sourceCanvasHeight >= metrics.sourceViewportScrollHeight - tolerance &&
      metrics.sourceViewportClientHeight === 205,
    "the file-read canvas does not fully represent its virtual range",
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
    "virtual geometry changed while reopening or scrolling the file read under the production CSP",
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
    "the file read did not preserve start, end, and return to top during rematerialization",
  );
  assert(
    metrics.readTitle === "Leu arquivo diffHighlighter.test.ts",
    `the file read lost its execution semantics (${JSON.stringify(metrics.readTitle)})`,
  );
  assert(
    JSON.stringify(metrics.readIconPaths) === JSON.stringify([OFFICIAL_READ_ICON_PATH]),
    "the file read does not faithfully use the canonical open-book icon",
  );
  assert(
    Math.abs(metrics.readIconSize?.width - 16) <= tolerance &&
      Math.abs(metrics.readIconSize?.height - 16) <= tolerance,
    "the open book does not preserve the canonical 16x16 presentation",
  );
  assert(
    metrics.readIconViewBox === "0 0 20 20" &&
      metrics.readIconFill === "currentColor" &&
      metrics.readIconStroke === "none" &&
      metrics.readIconStrokeWidth === null &&
      metrics.readIconRtlFlip === true,
    "the open book does not preserve the canonical filled presentation",
  );
  assert(
    Math.abs(metrics.readChevronSize?.width - 14) <= tolerance &&
      Math.abs(metrics.readChevronSize?.height - 14) <= tolerance,
    "the file-read chevron does not use the canonical 14x14 presentation",
  );
  assert(
    metrics.readChevronPath === "m9 18 6-6-6-6" &&
      metrics.readChevronOpacity === 1 &&
      /^matrix\(0, 1, -1, 0, 0, 0\)$/u.test(metrics.readChevronTransform ?? ""),
    "the expanded file-read chevron does not remain pointed downward",
  );
  validateIntrinsicActivityInteraction(metrics.readInteraction, "file read", tolerance);
}

function validateComposerPopoverLayeringMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected composer-layer viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "the panels created horizontal overflow");
  assert(
    metrics.chatPageDisplay === "block" &&
      metrics.timelinePosition === "absolute" &&
      metrics.dockPosition === "absolute",
    "the timeline no longer occupies the full window beneath the measured dock",
  );
  assert(metrics.composerIsolation === "isolate", "the composer has no layer isolation");
  assert(
    Number(metrics.dockLayer) > metrics.composerLayer &&
      metrics.composerLayer > metrics.statusLayer,
    "the semantic hierarchy of dock, composer, and status is inverted",
  );
  assert(
    Math.abs(metrics.timelineBounds.top - metrics.chatPageBounds.top) <= tolerance &&
      Math.abs(metrics.timelineBounds.bottom - metrics.chatPageBounds.bottom) <= tolerance &&
      Math.abs(metrics.timelineViewportBounds.top - metrics.chatPageBounds.top) <= tolerance &&
      Math.abs(metrics.timelineViewportBounds.bottom - metrics.chatPageBounds.bottom) <= tolerance,
    "the scrollable viewport does not reach both vertical bounds of the chat page",
  );
  assert(
    Math.abs(metrics.timelineDockOverlap - metrics.dockBounds.height) <= tolerance &&
      Math.abs(metrics.timelineDockGap + metrics.dockBounds.height) <= tolerance,
    "the dock does not overlay the full-screen viewport",
  );
  assert(
    Math.abs(metrics.scrollbarBounds.top - metrics.chatPageBounds.top) <= tolerance &&
      Math.abs(metrics.scrollbarBounds.bottom - metrics.chatPageBounds.bottom) <= tolerance &&
      Math.abs(metrics.scrollbarBottomGap) <= tolerance,
    "the scrollbar's lower arrow does not reach the window footer",
  );
  assert(
    Math.abs(metrics.chatDockHeight - Math.ceil(metrics.dockBounds.height)) <= tolerance &&
      metrics.timelineBottomPadding + tolerance >= metrics.chatDockHeight + 32 &&
      metrics.timelineAtEnd <= tolerance &&
      metrics.lastTimelineItemDockGap >= 31,
    "the full-screen dock is hiding the conversation's final item again",
  );
  assert(
    Number(metrics.popoverLayer) === metrics.permissionMenuLayer &&
      metrics.permissionMenuLayer > metrics.composerLayer,
    "local panels do not have priority over composer content",
  );
  assert(metrics.permissionMenuOpen === true, "the permission panel did not remain open");
  assert(metrics.menus.length === 3, "not all composer panels were audited");
  for (const menu of metrics.menus) {
    assert(
      menu.menuBounds.left >= -tolerance &&
        menu.menuBounds.right <= viewport.width + tolerance &&
        menu.menuBounds.top >= -tolerance &&
        menu.menuBounds.bottom <= viewport.height + tolerance,
      `the ${menu.name} panel exceeded the viewport`,
    );
    if (menu.overlapWidth > tolerance && menu.overlapHeight > tolerance) {
      assert(
        menu.paintedInFront.length === 6 && menu.paintedInFront.every(Boolean),
        `the ${menu.name} panel was painted behind the change summary`,
      );
    }
  }
  for (const requiredOverlap of ["add", "permission"]) {
    const menu = metrics.menus.find((candidate) => candidate.name === requiredOverlap);
    assert(
      menu?.overlapWidth > tolerance && menu.overlapHeight > tolerance,
      `the scenario did not exercise overlap for the ${requiredOverlap} panel`,
    );
  }
  assert(
    metrics.permissionMenuBounds.left >= -tolerance &&
      metrics.permissionMenuBounds.right <= viewport.width + tolerance &&
      metrics.permissionMenuBounds.top >= -tolerance &&
      metrics.permissionMenuBounds.bottom <= viewport.height + tolerance,
    "the final permission panel exceeded the viewport",
  );
  assert(
    Math.abs(metrics.commandIconSize?.width - 16) <= tolerance &&
      Math.abs(metrics.commandIconSize?.height - 16) <= tolerance &&
      metrics.commandIconViewBox === "0 0 24 24",
    "the command icon lost its compact 16x16 presentation",
  );
  assert(
    JSON.stringify(metrics.commandFrame) ===
      JSON.stringify({ height: "16", rx: "2.25", width: "20", x: "2", y: "4" }) &&
      JSON.stringify(metrics.commandIconPaths) ===
        JSON.stringify(["m7 9 3 3-3 3", "M13 15h4"]),
    "the command icon does not preserve its horizontal frame and internal spacing",
  );
}

function validateProjectOpenWorkspaceMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected open-project viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "opening the project created horizontal overflow");
  assert(
    /[\\/]codex-app$/u.test(metrics.openedWorkspace ?? ""),
    "the action did not forward the persisted project path",
  );
  assert(metrics.dialogOpen === false, "the action opened an unexpected picker or dialog");
  assert(metrics.projectEditorOpen === false, "the action opened the project editor");
}

function validateProjectColorEditorMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(metrics.horizontalOverflow <= tolerance, "the project editor created horizontal overflow");
  assert(metrics.verticalOverflow <= tolerance, "the project editor created vertical overflow");
  assert(metrics.dialogCount === 1, "the project editor does not expose exactly one dialog");
  assert(metrics.container.left >= 0, "the project editor exceeds the left edge");
  assert(
    metrics.container.right <= viewport.width + tolerance,
    "the project editor exceeds the right edge",
  );
  assert(metrics.modal.right <= metrics.colorPanel.left, "the editor panels overlap");
  assert(metrics.colorPanel.width >= 200, "the color panel became too narrow");
  assert(metrics.picker.width <= metrics.colorPanel.width, "the picker exceeds the color panel");
  assert(metrics.hueBar.height >= 14, "the hue strip became too short");
  assert(/^[0-9A-F]{6}$/u.test(metrics.hexValue ?? ""), "the HEX field no longer uses #RRGGBB");
  const expectedPreviewColor = `rgb(${Number.parseInt(metrics.hexValue.slice(0, 2), 16)}, ${Number.parseInt(metrics.hexValue.slice(2, 4), 16)}, ${Number.parseInt(metrics.hexValue.slice(4, 6), 16)})`;
  assert(
    metrics.previewColor === expectedPreviewColor,
    `icon (${metrics.previewColor}) and HEX field (${expectedPreviewColor}) diverged`,
  );
  assert(metrics.badgeText === `#${metrics.hexValue}`, "badge and HEX field diverged");
  assert(/^rgb\(255, 0, \d+\)$/u.test(metrics.boxColor ?? ""), "the HSV square did not reach the final red hue");
  assert(
    metrics.hueCursorRightGap !== null && Math.abs(metrics.hueCursorRightGap) <= tolerance,
    "the hue cursor did not remain at the end of the strip",
  );
}

function validateSettingsMetrics(metrics, viewport) {
  const tolerance = 1;
  validateChromeMetrics(metrics, viewport);
  assert(metrics.chromeOverlapsSettings === true, "window chrome does not overlay settings");
  assert(metrics.chromeText === "", "window chrome still displays a textual title");
  assert(
    Math.abs(metrics.navigation.top - metrics.content.top) <= tolerance,
    "the settings navigation surface does not reach the top",
  );
  assert(
    Math.abs(metrics.main.top - metrics.content.top) <= tolerance,
    "the main settings surface does not reach the top",
  );
  assert(metrics.back.top >= metrics.chrome.bottom, "the back action intrudes into the drag region");
  assert(metrics.heading.top >= metrics.chrome.bottom, "the settings title intrudes into window chrome");
  assert(
    Math.abs(metrics.scrollbar.top - metrics.chrome.bottom) <= tolerance,
    "the settings scrollbar does not begin below window chrome",
  );
  assert(
    Math.abs(metrics.scrollbar.right - viewport.width) <= tolerance &&
      Math.abs(metrics.scrollbar.width - 18) <= tolerance,
    "the settings scrollbar does not follow the main-screen geometry",
  );
  assert(metrics.scrollbarThumb.width >= 12, "the settings scrollbar thumb became too narrow");
  assert(metrics.nativeScrollbarWidth === "none", "the native scrollbar remains visible");
  assert(metrics.horizontalOverflow <= tolerance, "the page has horizontal overflow");
  assert(metrics.navigation.width >= 248, "settings navigation became too narrow");
  assert(metrics.main.width >= 600, "the main settings panel became too narrow");
  assert(metrics.page.width >= 500, "settings content became excessively narrow");
  assert(Number.parseFloat(metrics.heading.fontSize) >= 21, "the title became too small");
  assert(Number.parseFloat(metrics.firstRowLabel.fontSize) >= 11, "labels became too small");
  assert(
    metrics.languageSelectFieldSizing === "content",
    `the language selector lost content-driven sizing: ${metrics.languageSelectFieldSizing}`,
  );
  assert(
    metrics.selectedLanguageLabel.length > 0 &&
      metrics.languageSelectLabelClearance >= 12 - tolerance,
    `the selected language label is clipped: ${JSON.stringify({
      availableWidth: metrics.languageSelectTextWidth,
      indicatorClearance: metrics.languageSelectLabelClearance,
      label: metrics.selectedLanguageLabel,
      labelWidth: metrics.selectedLanguageLabelWidth,
      selectWidth: metrics.languageSelect.width,
    })}`,
  );
  assert(metrics.checkboxCount === 3, "the three boolean controls were not rendered");
  assert(metrics.visibleCards >= 2, "fewer than two settings cards are visible");
  assert(
    !metrics.navigationLabels.includes("Aparência") &&
      !metrics.navigationLabels.includes("Segurança e permissões"),
    "navigation still exposes removed pages",
  );
  assert(metrics.navigationLabels.includes("Perfil"), "the Profile page left settings");
  assert(
    metrics.navigationItemGaps.length > 0 &&
      metrics.navigationItemGaps.every((gap) => gap !== null && gap >= 3.5),
    `settings items remain visually crowded: ${JSON.stringify(metrics.navigationItemGaps)}`,
  );
  const surfaceAlpha = (value) =>
    Number.parseFloat(value.match(/\/\s*([\d.]+)%/u)?.[1] ?? "0");
  assert(
    surfaceAlpha(metrics.selectedSurface) >= surfaceAlpha(metrics.hoverSurface) * 2,
    `hover and selection remain too similar: ${metrics.hoverSurface} / ${metrics.selectedSurface}`,
  );
  assert(
    metrics.selectedNavigationBackground === "rgba(255, 255, 255, 0.12)",
    `settings selection does not use the strong surface: ${metrics.selectedNavigationBackground}`,
  );
  assert(
    metrics.selectedNavigationBoxShadow !== null && metrics.selectedNavigationBoxShadow !== "none",
    "settings selection lost its separating outline",
  );
}

function validateUsageSettingsMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(metrics.horizontalOverflow <= tolerance, "Usage and billing created horizontal overflow");
  assert(
    metrics.pageHorizontalOverflow !== null && metrics.pageHorizontalOverflow <= tolerance,
    "Usage and billing content created internal horizontal overflow",
  );
  assert(metrics.page.width >= 500, "the Usage and billing page became too narrow");
  assert(metrics.plan.right <= viewport.width + tolerance, "the plan card exceeds the screen");
  assert(
    metrics.autoTopUp.right <= viewport.width + tolerance,
    "automatic top-up exceeds the screen",
  );
  assert(metrics.reset.right <= viewport.width + tolerance, "the reset section exceeds the screen");
  assert(metrics.cardCount >= 5, "functional Usage and billing sections are missing");
  assert(metrics.meterCount >= 4, "general or GPT-5.3-Codex-Spark limits are missing");
  assert(metrics.planText.includes("R$ 525,00/mês"), "the localized monthly price was not displayed");
  assert(
    metrics.autoTopUpText.includes("Até 40% de desconto"),
    "the automatic top-up offer was not displayed",
  );
  assert(metrics.switchAriaChecked === "false", "the top-up switch does not reflect its initial state");
  assert(
    metrics.resetButtonText === "Usar redefinição",
    "the use-reset action was not rendered",
  );
  assert(metrics.resetText.includes("Redefinição completa"), "the reset title was not displayed");
  assert(
    metrics.sectionHeadings.includes("Limites gerais de uso") &&
      metrics.sectionHeadings.includes("Limites de uso do GPT-5.3-Codex-Spark") &&
      metrics.sectionHeadings.includes("Redefinições do limite de uso"),
    "the canonical limits and resets structure is incomplete",
  );
}

function validateUsageSettingsInteractionMetrics(metrics) {
  const tolerance = 1;
  assert(
    metrics.horizontalOverflow <= tolerance,
    "Usage and billing interaction created horizontal overflow",
  );
  assert(metrics.resetRows === 0, "the consumed reset remained available");
  assert(
    metrics.successText === "Limites de uso redefinidos.",
    "reset success was not announced",
  );
  assert(metrics.switchAriaChecked === "true", "automatic top-up was not enabled");
  assert(
    metrics.autoTopUpText.includes("Recarrega para 250 créditos"),
    "the active automatic top-up configuration was not reflected",
  );
}

function validateOutputDetailMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(metrics.horizontalOverflow <= tolerance, "the menu created global horizontal overflow");
  assert(metrics.cardAllowsOverflow === true, "the card still clips the detail menu");
  assert(metrics.optionCount === 4, "the four detail options were not rendered");
  assert(
    metrics.visibleOptionCount === metrics.optionCount,
    "one or more detail options remain visually clipped",
  );
  assert(metrics.menu.left >= -tolerance, "the menu exceeds the left edge");
  assert(metrics.menu.right <= viewport.width + tolerance, "the menu exceeds the right edge");
  assert(metrics.menu.top >= 34 - tolerance, "the menu intrudes into the title bar");
  assert(metrics.menu.bottom <= viewport.height + tolerance, "the menu exceeds the viewport");
}

function validateSettingsInteractionMetrics(metrics) {
  const tolerance = 1;
  assert(metrics.disabledControls === 0, "saving disabled independent controls");
  assert(metrics.modelSectionShift !== null, "page stability could not be measured");
  assert(metrics.modelSectionShift <= tolerance, "saving displaced page content");
  assert(metrics.savingAnnounced === true, "saving was not announced accessibly");
  assert(metrics.thirdPreferenceChecked === false, "the preference was not updated immediately");
  assert(metrics.visibleStatus === false, "saving displayed a status that displaced the page");
}

function validateProfileMetrics(metrics, viewport) {
  const tolerance = 1;
  validateChromeMetrics(metrics, viewport);
  assert(metrics.chromeOverlapsSettings === true, "window chrome does not overlay settings");
  assert(metrics.horizontalOverflow <= tolerance, "profile created global horizontal overflow");
  assert(
    metrics.settingsHorizontalOverflow <= tolerance,
    "the settings panel has horizontal overflow",
  );
  assert(
    metrics.surfaceHorizontalOverflow <= tolerance,
    "the profile surface has horizontal overflow",
  );
  assert(
    Math.abs(metrics.navigation.top - metrics.content.top) <= tolerance,
    "settings navigation does not reach the top",
  );
  assert(
    Math.abs(metrics.main.top - metrics.content.top) <= tolerance,
    "the settings panel does not reach the top",
  );
  assert(
    metrics.heading.top >= metrics.chrome.bottom,
    "the profile title intrudes into the window-chrome area",
  );
  assert(
    metrics.surface.top > metrics.heading.bottom,
    "profile content overlaps the settings header",
  );
  assert(metrics.page.width <= 821, "the profile page exceeded 820px");
  assert(
    metrics.profileContent.width <= metrics.page.width,
    "profile content exceeds the settings page",
  );
  assert(metrics.centeredInsetDifference <= 3, "profile content is not centered");
  assert(Math.abs(metrics.avatar.width - 80) <= tolerance, "the profile avatar is not 80px wide");
  assert(Math.abs(metrics.avatar.height - 80) <= tolerance, "the profile avatar is not 80px high");
  assert(metrics.profileAvatarImages === 1, "the avatar image does not appear on the profile page");
  assert(metrics.summary.height >= 60, "the profile summary became too short");
  assert(metrics.summaryStats === 5, "the summary does not contain the five canonical metrics");
  assert(metrics.activityCells === 364, "the calendar does not contain 52 complete weeks");
  assert(metrics.activeCells >= 60, "preview activity became visually empty");
  assert(
    metrics.futureCells === metrics.expectedFutureCells,
    "future days in the final week were not isolated",
  );
  assert(metrics.monthLabels >= 10, "calendar month labels are incomplete");
  assert(metrics.activityTabs === 3, "the three activity aggregations are missing");
  assert(metrics.selectedActivityTabs === 1, "the active aggregation is not unique");
  assert(metrics.insightRows === 5, "the five canonical insights were not rendered");
  assert(metrics.invocationRows === 1, "the preview's most-used plugin is missing");
  assert(
    metrics.selectedProfileNavigation === 1,
    "Settings does not mark Profile as the active page",
  );
  assert(metrics.planBadge === "Pro", "the profile plan badge is incorrect");
  assert(metrics.loadingStates === 0, "the profile remained in a loading or error state");
  assert(metrics.activity.top > metrics.summary.bottom, "the chart overlaps the summary");
  assert(metrics.insights.top > metrics.activityGrid.bottom, "insights overlap the calendar");
}

function validateAutomationsMetrics(metrics, viewport) {
  const tolerance = 1;
  validateChromeMetrics(metrics, viewport);
  assert(metrics.horizontalOverflow <= tolerance, "Automations has global horizontal overflow");
  assert(
    metrics.surfaceHorizontalOverflow <= tolerance,
    "the Automations surface has horizontal overflow",
  );
  assert(
    Math.abs(metrics.surface.top - metrics.chrome.bottom) <= tolerance,
    "Automations does not begin immediately below window chrome",
  );
  assert(
    Math.abs(metrics.sidebar.top - metrics.content.top) <= tolerance &&
      Math.abs(metrics.sidebar.bottom - metrics.content.bottom) <= tolerance,
    "the sidebar surface does not occupy the application's full height",
  );
  assert(
    metrics.primaryNavigation.top >= metrics.chrome.bottom,
    "sidebar navigation intrudes into the drag region",
  );
  assert(
    metrics.sidebarBrand.top >= metrics.chrome.bottom &&
      metrics.sidebarBrand.top - metrics.chrome.bottom <= 6 + tolerance,
    "the Codex brand is not aligned near window chrome",
  );
  assert(
    Math.abs(metrics.sidebarTitlebar.bottom - metrics.primaryNavigation.top) <= tolerance,
    "the sidebar navigation's top spacing became inconsistent",
  );
  assert(metrics.surface.width > 500, "the Automations surface became too narrow");
  assert(metrics.header.width <= metrics.surface.width, "the header exceeds the surface");
  assert(metrics.notice.width <= metrics.surface.width, "the local notice exceeds the surface");
  assert(metrics.card.left >= metrics.surface.left, "the card exceeds the left edge");
  assert(metrics.card.right <= metrics.surface.right + tolerance, "the card exceeds the right edge");
  assert(Number.parseFloat(metrics.heading.fontSize) >= 21, "the Automations title became too small");
  assert(metrics.activeNavigationItems === 1, "navigation does not mark Automations as active");
  assert(metrics.unreadBadges === 1, "the unreviewed-results badge was not rendered");
  assert(metrics.automationCards >= 1, "no Automation card was rendered");
  assert(metrics.runRows >= 2, "queue and history did not render the runs");
  assert(metrics.primaryButtons === 1, "the primary new-Automation button is missing");
  assert(metrics.sidebarDividerWidth === "1px", "the sidebar divider lost its standard thickness");
  assert(
    metrics.sidebarDividerColor === "rgba(255, 255, 255, 0.04)",
    "the sidebar divider is brighter than the other subtle separators",
  );
}

function validateAutomationEditorMetrics(metrics, viewport) {
  const tolerance = 1;
  validateChromeMetrics(metrics, viewport);
  assert(metrics.horizontalOverflow <= tolerance, "the editor has global horizontal overflow");
  assert(
    metrics.editorHorizontalOverflow <= tolerance,
    "editor content has horizontal overflow",
  );
  assert(
    Math.abs(metrics.backdrop.top - metrics.chrome.bottom) <= tolerance,
    "the editor backdrop does not follow the start of the content surface",
  );
  assert(metrics.editor.top >= metrics.chrome.bottom, "the editor is positioned above the content");
  assert(metrics.editor.bottom <= viewport.height + tolerance, "the editor exceeds the viewport");
  assert(metrics.editor.width >= 500, "the editor became excessively narrow");
  assert(Number.parseFloat(metrics.heading.fontSize) >= 17, "the editor title became too small");
  assert(metrics.prompt.height >= 150, "the instruction field became too short");
  assert(metrics.dialogCount === 1, "the editor does not expose exactly one modal dialog");
  assert(metrics.namedFields >= 6, "essential editor fields were not rendered");
  assert(metrics.footerButtons === 2, "cancel and save actions were not rendered");
  assert(metrics.switchAriaChecked === "true", "the initial switch does not expose aria-checked");
}

function validateBrowserPanelMetrics(metrics, viewport) {
  const tolerance = 1;
  validateWorkspaceSplitMetrics(
    metrics.workspaceSplit,
    "browser",
    metrics.workspaceSplitInteraction,
  );
  assert(metrics.horizontalOverflow <= tolerance, "the browser created global horizontal overflow");
  assert(metrics.workspace.top >= 34 - tolerance, "the workspace intruded into window chrome");
  assert(
    metrics.workspace.right <= viewport.width + tolerance &&
      metrics.workspace.bottom <= viewport.height + tolerance,
    "the workspace exceeded the viewport",
  );
  assert(metrics.panel.right <= viewport.width + tolerance, "the browser exceeded the right edge");
  assert(metrics.panel.bottom <= viewport.height + tolerance, "the browser exceeded the usable height");
  assert(metrics.panel.width >= 420, "the browser became too narrow");
  assert(
    Math.abs(metrics.surface.right - metrics.panel.right) <= tolerance &&
      metrics.surface.left >= metrics.panel.left &&
      metrics.surface.left - metrics.panel.left <= tolerance,
    `the native surface (${metrics.surface.left}–${metrics.surface.right}) does not follow the panel (${metrics.panel.left}–${metrics.panel.right})`,
  );
  assert(metrics.surface.height >= 180, "the native surface became too short");
  assert(metrics.tabs.bottom <= metrics.toolbar.top + tolerance, "tabs overlap the address bar");
  assert(metrics.toolbar.bottom <= metrics.surface.top + tolerance, "the toolbar overlaps web content");
  assert(metrics.address.width >= 180, "the address bar became too narrow");
  assert(metrics.tabCount >= 1, "the browser did not create its initial tab");
  assert(metrics.selectedTabs === 1, "the browser does not have exactly one active tab");
  assert(metrics.navigationButtons === 6, "navigation or viewport controls are missing from the toolbar");
  assert(metrics.addressInputs === 1, "the address bar does not contain exactly one field");
  assert(metrics.previewPages === 1, "the preview does not expose the native-webview substitute surface");
}

function validateWorkspaceSplitMetrics(metrics, label, interaction = null) {
  const tolerance = 1;
  assert(metrics.chatHidden === false, `chat was unmounted when opening ${label}`);
  assert(
    metrics.role === "separator" && metrics.ariaOrientation === "vertical",
    `the ${label} divider does not expose accessible vertical semantics`,
  );
  assert(
    metrics.ariaMinimum <= metrics.ariaNow && metrics.ariaNow <= metrics.ariaMaximum,
    `the accessible value of the ${label} divider is out of bounds`,
  );
  assert(
    metrics.ariaText?.includes("Chat") && metrics.ariaText.includes("área de trabalho"),
    `the ${label} divider does not describe both proportions`,
  );
  if (metrics.splitterDisplay === "none") {
    assert(metrics.chatDisplay === "none", `the narrow ${label} fallback left chat squeezed`);
    assert(
      Math.abs(metrics.workspace.left - metrics.container.left) <= tolerance &&
        Math.abs(metrics.workspace.right - metrics.container.right) <= tolerance,
      `the narrow ${label} fallback does not use all available area`,
    );
    assert(
      interaction === null || interaction.supported === false,
      `the test attempted to drag the hidden ${label} divider`,
    );
    return;
  }
  assert(metrics.chatDisplay !== "none", `chat did not remain visible beside ${label}`);
  assert(
    Math.abs(metrics.chat.left - metrics.container.left) <= tolerance &&
      Math.abs(metrics.chat.right - metrics.splitter.left) <= tolerance &&
      Math.abs(metrics.workspace.left - metrics.splitter.right) <= tolerance &&
      Math.abs(metrics.workspace.right - metrics.container.right) <= tolerance,
    `chat, divider, and ${label} do not fill the side-by-side area`,
  );
  assert(
    Math.abs(metrics.splitter.width - 8) <= tolerance,
    `the ${label} drag target did not preserve 8px`,
  );
  assert(
    metrics.chat.width >= 420 - tolerance && metrics.workspace.width >= 420 - tolerance,
    `resizing ${label} violated the panels' minimum width`,
  );
  if (interaction === null) {
    assert(
      Math.abs(metrics.chat.width - metrics.workspace.width) <= tolerance,
      `${label} did not initially open in a 50/50 split`,
    );
    return;
  }
  assert(interaction.supported === true, `${label} dragging was not exercised`);
  assert(
    Math.abs(interaction.initial.chat.width - interaction.initial.workspace.width) <= tolerance,
    `${label} did not start at 50/50 before dragging`,
  );
  assert(
    interaction.dragged.chat.width >= interaction.initial.chat.width + 40 &&
      interaction.dragged.workspace.width <= interaction.initial.workspace.width - 40,
    `dragging the ${label} divider did not redistribute space between panels`,
  );
  assert(
    Math.abs(metrics.chat.width - interaction.dragged.chat.width) <= tolerance &&
      Math.abs(metrics.workspace.width - interaction.dragged.workspace.width) <= tolerance,
    `the ${label} split did not remain at the mouse-selected position`,
  );
  const persistedRatio = Number(interaction.dragged.persistedRatio);
  assert(
    Number.isFinite(persistedRatio) &&
      interaction.dragged.paneRatio !== null &&
      Math.abs(persistedRatio - interaction.dragged.paneRatio) <= 0.01,
    `the selected ${label} proportion was not persisted`,
  );
}

function validateBrowserResponsiveMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected outer viewport in responsive mode at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "responsive mode created global overflow");
  assert(metrics.toolbarOverflow <= tolerance, "responsive controls do not fit in the toolbar");
  assert(metrics.width === "7680", "8K width was not applied");
  assert(metrics.height === "4320", "8K height was not applied");
  assert(metrics.scale === "0.25", "25% scale was not applied");
  assert(metrics.preview === "7680 × 4320 · 25%", "the surface did not reflect the 8K viewport");
  assert(metrics.selectedTabs === 1, "responsive mode lost the active tab");
  assert(
    metrics.toolbar.left >= metrics.workspace.left - tolerance &&
      metrics.toolbar.right <= metrics.workspace.right + tolerance,
    "the responsive toolbar left the workspace",
  );
  assert(metrics.toolbar.bottom <= metrics.surface.top + tolerance, "the responsive toolbar overlaps content");
  assert(metrics.surface.height > 0, "responsive mode eliminated the browser surface");
  assert(
    metrics.resetLabel === "Redefinir viewport responsivo",
    "the responsive reset has no accessible name",
  );
}

function validateBrowserDebugMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(metrics.horizontalOverflow <= tolerance, "diagnostics created global horizontal overflow");
  assert(
    metrics.debugHorizontalOverflow <= tolerance,
    "diagnostic content created horizontal overflow",
  );
  assert(metrics.panel.right <= viewport.width + tolerance, "the diagnostic panel left the viewport");
  assert(
    metrics.debug.left >= metrics.panel.left - tolerance &&
      metrics.debug.right <= metrics.panel.right + tolerance,
    "diagnostics do not follow the browser width",
  );
  assert(metrics.debug.bottom <= metrics.surface.top + tolerance, "diagnostics overlap the webview");
  assert(metrics.surface.height >= 180, "opening diagnostics reduced the native surface too much");
  assert(metrics.summaryCards === 4, "the diagnostic summary does not contain four metrics");
  assert(metrics.historyRows >= 3, "diagnostic history did not render the samples");
  assert(metrics.failedRows >= 1, "diagnostics do not distinguish failures");
  assert(metrics.stageBadges === 5, "latency stages were not rendered");
  assert(metrics.findingBadges >= 6, "quality findings were not rendered");
}

function validateBrowserPanelLifecycleMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected browser-lifecycle viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.panelCount === 0, "the browser panel remained mounted after closing");
  assert(metrics.failureCount === 0, "closing the browser produced a render failure");
  assert(metrics.chatVisible === true, "chat did not return after closing the browser");
  assert(metrics.horizontalOverflow <= tolerance, "closing the browser created horizontal overflow");
}

function validateImageViewGroupMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected image-group viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "the image group created overflow");
  assert(metrics.label === "Visualizou 2 imagens", "image-group pluralization is incorrect");
  assert(metrics.open === true, "the image group did not remain expanded");
  assert(metrics.imageCount === 2, "the group did not render both images");
  assert(metrics.previewButtons === 2, "the thumbnails are not two clickable actions");
  assert(metrics.uniqueSources === 2, "thumbnails were incorrectly deduplicated");
  assert(metrics.rawDataUrlText === false, "the raw data URL still appears as text");
}

function validateTimelinePerformanceStressMetrics(metrics, viewport) {
  const tolerance = 1;
  const exceptionalApplicationCallbacks = metrics.rapidAnimationCallbackOutliers.filter(
    (outlier) => outlier.duration > 10,
  );
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected timeline-stress viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.visitedItems === 180, "the stress test did not open all 180 activities");
  assert(metrics.expansionIterations < 1200, "virtualized expansion did not converge");
  assert(metrics.expansionMs <= 20_000, "virtualized expansion exceeded 20 seconds");
  assert(metrics.rapidFrames >= 60, "the rapid test collected too few frames");
  assert(
    metrics.visibleDeferredBodyFrames === 0 && metrics.maximumVisibleDeferredBodies === 0,
    `rapid scrolling displayed empty bodies in ${metrics.visibleDeferredBodyFrames} frames (maximum ${metrics.maximumVisibleDeferredBodies})`,
  );
  assert(
    metrics.missingSummaryFrames === 0,
    "rapid scrolling removed real summaries from mounted activities",
  );
  assert(
    metrics.visibleEmptyActivityListFrames === 0 &&
      metrics.maximumVisibleEmptyActivityLists === 0,
    `the timeline left visible lists empty in ${metrics.visibleEmptyActivityListFrames} frames: ${JSON.stringify(metrics.visibleEmptyActivityListSamples)}`,
  );
  assert(
    metrics.summaryIdentityProbeComparisons > 0,
    "the controlled probe did not retain summaries between consecutive samples",
  );
  assert(
    metrics.summaryIdentityProbeChanges === 0,
    `the controlled probe replaced ${metrics.summaryIdentityProbeChanges} retained summaries`,
  );
  assert(
    metrics.rapidSummaryIdentityChanges === 0,
    `rapid scrolling replaced ${metrics.rapidSummaryIdentityChanges} summaries that remained mounted`,
  );
  assert(
    metrics.iconIntegrityComparisons > 0 &&
      metrics.iconIntegrityKinds.includes("read") &&
      metrics.iconIntegrityKinds.includes("search"),
    "the test did not recycle read and search icons through the same virtual slot",
  );
  assert(
    metrics.iconIntegrityFailures === 0,
    `recycling deformed ${metrics.iconIntegrityFailures} icons: ${JSON.stringify(metrics.iconIntegritySamples)}`,
  );
  assert(
    metrics.legacyPlaceholderFrames === 0,
    "rapid scrolling restored legacy loading placeholders",
  );
  assert(
    metrics.rapidAnimationWorkFrames >= metrics.rapidFrames,
    "instrumentation did not cover every rapid-scroll frame",
  );
  assert(
    metrics.rapidP95ApplicationAnimationWorkMs <= 10,
    `P95 application work was ${metrics.rapidP95ApplicationAnimationWorkMs.toFixed(2)} ms`,
  );
  assert(
    metrics.rapidP99AnimationWorkMs <= 20,
    `total P99 work was ${metrics.rapidP99AnimationWorkMs.toFixed(2)} ms`,
  );
  assert(
    metrics.rapidP99ApplicationAnimationWorkMs <= 10,
    `P99 application work was ${metrics.rapidP99ApplicationAnimationWorkMs.toFixed(2)} ms`,
  );
  assert(
    metrics.rapidMaximumApplicationAnimationWorkMs <= 12 &&
      exceptionalApplicationCallbacks.length <= 1,
    `exceptional application work exceeded the contract: maximum ${metrics.rapidMaximumApplicationAnimationWorkMs.toFixed(2)} ms across ${exceptionalApplicationCallbacks.length} callbacks`,
  );
  assert(
    metrics.rapidP95FrameMs <= 25,
    `rapid-scroll P95 was ${metrics.rapidP95FrameMs.toFixed(2)} ms`,
  );
  assert(
    metrics.rapidP99FrameMs <= 34,
    `rapid-scroll P99 was ${metrics.rapidP99FrameMs.toFixed(2)} ms across ${metrics.rapidFrames} frames (${metrics.rapidFramesOver34Ms} above 34 ms, ${metrics.rapidLongTasks} long tasks, maximum ${metrics.rapidMaximumFrameMs.toFixed(2)} ms)`,
  );
  assert(
    metrics.rapidMaximumFrameMs <= 50,
    `rapid-scroll maximum was ${metrics.rapidMaximumFrameMs.toFixed(2)} ms`,
  );
  assert(
    metrics.rapidFramesOver34Ms <= 1,
    `rapid scrolling had ${metrics.rapidFramesOver34Ms} frames above 34 ms (P95 ${metrics.rapidP95FrameMs.toFixed(2)} ms, P99 ${metrics.rapidP99FrameMs.toFixed(2)} ms, maximum ${metrics.rapidMaximumFrameMs.toFixed(2)} ms)`,
  );
  assert(metrics.rapidLongTasks === 0, "rapid scrolling produced long tasks");
  assert(metrics.reopenMs <= 1_200, "reopening the expanded chat exceeded 1.2 seconds");
  assert(metrics.visualDriftPx !== null, "the scenario found no measurable internal anchor");
  assert(Math.abs(metrics.visualDriftPx) <= tolerance, "the internal anchor changed visual position");
  assert(metrics.domNodes <= 7_000, "the virtualized timeline exceeded 7,000 DOM nodes");
  assert(
    metrics.mountedActivityItems <= 80,
    `${metrics.mountedActivityItems} activities remained mounted`,
  );
  assert(metrics.mountedSourceRows <= 800, "too many tool rows remained mounted");
  assert(metrics.mountedDiffRows <= 500, "too many diff rows remained mounted");
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
    `diff canvases lost rows or geometry after recycling: ${JSON.stringify(metrics.diffViewportIntegrity)}`,
  );
  assert(
    metrics.settledDeferredBodies === 0,
    "deferred bodies remained after scrolling settled",
  );
  assert(
    metrics.settledLegacyPlaceholders === 0,
    "legacy placeholders remained after scrolling settled",
  );
  assert(metrics.horizontalOverflow <= tolerance, "the stress test created horizontal overflow");
}

function validateActivityReconciliationMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected reconciliation viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.state === "completed", "parallel reconciliation did not complete");
  assert(metrics.started === 64, `only ${metrics.started} commands were started`);
  assert(metrics.completed === 64, `only ${metrics.completed} commands completed`);
  assert(metrics.commentaryState === "emitted", "the newest commentary was not emitted");
  assert(metrics.commentaryCount === 1, "the newest commentary was lost or duplicated");
  assert(
    metrics.startedPresentation?.completedAtCapture === 0,
    "the first command appeared only after a completion",
  );
  assert(
    metrics.startedPresentation?.title?.startsWith("Comando em execução"),
    `item.started did not appear immediately with semantic state: ${JSON.stringify(metrics.startedPresentation)}`,
  );
  assert(
    !metrics.startedPresentation?.title?.includes("pnpm exec benchmark"),
    "item.started revealed the command before terminal state",
  );
  assert(
    metrics.causalOrderPreserved === true,
    "an older command update reappeared after the newest commentary",
  );
  assert(metrics.turnFailures === 0, "out-of-order completion broke turn rendering");
  assert(metrics.totalActivities === 64, "the projection lost commands completed out of order");
  assert(metrics.identityComparisons > 0, "no retained slot was compared during streaming");
  assert(
    metrics.identityChanges === 0,
    `${metrics.identityChanges} retained activities recreated the DOM container`,
  );
  assert(
    metrics.mountedActivities === metrics.uniqueMountedActivities,
    "the mounted window contains duplicate keys",
  );
  assert(metrics.durationMs < 10_000, "parallel reconciliation exceeded 10 seconds");
  assert(metrics.horizontalOverflow <= tolerance, "reconciliation created horizontal overflow");
}

function validateActivityShimmerMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected shimmer viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(
    metrics.activeDurationMs >= 700 && metrics.activeDurationMs <= 1600,
    `the visual pulse lasted ${metrics.activeDurationMs.toFixed(1)} ms instead of about 1 second`,
  );
  assert(
    metrics.cadenceMs >= 1050 && metrics.cadenceMs <= 1450,
    `visual cadence was ${metrics.cadenceMs.toFixed(1)} ms instead of about 1.2 seconds`,
  );
  assert(metrics.activeAnimation.duration === "1s", "the visual animation does not last exactly 1 second");
  assert(
    metrics.activeAnimation.iterationCount === "1",
    "the shimmer started running in an infinite loop again",
  );
  assert(
    metrics.activeAnimation.name === "activity-reflection-sweep",
    "the shimmer layer uses an unexpected animation",
  );
  assert(
    metrics.activeAnimation.timingFunction.includes("steps(48"),
    "the shimmer lost its canonical 48-step progression",
  );
  assert(
    metrics.inactiveAnimationName === "none",
    "the animation remained stuck on the final frame after the pulse",
  );
  assert(metrics.activeTargets === 1, "the second pulse was not confined to the running activity");
  assert(metrics.childRunningTargets > 0, "the scenario contains no running child activity");
  assert(metrics.childShimmerTargets === 0, "shimmer leaked from the parent message into a child activity");
  assert(metrics.childSweepLayers === 0, "a child activity retained the shimmer visual layer");
  assert(metrics.titleText.length > 0, "the animated title became empty");
  assert(metrics.horizontalOverflow <= tolerance, "shimmer created horizontal overflow");
}

function validateTimelineExtremeFilesMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected 100,000-file viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.totalActivities === 100_000, "the extreme projection lost files");
  assert(
    metrics.physicalListHeight > 2_000_000 && metrics.physicalListHeight <= 8_000_000,
    `the extreme physical height became invalid (${metrics.physicalListHeight}px)`,
  );
  assert(metrics.rapidFrames >= 60, "the 100,000-file test collected too few frames");
  assert(
    metrics.rapidAnimationWorkFrames >= metrics.rapidFrames,
    "instrumentation did not cover the 100,000-file frames",
  );
  assert(
    metrics.rapidP95ApplicationAnimationWorkMs <= 8,
    `application work for 100,000 files was ${metrics.rapidP95ApplicationAnimationWorkMs.toFixed(2)} ms at P95`,
  );
  assert(
    metrics.rapidP99AnimationWorkMs <= 10,
    `total work for 100,000 files was ${metrics.rapidP99AnimationWorkMs.toFixed(2)} ms at P99`,
  );
  assert(
    metrics.rapidP99ApplicationAnimationWorkMs <= 8,
    `application work for 100,000 files was ${metrics.rapidP99ApplicationAnimationWorkMs.toFixed(2)} ms at P99`,
  );
  assert(
    metrics.rapidMaximumApplicationAnimationWorkMs <= 10,
    `maximum application work for 100,000 files was ${metrics.rapidMaximumApplicationAnimationWorkMs.toFixed(2)} ms`,
  );
  assert(metrics.rapidP95FrameMs <= 20, "100,000-file P95 exceeded 20ms");
  assert(metrics.rapidP99FrameMs <= 34, "100,000-file P99 exceeded 34ms");
  assert(metrics.rapidMaximumFrameMs <= 50, "the extreme scenario produced a frame above 50ms");
  assert(metrics.rapidLongTasks === 0, "100,000-file scrolling produced long tasks");
  assert(
    metrics.visibleDeferredBodyFrames === 0 && metrics.maximumVisibleDeferredBodies === 0,
    `the extreme scenario displayed empty bodies in ${metrics.visibleDeferredBodyFrames} frames (maximum ${metrics.maximumVisibleDeferredBodies})`,
  );
  assert(
    metrics.missingSummaryFrames === 0,
    "the extreme scenario removed real summaries during scrolling",
  );
  assert(
    metrics.summaryIdentityChanges === 0,
    `the extreme scenario replaced ${metrics.summaryIdentityChanges} summaries that remained visible`,
  );
  assert(
    metrics.wrapperIdentityChanges === 0,
    `the extreme scenario replaced ${metrics.wrapperIdentityChanges} containers that remained visible`,
  );
  assert(
    metrics.legacyPlaceholderFrames === 0,
    "the extreme scenario restored legacy placeholders",
  );
  assert(
    metrics.maximumMountedItems <= 128,
    `${metrics.maximumMountedItems} files remained mounted in the extreme scenario`,
  );
  assert(metrics.domNodes <= 3_000, "the extreme scenario exceeded 3,000 DOM nodes");
  assert(
    metrics.settledDeferredBodies === 0,
    "the extreme scenario left deferred bodies after settling",
  );
  assert(
    metrics.settledLegacyPlaceholders === 0,
    "the extreme scenario left legacy placeholders after settling",
  );
  assert(metrics.visualDriftPx !== null, "the extreme scenario did not materialize its anchor");
  assert(
    Math.abs(metrics.visualDriftPx) <= tolerance,
    `the 100,000-file anchor drifted ${metrics.visualDriftPx}px`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "100,000 files created horizontal overflow");
}

function validateChromeMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `unexpected viewport at ${viewport.width}x${viewport.height}`,
  );
  assert(Math.abs(metrics.chrome.top) <= tolerance, "the title bar does not begin at the top");
  assert(Math.abs(metrics.chrome.height - 34) <= tolerance, "the title bar is not 34px high");
  assert(
    Math.abs(metrics.content.top - metrics.chrome.top) <= tolerance,
    "the application surface does not continue beneath window chrome",
  );
  assert(
    Math.abs(metrics.content.bottom - viewport.height) <= tolerance,
    "the application surface does not occupy the full viewport height",
  );
  assert(metrics.controls.top >= 0, "window controls moved above the viewport");
  assert(
    metrics.controls.right <= viewport.width + tolerance,
    "window controls exceed the right edge",
  );
  assert(metrics.controls.width >= 138, "the window-control area became too narrow");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Visual audit failed: ${message}.`);
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
    throw new Error("Edge or Chrome was not found for the visual audit.");
  }
  return resolved;
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while accessing ${url}`);
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
            `CDP event "${method}" did not occur within ${EVENT_DEADLINE_MILLISECONDS} ms.`,
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
        "Preview evaluation failed.";
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
