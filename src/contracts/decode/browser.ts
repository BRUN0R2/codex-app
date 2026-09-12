import type {
  BrowserActionMetric,
  BrowserAgentActivityNotification,
  BrowserNewWindowNotification,
  BrowserPageMetricSummary,
  BrowserTabSnapshot,
} from "../types";
import {
  array,
  booleanValue,
  browserOrigin,
  browserUrl,
  ContractError,
  exactRecord,
  finiteNumber,
  identifier,
  integer,
  literal,
  text,
} from "./primitives";

export function decodeBrowserTabSnapshot(value: unknown): BrowserTabSnapshot {
  const object = exactRecord(value, "$", [
    "browserTabId",
    "canGoBack",
    "canGoForward",
    "conversationId",
    "isLoading",
    "title",
    "url",
    "viewport",
  ]);
  return {
    browserTabId: identifier(object.browserTabId, "$.browserTabId"),
    conversationId: identifier(object.conversationId, "$.conversationId"),
    url: browserUrl(object.url, "$.url"),
    title: object.title === null ? null : text(object.title, "$.title", 2_048),
    canGoBack: booleanValue(object.canGoBack, "$.canGoBack"),
    canGoForward: booleanValue(object.canGoForward, "$.canGoForward"),
    isLoading: booleanValue(object.isLoading, "$.isLoading"),
    viewport: object.viewport === null ? null : decodeBrowserViewport(object.viewport),
  };
}

export function decodeBrowserViewport(value: unknown): BrowserTabSnapshot["viewport"] {
  const object = exactRecord(value, "$.viewport", ["height", "scale", "width"]);
  return {
    width: integer(object.width, "$.viewport.width", 320, 7_680),
    height: integer(object.height, "$.viewport.height", 240, 4_320),
    scale: finiteNumber(object.scale, "$.viewport.scale", 0.25, 2),
  };
}

export function decodeBrowserNewWindowNotification(value: unknown): BrowserNewWindowNotification {
  const object = exactRecord(value, "$", ["browserTabId", "conversationId", "url"]);
  return {
    browserTabId: identifier(object.browserTabId, "$.browserTabId"),
    conversationId: identifier(object.conversationId, "$.conversationId"),
    url: browserUrl(object.url, "$.url"),
  };
}

export function decodeBrowserAgentActivityNotification(
  value: unknown,
): BrowserAgentActivityNotification {
  const object = exactRecord(value, "$", [
    "action",
    "activeBrowserTabId",
    "conversationId",
    "panel",
    "tabs",
  ]);
  const tabs = array(object.tabs, "$.tabs", decodeBrowserTabSnapshot, 16);
  const tabIds = new Set<string>();
  for (const tab of tabs) {
    if (tabIds.has(tab.browserTabId)) {
      throw new ContractError(
        "$.tabs",
        `duplicate browser tab id ${JSON.stringify(tab.browserTabId)}`,
      );
    }
    tabIds.add(tab.browserTabId);
  }
  const activeBrowserTabId =
    object.activeBrowserTabId === null
      ? null
      : identifier(object.activeBrowserTabId, "$.activeBrowserTabId");
  if (
    (tabs.length === 0 && activeBrowserTabId !== null) ||
    (activeBrowserTabId !== null && !tabIds.has(activeBrowserTabId))
  ) {
    throw new ContractError("$.activeBrowserTabId", "active browser tab is absent from topology");
  }
  return {
    conversationId: identifier(object.conversationId, "$.conversationId"),
    activeBrowserTabId,
    tabs,
    panel: literal(object.panel, "$.panel", ["close", "open"] as const),
    action: text(object.action, "$.action", 128),
  };
}

export function decodeBrowserActionMetric(value: unknown): BrowserActionMetric {
  const object = exactRecord(value, "$", [
    "action",
    "actionMs",
    "browserTabId",
    "conversationId",
    "error",
    "id",
    "itemId",
    "loadMs",
    "origin",
    "page",
    "queueMs",
    "screenshotBytes",
    "screenshotMs",
    "sessionId",
    "snapshotMs",
    "status",
    "timestampMs",
    "totalMs",
    "turnId",
    "url",
  ]);
  return {
    id: identifier(object.id, "$.id"),
    sessionId: identifier(object.sessionId, "$.sessionId"),
    timestampMs: integer(object.timestampMs, "$.timestampMs", 0, Number.MAX_SAFE_INTEGER),
    conversationId: identifier(object.conversationId, "$.conversationId"),
    turnId: identifier(object.turnId, "$.turnId"),
    itemId: identifier(object.itemId, "$.itemId"),
    browserTabId:
      object.browserTabId === null ? null : identifier(object.browserTabId, "$.browserTabId"),
    action: text(object.action, "$.action", 128),
    status: literal(object.status, "$.status", ["completed", "declined", "failed"] as const),
    origin: object.origin === null ? null : browserOrigin(object.origin, "$.origin"),
    url: object.url === null ? null : browserUrl(object.url, "$.url"),
    queueMs: integer(object.queueMs, "$.queueMs", 0, Number.MAX_SAFE_INTEGER),
    actionMs: integer(object.actionMs, "$.actionMs", 0, Number.MAX_SAFE_INTEGER),
    loadMs: integer(object.loadMs, "$.loadMs", 0, Number.MAX_SAFE_INTEGER),
    snapshotMs: integer(object.snapshotMs, "$.snapshotMs", 0, Number.MAX_SAFE_INTEGER),
    screenshotMs: integer(object.screenshotMs, "$.screenshotMs", 0, Number.MAX_SAFE_INTEGER),
    totalMs: integer(object.totalMs, "$.totalMs", 0, Number.MAX_SAFE_INTEGER),
    screenshotBytes:
      object.screenshotBytes === null
        ? null
        : integer(object.screenshotBytes, "$.screenshotBytes", 0, Number.MAX_SAFE_INTEGER),
    page: object.page === null ? null : decodeBrowserPageMetricSummary(object.page, "$.page"),
    error: object.error === null ? null : text(object.error, "$.error", 2_048),
  };
}

export function decodeBrowserPageMetricSummary(
  value: unknown,
  path: string,
): BrowserPageMetricSummary {
  const object = exactRecord(value, path, [
    "consoleErrors",
    "cumulativeLayoutShift",
    "duplicateIds",
    "horizontalOverflowPx",
    "interactiveElements",
    "largestContentfulPaintMs",
    "longTaskCount",
    "longTaskDurationMs",
    "missingAltImages",
    "navigationDurationMs",
    "pageErrors",
    "readyState",
    "resourceCount",
    "resourceFailures",
    "transferBytes",
    "unlabeledControls",
    "viewportHeight",
    "viewportWidth",
  ]);
  const optionalMetric = (entry: unknown, entryPath: string): number | null =>
    entry === null ? null : finiteNumber(entry, entryPath, 0, Number.MAX_SAFE_INTEGER);
  return {
    readyState: literal(object.readyState, `${path}.readyState`, [
      "complete",
      "interactive",
      "loading",
    ] as const),
    viewportWidth: integer(object.viewportWidth, `${path}.viewportWidth`, 1, 16_384),
    viewportHeight: integer(object.viewportHeight, `${path}.viewportHeight`, 1, 16_384),
    interactiveElements: integer(
      object.interactiveElements,
      `${path}.interactiveElements`,
      0,
      10_000,
    ),
    consoleErrors: integer(object.consoleErrors, `${path}.consoleErrors`, 0, 10_000),
    pageErrors: integer(object.pageErrors, `${path}.pageErrors`, 0, 10_000),
    resourceFailures: integer(object.resourceFailures, `${path}.resourceFailures`, 0, 10_000),
    resourceCount: integer(object.resourceCount, `${path}.resourceCount`, 0, 1_000_000),
    transferBytes: integer(
      object.transferBytes,
      `${path}.transferBytes`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    navigationDurationMs: optionalMetric(
      object.navigationDurationMs,
      `${path}.navigationDurationMs`,
    ),
    largestContentfulPaintMs: optionalMetric(
      object.largestContentfulPaintMs,
      `${path}.largestContentfulPaintMs`,
    ),
    cumulativeLayoutShift: finiteNumber(
      object.cumulativeLayoutShift,
      `${path}.cumulativeLayoutShift`,
      0,
      1_000_000,
    ),
    longTaskCount: integer(object.longTaskCount, `${path}.longTaskCount`, 0, 1_000_000),
    longTaskDurationMs: finiteNumber(
      object.longTaskDurationMs,
      `${path}.longTaskDurationMs`,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    horizontalOverflowPx: finiteNumber(
      object.horizontalOverflowPx,
      `${path}.horizontalOverflowPx`,
      0,
      1_000_000,
    ),
    unlabeledControls: integer(object.unlabeledControls, `${path}.unlabeledControls`, 0, 10_000),
    missingAltImages: integer(object.missingAltImages, `${path}.missingAltImages`, 0, 10_000),
    duplicateIds: integer(object.duplicateIds, `${path}.duplicateIds`, 0, 10_000),
  };
}
