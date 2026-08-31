import { PROFILE_STORAGE_KEYS } from "../state/profileStorage";

export const WORKSPACE_SPLIT_DEFAULT_RATIO = 0.5;
export const WORKSPACE_SPLIT_DIVIDER_WIDTH_PX = 8;
export const WORKSPACE_SPLIT_MIN_PANE_WIDTH_PX = 420;
export const WORKSPACE_SPLIT_MIN_RATIO = 0.2;
export const WORKSPACE_SPLIT_MAX_RATIO = 0.8;

interface WorkspaceSplitStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export interface WorkspaceSplitMetrics {
  readonly chatPaneWidth: number;
  readonly maximumRatio: number;
  readonly minimumRatio: number;
  readonly ratio: number;
  readonly workspacePaneWidth: number;
}

export function resolveWorkspaceSplitMetrics(
  requestedRatio: number,
  containerWidth: number,
): WorkspaceSplitMetrics {
  const width = Number.isFinite(containerWidth) ? Math.max(0, containerWidth) : 0;
  const availableWidth = Math.max(0, width - WORKSPACE_SPLIT_DIVIDER_WIDTH_PX);
  const paneMinimumRatio =
    availableWidth === 0
      ? WORKSPACE_SPLIT_DEFAULT_RATIO
      : WORKSPACE_SPLIT_MIN_PANE_WIDTH_PX / availableWidth;
  const minimumRatio = Math.max(WORKSPACE_SPLIT_MIN_RATIO, paneMinimumRatio);
  const maximumRatio = Math.min(WORKSPACE_SPLIT_MAX_RATIO, 1 - paneMinimumRatio);
  const hasUsableRange = minimumRatio <= maximumRatio;
  const boundedMinimum = hasUsableRange ? minimumRatio : WORKSPACE_SPLIT_DEFAULT_RATIO;
  const boundedMaximum = hasUsableRange ? maximumRatio : WORKSPACE_SPLIT_DEFAULT_RATIO;
  const normalizedRatio = normalizeWorkspaceSplitRatio(requestedRatio);
  const ratio = Math.min(boundedMaximum, Math.max(boundedMinimum, normalizedRatio));
  const chatPaneWidth = availableWidth * ratio;
  return {
    chatPaneWidth,
    maximumRatio: boundedMaximum,
    minimumRatio: boundedMinimum,
    ratio,
    workspacePaneWidth: availableWidth - chatPaneWidth,
  };
}

export function workspaceSplitRatioFromPointer(
  clientX: number,
  containerLeft: number,
  containerWidth: number,
): number {
  const width = Number.isFinite(containerWidth) ? Math.max(0, containerWidth) : 0;
  const availableWidth = Math.max(0, width - WORKSPACE_SPLIT_DIVIDER_WIDTH_PX);
  const pointerOffset =
    (Number.isFinite(clientX) ? clientX : containerLeft) -
    (Number.isFinite(containerLeft) ? containerLeft : 0) -
    WORKSPACE_SPLIT_DIVIDER_WIDTH_PX / 2;
  const requestedRatio =
    availableWidth === 0 ? WORKSPACE_SPLIT_DEFAULT_RATIO : pointerOffset / availableWidth;
  return resolveWorkspaceSplitMetrics(requestedRatio, width).ratio;
}

export function readWorkspaceSplitRatio(
  storage: WorkspaceSplitStorage | null = defaultWorkspaceSplitStorage(),
): number {
  if (storage === null) {
    return WORKSPACE_SPLIT_DEFAULT_RATIO;
  }
  try {
    const stored = storage.getItem(PROFILE_STORAGE_KEYS.workspaceSplitRatio);
    return stored === null || stored.trim().length === 0
      ? WORKSPACE_SPLIT_DEFAULT_RATIO
      : normalizeWorkspaceSplitRatio(Number(stored));
  } catch {
    return WORKSPACE_SPLIT_DEFAULT_RATIO;
  }
}

export function writeWorkspaceSplitRatio(
  ratio: number,
  storage: WorkspaceSplitStorage | null = defaultWorkspaceSplitStorage(),
): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(
      PROFILE_STORAGE_KEYS.workspaceSplitRatio,
      String(normalizeWorkspaceSplitRatio(ratio)),
    );
  } catch {
    // The preference is optional; layout remains functional when storage is unavailable.
  }
}

function normalizeWorkspaceSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) {
    return WORKSPACE_SPLIT_DEFAULT_RATIO;
  }
  return Math.min(WORKSPACE_SPLIT_MAX_RATIO, Math.max(WORKSPACE_SPLIT_MIN_RATIO, ratio));
}

function defaultWorkspaceSplitStorage(): WorkspaceSplitStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}
