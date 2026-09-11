import { PROFILE_STORAGE_KEYS } from "../state/profileStorage";

export const SIDEBAR_WIDTH_DEFAULT_PX = 360;
export const SIDEBAR_WIDTH_MIN_PX = 240;
export const SIDEBAR_WIDTH_MAX_PX = 520;
export const SIDEBAR_SPLITTER_WIDTH_PX = 8;
export const SIDEBAR_MAIN_PANEL_MIN_WIDTH_PX = 430;

interface SidebarWidthStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export interface SidebarWidthMetrics {
  readonly maximumWidth: number;
  readonly minimumWidth: number;
  readonly width: number;
}

export function resolveSidebarWidthMetrics(
  requestedWidth: number,
  containerWidth: number,
): SidebarWidthMetrics {
  const width = Number.isFinite(containerWidth) ? Math.max(0, containerWidth) : 0;
  const hasMeasuredContainer = width > 0;
  const availableSidebarWidth = width - SIDEBAR_SPLITTER_WIDTH_PX - SIDEBAR_MAIN_PANEL_MIN_WIDTH_PX;
  const maximumWidth = hasMeasuredContainer
    ? Math.max(SIDEBAR_WIDTH_MIN_PX, Math.min(SIDEBAR_WIDTH_MAX_PX, availableSidebarWidth))
    : SIDEBAR_WIDTH_MAX_PX;
  const normalizedWidth = normalizeSidebarWidth(requestedWidth);
  return {
    maximumWidth,
    minimumWidth: SIDEBAR_WIDTH_MIN_PX,
    width: Math.min(maximumWidth, Math.max(SIDEBAR_WIDTH_MIN_PX, normalizedWidth)),
  };
}

export function sidebarWidthFromPointer(
  clientX: number,
  containerLeft: number,
  containerWidth: number,
): number {
  const width = Number.isFinite(containerWidth) ? Math.max(0, containerWidth) : 0;
  const pointerOffset =
    (Number.isFinite(clientX) ? clientX : containerLeft) -
    (Number.isFinite(containerLeft) ? containerLeft : 0) -
    SIDEBAR_SPLITTER_WIDTH_PX / 2;
  return resolveSidebarWidthMetrics(pointerOffset, width).width;
}

export function readSidebarWidth(
  storage: SidebarWidthStorage | null = defaultSidebarWidthStorage(),
): number {
  if (storage === null) {
    return SIDEBAR_WIDTH_DEFAULT_PX;
  }
  try {
    const stored = storage.getItem(PROFILE_STORAGE_KEYS.sidebarWidth);
    return stored === null || stored.trim().length === 0
      ? SIDEBAR_WIDTH_DEFAULT_PX
      : normalizeSidebarWidth(Number(stored));
  } catch {
    return SIDEBAR_WIDTH_DEFAULT_PX;
  }
}

export function writeSidebarWidth(
  width: number,
  storage: SidebarWidthStorage | null = defaultSidebarWidthStorage(),
): void {
  if (storage === null) {
    return;
  }
  try {
    storage.setItem(PROFILE_STORAGE_KEYS.sidebarWidth, String(normalizeSidebarWidth(width)));
  } catch {
    // The preference is optional; layout remains functional when storage is unavailable.
  }
}

function normalizeSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return SIDEBAR_WIDTH_DEFAULT_PX;
  }
  return Math.min(SIDEBAR_WIDTH_MAX_PX, Math.max(SIDEBAR_WIDTH_MIN_PX, width));
}

function defaultSidebarWidthStorage(): SidebarWidthStorage | null {
  return typeof localStorage === "undefined" ? null : localStorage;
}
