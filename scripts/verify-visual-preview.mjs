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
const SETTINGS_PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}/?preview=1&chrome=1&settings=general`;
const USAGE_SETTINGS_PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}/?preview=1&chrome=1&settings=usage`;
const SETTINGS_INTERACTION_PREVIEW_URL = `${SETTINGS_PREVIEW_URL}&preferenceDelay=400`;
const AUTOMATIONS_PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}/?preview=1&chrome=1&surface=automations`;
const PROFILE_PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}/?preview=1&chrome=1&surface=profile`;
const ARTIFACT_DIRECTORY = path.join(PROJECT_ROOT, ".freebuff", "visual-audit");
const VIEWPORTS = [
  { width: 920, height: 640 },
  { width: 1280, height: 820 },
  { width: 1920, height: 1080 },
];
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
    readyExpression: `document.querySelector(".activity-title.is-running .activity-title-sweep") !== null`,
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
        });
      }));
    })()`,
    readyExpression: `(() => {
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
    prepareExpression: `(() => {
      const threadButton = [...document.querySelectorAll(".thread-main")].find(
        (button) => button.textContent?.includes("Inspecionar janela de contexto"),
      );
      threadButton?.click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const timeline = document.querySelector(".timeline");
        if (!(timeline instanceof HTMLElement)) {
          return;
        }
        timeline.scrollTop = Math.min(700, timeline.scrollHeight - timeline.clientHeight);
        requestAnimationFrame(() => {
          const target = Math.max(0, timeline.scrollTop - 180);
          timeline.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -180 }));
          timeline.scrollTop = target;
          window.__previewManualScrollTarget = target;
          const item = document.querySelector(".timeline-virtual-item");
          if (item instanceof HTMLElement) {
            const padding = Number.parseFloat(getComputedStyle(item).paddingBottom) || 0;
            item.style.paddingBottom = (padding + 320) + "px";
          }
          setTimeout(() => {
            window.__previewManualScrollReady = true;
          }, 300);
        });
      }));
    })()`,
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
    prepareExpression: `(() => {
      const threadButton = [...document.querySelectorAll(".thread-main")].find(
        (button) => button.textContent?.includes("Inspecionar janela de contexto"),
      );
      threadButton?.click();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        document.querySelectorAll(".agent-activity-group:not([open]) > summary").forEach(
          (summary) => summary.click(),
        );
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const command = [...document.querySelectorAll(".command-activity-card")].find(
            (details) => details.querySelector(":scope > summary .activity-title.is-running") !== null,
          );
          const source = [...document.querySelectorAll(".tool-activity-card")].find(
            (details) => details.textContent?.includes("diffHighlighter.test.ts"),
          );
          const file = [...document.querySelectorAll(".file-change-diff .diff-file-identity code")].find(
            (element) => element.textContent?.trim() === "semantic.rs",
          );
          const diff = file?.closest(".file-change-diff");
          for (const details of [command, source, diff]) {
            if (details instanceof HTMLDetailsElement && !details.open) {
              details.querySelector(":scope > summary")?.click();
            }
          }
          requestAnimationFrame(() => requestAnimationFrame(() => {
            const timeline = document.querySelector(".timeline");
            const commandScroll = command?.querySelector(".command-card-scroll");
            const sourceScroll = source?.querySelector(".command-card-scroll");
            const diffScroll = diff?.querySelector(".diff-viewport");
            if (
              !(timeline instanceof HTMLElement) ||
              !(commandScroll instanceof HTMLElement) ||
              !(sourceScroll instanceof HTMLElement) ||
              !(diffScroll instanceof HTMLElement)
            ) {
              return;
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
            const run = (region, requestedTop, deltaY) => {
              timeline.scrollTop = baseTimelineScroll;
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
              region.dispatchEvent(wheel);
              return {
                defaultPrevented: wheel.defaultPrevented,
                expectedNestedScroll,
                expectedTimelineDelta,
                nestedScrollTop: region.scrollTop,
                timelineDelta: timeline.scrollTop - baseTimelineScroll,
              };
            };
            try {
              const handoffStartedAt = performance.now();
              const commandMetrics = run(commandScroll, 40, -100);
              const diffMetrics = run(diffScroll, 0, -120);
              const sourceMetrics = run(sourceScroll, 0, -80);
              window.__previewNestedScrollMetrics = {
                command: commandMetrics,
                diff: diffMetrics,
                handoffDurationMs: performance.now() - handoffStartedAt,
                source: sourceMetrics,
                styleReadCount,
              };
            } finally {
              window.getComputedStyle = originalGetComputedStyle;
            }
            window.__previewNestedScrollReady = true;
          }));
        }));
      }));
    })()`,
    readyExpression: `window.__previewNestedScrollReady === true`,
    auditExpression: nestedScrollHandoffVisualAuditExpression,
    validate: validateNestedScrollHandoffMetrics,
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
    readyExpression: `[...document.querySelectorAll(".file-change-diff .diff-file-identity code")].some(
      (element) => element.textContent?.trim() === "engine.rs",
    )`,
    auditExpression: singleFileChangeVisualAuditExpression,
    validate: validateSingleFileChangeMetrics,
  },
  {
    id: "syntax-highlighted-diff",
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
        const file = [...document.querySelectorAll(".file-change-diff .diff-file-identity code")].find(
          (element) => element.textContent?.trim() === "engine.rs",
        );
        const block = file?.closest(".file-change-diff");
        if (block instanceof HTMLDetailsElement && !block.open) {
          block.querySelector(":scope > summary")?.click();
        }
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
    id: "syntax-highlighted-created-file",
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
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const file = [...document.querySelectorAll(".file-change-diff .diff-file-identity code")].find(
            (element) => element.textContent?.trim() === "semantic.rs",
          );
          const block = file?.closest(".file-change-diff");
          if (block instanceof HTMLDetailsElement && !block.open) {
            block.querySelector(":scope > summary")?.click();
          }
        }));
      }));
    })()`,
    readyExpression: `[...document.querySelectorAll(".file-change-diff .diff-file-identity code")].some(
      (element) =>
        element.textContent?.trim() === "semantic.rs" &&
        element.closest(".file-change-diff")?.querySelector(".syntax-token") !== null,
    )`,
    auditExpression: syntaxHighlightedCreatedFileVisualAuditExpression,
    validate: validateSyntaxHighlightedCreatedFileMetrics,
  },
  {
    id: "highlighted-tool-output",
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
        requestAnimationFrame(() => requestAnimationFrame(() => {
          for (const text of ["diffHighlighter.test.ts", "Search syntax highlighter usage"]) {
            const card = [...document.querySelectorAll(".tool-activity-card")].find(
              (element) => element.textContent?.includes(text),
            );
            if (card instanceof HTMLDetailsElement && !card.open) {
              card.querySelector(":scope > summary")?.click();
            }
          }
        }));
      }));
    })()`,
    readyExpression: `document.querySelector(".tool-source-output .syntax-token") !== null &&
      document.querySelector(".tool-search-output .syntax-token") !== null`,
    auditExpression: highlightedToolOutputVisualAuditExpression,
    validate: validateHighlightedToolOutputMetrics,
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
    })()`,
    readyExpression: `document.querySelector(".project-color-side-panel") !== null &&
      document.querySelector(".inline-color-picker") !== null`,
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
];

async function main() {
  const browserPath = resolveBrowserPath();
  const browserProfile = await mkdtemp(path.join(os.tmpdir(), "codex-app-visual-"));
  const debugPort = await reservePort();
  const server = spawn(
    process.execPath,
    [VITE_ENTRY, "--host", "127.0.0.1", "--port", String(PREVIEW_PORT), "--strictPort"],
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
        "--disable-breakpad",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-features=Translate",
        "--disable-gpu",
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
    for (const scenario of SCENARIOS) {
      for (const viewport of VIEWPORTS) {
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
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
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
      await waitForPreview(client, scenario.readyExpression, scenario.id);
    }
    await client.evaluate(
      `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(async () => {
        await document.fonts.ready;
        resolve(true);
      })))`,
      true,
    );

    const metrics = await client.evaluate(scenario.auditExpression(), false);
    scenario.validate(metrics, viewport);
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

async function waitForPreview(client, readyExpression, scenarioId) {
  const deadline = Date.now() + 15_000;
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
        failures: [...document.querySelectorAll(
          ".bootstrap-failure, .render-failure, .frontend-failure, [role='alert']",
        )].map((element) => element.textContent?.trim() ?? ""),
      })`,
      false,
    )
    .catch(() => null);
  throw new Error(
    `A prévia visual de ${scenarioId} não ficou pronta dentro de 15 segundos.\n` +
      `Diagnóstico: ${JSON.stringify(diagnostics)}`,
  );
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
    const highlight = title?.querySelector(".activity-title-highlight");
    if (
      !(title instanceof HTMLElement) ||
      !(base instanceof HTMLElement) ||
      !(sweep instanceof HTMLElement) ||
      !(highlight instanceof HTMLElement)
    ) {
      throw new Error("Camadas da reflexão da atividade ativa estão ausentes.");
    }
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
    const waveOpacities = [];
    if (
      sweepAnimation !== undefined &&
      highlightAnimation !== undefined &&
      Number.isFinite(duration) &&
      Number.isFinite(delay)
    ) {
      sweepAnimation.pause();
      highlightAnimation.pause();
      for (const fraction of [0.14, 0.29, 0.46, 0.62, 0.79, 0.96]) {
        const sampleTime = delay + duration * fraction;
        sweepAnimation.currentTime = sampleTime;
        highlightAnimation.currentTime = sampleTime;
        waveOpacities.push(Number.parseFloat(getComputedStyle(sweep).opacity));
      }
      const screenshotTime = delay + duration * 0.46;
      sweepAnimation.currentTime = screenshotTime;
      highlightAnimation.currentTime = screenshotTime;
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      titleText: title.textContent?.trim() ?? null,
      baseText: base.textContent?.trim() ?? null,
      highlightText: highlight.textContent?.trim() ?? null,
      animationName: sweepStyle.animationName,
      animationDuration: sweepStyle.animationDuration,
      animationDelay: sweepStyle.animationDelay,
      animationTimingFunction: sweepStyle.animationTimingFunction,
      highlightAnimationName: highlightStyle.animationName,
      maskImage: sweepStyle.maskImage || sweepStyle.webkitMaskImage,
      maskWaveCount: ((sweepStyle.maskImage || sweepStyle.webkitMaskImage).match(/rgb\\(0, 0, 0\\)/g) ?? []).length,
      waveOpacities,
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
    const timeline = document.querySelector(".timeline");
    const target = window.__previewManualScrollTarget;
    if (!(timeline instanceof HTMLElement) || typeof target !== "number") {
      throw new Error("Cenário de ownership do scroll não foi inicializado.");
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      targetScrollTop: target,
      finalScrollTop: timeline.scrollTop,
      drift: timeline.scrollTop - target,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`;
}

function nestedScrollHandoffVisualAuditExpression() {
  return `(() => {
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
    const groupedSet = groupedBlock?.closest(".grouped-file-change-set");
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
      !(groupedSet instanceof HTMLElement) ||
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
        groupedSet.querySelector(".grouped-file-change-heading") instanceof HTMLElement,
      groupedDirectFileCount:
        groupedSet.querySelectorAll(":scope > .file-change-list > .file-change-diff").length,
      groupedNestedCollectionCount: groupedSet.querySelectorAll(".file-change-card").length,
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
    const context = viewport.querySelector(".unified-diff-row.is-context");
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      viewport: { width: innerWidth, height: innerHeight },
      tokenKinds,
      tokenColorCount: tokenColors.length,
      tokenCount: tokens.length,
      contextHasSyntax: context?.querySelector(".syntax-token") instanceof HTMLElement,
      additionBackground:
        addition instanceof HTMLElement ? getComputedStyle(addition).backgroundColor : null,
      deletionBackground:
        deletion instanceof HTMLElement ? getComputedStyle(deletion).backgroundColor : null,
      keywordColor: rootStyle.getPropertyValue("--syntax-keyword").trim(),
      stringColor: rootStyle.getPropertyValue("--syntax-string").trim(),
      codeText: viewport.querySelector(".unified-diff-code code")?.textContent ?? null,
      codeInset:
        addition instanceof HTMLElement
          ? addition.getBoundingClientRect().left - viewport.getBoundingClientRect().left
          : null,
      newlineMetadataRows: [...viewport.querySelectorAll(".unified-diff-hunk")].filter(
        (element) => element.textContent?.includes("No newline at end of file"),
      ).length,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      viewportHorizontalOverflow: viewport.scrollWidth - viewport.clientWidth,
    };
  })()`;
}

function syntaxHighlightedCreatedFileVisualAuditExpression() {
  return `(() => {
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
      codeInset: code.getBoundingClientRect().left - viewport.getBoundingClientRect().left,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`;
}

function highlightedToolOutputVisualAuditExpression() {
  return `(() => {
    const source = document.querySelector(".tool-source-output");
    const search = document.querySelector(".tool-search-output");
    if (!(source instanceof HTMLElement) || !(search instanceof HTMLElement)) {
      throw new Error("Saídas tipadas de leitura e busca estão ausentes.");
    }
    const sourceTokens = [...source.querySelectorAll(".syntax-token")];
    const searchTokens = [...search.querySelectorAll(".syntax-token")];
    return {
      viewport: { width: innerWidth, height: innerHeight },
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
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
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
    const chrome = rectangle(".window-chrome");
    const content = rectangle(".application-frame-content");
    const controls = rectangle(".window-chrome-controls");
    const sidebar = rectangle(".sidebar");
    const surface = rectangle(".profile-page");
    const profileContent = rectangle(".profile-page-content");
    const avatar = rectangle(".profile-identity .account-avatar-profile");
    const summary = rectangle(".profile-summary");
    const activity = rectangle(".profile-activity-chart");
    const activityGrid = rectangle(".profile-activity-grid");
    const insights = rectangle(".profile-insights-grid");
    const surfaceElement = document.querySelector(".profile-page-scroll");
    if (!(surfaceElement instanceof HTMLElement)) {
      throw new Error("Scroller do perfil ausente.");
    }
    const cells = [...document.querySelectorAll(".profile-activity-cell")];
    return {
      viewport: { width: innerWidth, height: innerHeight },
      chrome,
      content,
      controls,
      sidebar,
      surface,
      profileContent,
      avatar,
      summary,
      activity,
      activityGrid,
      insights,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      surfaceHorizontalOverflow: surfaceElement.scrollWidth - surfaceElement.clientWidth,
      centeredInsetDifference: Math.abs(
        profileContent.left - surface.left - (surface.right - profileContent.right),
      ),
      summaryStats: document.querySelectorAll(".profile-summary-stat").length,
      activityCells: cells.length,
      activeCells: cells.filter((cell) => cell.getAttribute("data-level") !== "0").length,
      futureCells: cells.filter((cell) => cell.classList.contains("future")).length,
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
      sidebarAvatarImages: document.querySelectorAll(".sidebar .account-avatar img").length,
      activeProfileTriggers: document.querySelectorAll(".sidebar-account-trigger.active").length,
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
  assert(metrics.titleText === metrics.baseText + metrics.highlightText, "as camadas perderam texto");
  assert(metrics.baseText === metrics.highlightText, "a reflexão não replica o título ativo");
  assert(
    metrics.animationName === "activity-reflection-sweep",
    "a varredura luminosa não está animada",
  );
  assert(
    metrics.highlightAnimationName === "activity-reflection-text",
    "o texto luminoso não acompanha a varredura",
  );
  assert(metrics.animationDuration === "2s", "o ciclo sequencial não mede 2 segundos");
  assert(metrics.animationDelay === "0.08s", "a reflexão não inicia quase imediatamente");
  assert(
    metrics.maskWaveCount === 1,
    `mais de uma onda ficou visível ao mesmo tempo (${JSON.stringify(metrics.maskImage)})`,
  );
  const expectedVisibility = [true, false, true, false, true, false];
  assert(
    metrics.waveOpacities.length === expectedVisibility.length &&
      metrics.waveOpacities.every(
        (opacity, index) => (opacity >= 0.95) === expectedVisibility[index],
      ),
    `as três passagens não estão separadas por pausas: ${JSON.stringify(metrics.waveOpacities)}`,
  );
  assert(
    metrics.animationTimingFunction.includes("cubic-bezier"),
    "a reflexão perdeu a curva fluida",
  );
  assert(metrics.maskImage !== "none", "a reflexão perdeu a máscara luminosa");
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
    "o marcador não navegou para a posição atual possível da mensagem",
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
    Math.abs(metrics.drift) <= tolerance,
    "uma medição virtual disputou o scroll manual e moveu o viewport",
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
    metrics.handoffDurationMs <= 16,
    `três transferências de wheel excederam um frame: ${metrics.handoffDurationMs.toFixed(3)} ms`,
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
  }
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
  assert(metrics.title === "Executando comando", "o comando aberto perdeu seu estado em execução");
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
  assert(metrics.newFileAdditions === "+338", "o arquivo novo perdeu a contagem de linhas");
  assert(metrics.newFileHasDeletions === false, "o arquivo novo ainda exibe uma remoção zerada");
  assert(
    metrics.deletedFileAction === "Arquivo excluído",
    "o arquivo excluído perdeu a semântica Arquivo excluído",
  );
  assert(metrics.deletedFileBadge === "EXCLUÍDO", "o arquivo excluído perdeu seu selo");
  assert(
    metrics.deletedFileDeletions === "−288",
    "o arquivo excluído não exibe o total autoritativo de linhas removidas",
  );
  assert(
    metrics.deletedFileHasAdditions === false,
    "o arquivo excluído ainda exibe uma adição zerada",
  );
  assert(metrics.open === false, "a alteração única iniciou expandida");
  assert(metrics.aggregateContainerCount === 0, "a alteração única ainda criou um agrupador");
  assert(metrics.directDiffVisible === false, "o diff do arquivo único iniciou visível");
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
    metrics.additionBackground !== null &&
      metrics.additionBackground !== "rgba(0, 0, 0, 0)",
    "o realce removeu o fundo semântico de adição",
  );
  assert(
    metrics.deletionBackground !== null &&
      metrics.deletionBackground !== "rgba(0, 0, 0, 0)",
    "o realce removeu o fundo semântico de remoção",
  );
  assert(
    metrics.additionBackground !== metrics.deletionBackground,
    "adição e remoção perderam distinção visual",
  );
  assert(metrics.keywordColor === "#d5a6ff", "keywords não usam a paleta sintática");
  assert(metrics.stringColor === "#ffb38a", "strings não usam a paleta sintática");
  assert(metrics.codeText?.includes("use std::time::Instant;"), "o diff perdeu o texto do código");
  assert(metrics.codeInset !== null && metrics.codeInset <= 90, "o gutter do diff continua largo demais");
  assert(metrics.newlineMetadataRows === 0, "metadados de newline ainda consomem linhas visuais");
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
  assert(metrics.codeInset <= 90, "o arquivo criado mantém um gutter largo demais");
}

function validateHighlightedToolOutputMetrics(metrics, viewport) {
  const tolerance = 1;
  assert(
    metrics.viewport.width === viewport.width && metrics.viewport.height === viewport.height,
    `viewport inesperado nas saídas coloridas em ${viewport.width}x${viewport.height}`,
  );
  assert(metrics.horizontalOverflow <= tolerance, "as saídas tipadas criaram overflow global");
  assert(
    JSON.stringify(metrics.sourceLineNumbers) === JSON.stringify(["20", "21", "22", "23", "24", "25", "26", "27"]),
    "a leitura de arquivo perdeu seus números de linha",
  );
  assert(metrics.sourceTokenKinds.includes("token-keyword"), "a leitura de arquivo não coloriu keywords");
  assert(metrics.sourceTokenKinds.includes("token-string"), "a leitura de arquivo não coloriu strings");
  assert(metrics.searchTokenKinds.includes("token-keyword"), "a busca não coloriu os trechos encontrados");
  assert(metrics.sourceText.includes("const continuation"), "a leitura perdeu o código original");
  assert(metrics.searchText.includes("src/ui/syntax/diffHighlighter.test.ts:20"), "a busca perdeu a localização");
  assert(metrics.sourceHorizontalOverflow >= 0, "a leitura perdeu sua largura rolável");
  assert(metrics.searchHorizontalOverflow >= 0, "a busca perdeu sua largura rolável");
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
  assert(metrics.previewColor === "rgb(74, 222, 128)", "a prévia não reflete a cor do projeto");
  assert(metrics.hexValue === "4ADE80", "o campo HEX não preserva a cor do projeto");
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
  assert(metrics.horizontalOverflow <= tolerance, "o perfil criou overflow horizontal global");
  assert(
    metrics.surfaceHorizontalOverflow <= tolerance,
    "a superfície do perfil possui overflow horizontal",
  );
  assert(
    Math.abs(metrics.surface.top - metrics.chrome.bottom) <= tolerance,
    "o perfil não começa imediatamente abaixo do chrome",
  );
  assert(metrics.profileContent.width <= 733, "o conteúdo do perfil ultrapassou 732 px");
  assert(
    metrics.profileContent.width <= metrics.surface.width,
    "o conteúdo do perfil ultrapassa sua superfície",
  );
  assert(metrics.centeredInsetDifference <= 3, "o conteúdo do perfil não está centralizado");
  assert(Math.abs(metrics.avatar.width - 80) <= tolerance, "o avatar do perfil não mede 80 px");
  assert(Math.abs(metrics.avatar.height - 80) <= tolerance, "o avatar do perfil não mede 80 px");
  assert(metrics.profileAvatarImages === 1, "a foto do avatar não aparece na página de perfil");
  assert(metrics.sidebarAvatarImages >= 1, "a foto do avatar não aparece na barra lateral");
  assert(metrics.summary.height >= 60, "o resumo do perfil ficou baixo demais");
  assert(metrics.summaryStats === 5, "o resumo não contém as cinco métricas oficiais");
  assert(metrics.activityCells === 364, "o calendário não contém 52 semanas completas");
  assert(metrics.activeCells >= 60, "a atividade de preview ficou visualmente vazia");
  assert(metrics.futureCells === 6, "os seis dias futuros da última semana não foram isolados");
  assert(metrics.monthLabels >= 10, "os rótulos mensais do calendário estão incompletos");
  assert(metrics.activityTabs === 3, "as três agregações de atividade estão ausentes");
  assert(metrics.selectedActivityTabs === 1, "a agregação ativa não é única");
  assert(metrics.insightRows === 5, "os cinco insights oficiais não foram renderizados");
  assert(metrics.invocationRows === 1, "o plugin mais usado do preview está ausente");
  assert(metrics.activeProfileTriggers === 1, "a navegação não marca o perfil como ativo");
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
    path.join(process.env.ProgramFiles ?? "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(
      process.env["ProgramFiles(x86)"] ?? "",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    path.join(
      process.env.LOCALAPPDATA ?? "",
      "Google",
      "Chrome",
      "Application",
      "chrome.exe",
    ),
    path.join(process.env.ProgramFiles ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(
      process.env["ProgramFiles(x86)"] ?? "",
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe",
    ),
    path.join(
      process.env.LOCALAPPDATA ?? "",
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
    return new Promise((resolve) => {
      const listeners = this.events.get(method) ?? [];
      listeners.push(resolve);
      this.events.set(method, listeners);
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
    if (listeners === undefined) {
      return;
    }
    this.events.delete(message.method);
    for (const listener of listeners) {
      listener(message.params);
    }
  }
}

await main();
