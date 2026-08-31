import type { BrowserViewport } from "../contracts/types";

export const MIN_BROWSER_VIEWPORT_WIDTH = 320;
export const MAX_BROWSER_VIEWPORT_WIDTH = 7_680;
export const MIN_BROWSER_VIEWPORT_HEIGHT = 240;
export const MAX_BROWSER_VIEWPORT_HEIGHT = 4_320;

export const BROWSER_VIEWPORT_SCALES = [0.25, 0.33, 0.5, 0.67, 0.75, 0.83, 0.9, 1] as const;

export const STANDARD_BROWSER_VIEWPORTS = [
  { id: "1280x720", label: "HD · 720p", width: 1_280, height: 720 },
  { id: "1920x1080", label: "Full HD · 1080p", width: 1_920, height: 1_080 },
  { id: "2560x1440", label: "QHD · 1440p", width: 2_560, height: 1_440 },
  { id: "3840x2160", label: "4K UHD", width: 3_840, height: 2_160 },
  { id: "7680x4320", label: "8K UHD", width: 7_680, height: 4_320 },
] as const;

export type BrowserViewportPresetId = (typeof STANDARD_BROWSER_VIEWPORTS)[number]["id"];

export type BrowserViewportParseResult =
  | { readonly ok: true; readonly viewport: BrowserViewport }
  | {
      readonly ok: false;
      readonly reason: "heightOutOfRange" | "invalidScale" | "widthOutOfRange";
    };

export function parseBrowserViewport(
  widthInput: string,
  heightInput: string,
  scale: number,
): BrowserViewportParseResult {
  const width = Number(widthInput);
  const height = Number(heightInput);
  if (
    !Number.isSafeInteger(width) ||
    width < MIN_BROWSER_VIEWPORT_WIDTH ||
    width > MAX_BROWSER_VIEWPORT_WIDTH
  ) {
    return { ok: false, reason: "widthOutOfRange" };
  }
  if (
    !Number.isSafeInteger(height) ||
    height < MIN_BROWSER_VIEWPORT_HEIGHT ||
    height > MAX_BROWSER_VIEWPORT_HEIGHT
  ) {
    return { ok: false, reason: "heightOutOfRange" };
  }
  if (!BROWSER_VIEWPORT_SCALES.some((candidate) => candidate === scale)) {
    return { ok: false, reason: "invalidScale" };
  }
  return { ok: true, viewport: { width, height, scale } };
}

export function browserViewportPreset(
  presetId: string,
): (typeof STANDARD_BROWSER_VIEWPORTS)[number] | null {
  return STANDARD_BROWSER_VIEWPORTS.find(({ id }) => id === presetId) ?? null;
}

export function initialBrowserViewport(width: number, height: number): BrowserViewport {
  return {
    width: clampInteger(width, MIN_BROWSER_VIEWPORT_WIDTH, MAX_BROWSER_VIEWPORT_WIDTH),
    height: clampInteger(height, MIN_BROWSER_VIEWPORT_HEIGHT, MAX_BROWSER_VIEWPORT_HEIGHT),
    scale: 1,
  };
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}
