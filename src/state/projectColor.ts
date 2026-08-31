export interface HsvColor {
  readonly h: number;
  readonly s: number;
  readonly v: number;
}

export function hueFromHorizontalPosition(offset: number, width: number): number {
  if (!Number.isFinite(offset) || !Number.isFinite(width) || width <= 0) {
    throw new Error("The hue-picker geometry is invalid.");
  }
  const ratio = Math.min(1, Math.max(0, offset / width));
  return Math.round(ratio * 359);
}

export function hsvToHex(hue: number, saturation: number, value: number): string {
  const h = normalizeHue(hue);
  const s = clampPercent(saturation) / 100;
  const v = clampPercent(value) / 100;
  const sector = h / 60;
  const index = Math.floor(sector);
  const fraction = sector - index;
  const p = v * (1 - s);
  const q = v * (1 - fraction * s);
  const t = v * (1 - (1 - fraction) * s);
  const channels = [
    [v, t, p],
    [q, v, p],
    [p, v, t],
    [p, q, v],
    [t, p, v],
    [v, p, q],
  ] as const;
  const selected = channels[index];
  if (selected === undefined) {
    throw new Error("The normalized hue is outside the HSV domain.");
  }
  return `#${selected.map(channelToHex).join("")}`;
}

export function hexToHsv(input: string): HsvColor {
  const color = normalizeProjectColor(input).slice(1);
  const red = Number.parseInt(color.slice(0, 2), 16) / 255;
  const green = Number.parseInt(color.slice(2, 4), 16) / 255;
  const blue = Number.parseInt(color.slice(4, 6), 16) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta > 0) {
    if (maximum === red) {
      hue = 60 * (((green - blue) / delta) % 6);
    } else if (maximum === green) {
      hue = 60 * ((blue - red) / delta + 2);
    } else {
      hue = 60 * ((red - green) / delta + 4);
    }
  }
  const roundedHue = Math.round(normalizeHue(hue));
  return {
    h: Math.min(359, roundedHue),
    s: Math.round((maximum === 0 ? 0 : delta / maximum) * 100),
    v: Math.round(maximum * 100),
  };
}

export function normalizeProjectColor(value: unknown): string {
  if (typeof value !== "string" || !/^#[\dA-Fa-f]{6}$/u.test(value)) {
    throw new Error("The project color must use #RRGGBB hexadecimal format.");
  }
  return value.toLowerCase();
}

function normalizeHue(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("The hue must be a finite number.");
  }
  return ((value % 360) + 360) % 360;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("Saturation and value must be finite numbers.");
  }
  return Math.min(100, Math.max(0, value));
}

function channelToHex(value: number): string {
  return Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, "0");
}
