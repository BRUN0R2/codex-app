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
const SETTINGS_PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}/?preview=1&chrome=1&settings=general`;
const SETTINGS_INTERACTION_PREVIEW_URL = `${SETTINGS_PREVIEW_URL}&preferenceDelay=400`;
const AUTOMATIONS_PREVIEW_URL = `http://127.0.0.1:${PREVIEW_PORT}/?preview=1&chrome=1&surface=automations`;
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
    id: "settings",
    url: SETTINGS_PREVIEW_URL,
    readyExpression: `document.querySelector(".settings-dialog") !== null &&
      document.querySelector(".window-chrome-controls") !== null &&
      document.querySelectorAll(".application-preference").length === 3`,
    auditExpression: settingsVisualAuditExpression,
    validate: validateSettingsMetrics,
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
  throw new Error(`A prévia visual de ${scenarioId} não ficou pronta dentro de 15 segundos.`);
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
      buttonHorizontalOverflow:
        buttonElement instanceof HTMLElement
          ? buttonElement.scrollWidth - buttonElement.clientWidth
          : null,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
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
      page,
      heading,
      firstRowLabel,
      chromeText: document.querySelector(".window-chrome")?.textContent?.trim() ?? null,
      chromeOverlapsSettings: overlaps(chrome, overlay),
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
      verticalOverflow: document.documentElement.scrollHeight - innerHeight,
      checkboxCount: document.querySelectorAll(
        '.application-preference input[type="checkbox"]',
      ).length,
      visibleCards: [...document.querySelectorAll(".settings-card")].filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.bottom > content.top && bounds.top < innerHeight;
      }).length,
    };
  })()`;
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
    const primaryNavigation = rectangle(".sidebar-primary-nav");
    const surface = rectangle(".automations-view");
    const header = rectangle(".automations-header");
    const heading = rectangle(".automations-header h1");
    const notice = rectangle(".automation-local-notice");
    const card = rectangle(".automation-card");
    const surfaceElement = document.querySelector(".automations-view");
    if (!(surfaceElement instanceof HTMLElement)) {
      throw new Error("Superfície de Automações ausente.");
    }
    return {
      viewport: { width: innerWidth, height: innerHeight },
      chrome,
      content,
      controls,
      sidebar,
      sidebarTitlebar,
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
  assert(metrics.horizontalOverflow <= tolerance, "a página possui overflow horizontal");
  assert(metrics.navigation.width >= 248, "a navegação de configurações ficou estreita");
  assert(metrics.main.width >= 600, "o painel principal de configurações ficou estreito");
  assert(metrics.page.width >= 500, "o conteúdo de configurações ficou excessivamente estreito");
  assert(Number.parseFloat(metrics.heading.fontSize) >= 21, "o título ficou pequeno demais");
  assert(Number.parseFloat(metrics.firstRowLabel.fontSize) >= 11, "os rótulos ficaram pequenos");
  assert(metrics.checkboxCount === 3, "os três controles booleanos não foram renderizados");
  assert(metrics.visibleCards >= 2, "menos de dois cartões de configurações estão visíveis");
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
      throw new Error(response.exceptionDetails.text ?? "Falha ao avaliar a prévia.");
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
