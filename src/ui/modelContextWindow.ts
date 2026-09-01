import type {
  CodexModel,
  ModelContextWindow,
  ModelContextWindowPreference,
} from "../contracts/types";

const MILLION_TOKEN_THRESHOLD = 1_000_000;
const MILLION_TOKEN_DIVISOR = 1_000_000;
const KILO_TOKEN_DIVISOR = 1_000;

export interface ModelContextWindowOption {
  readonly preference: ModelContextWindowPreference;
  readonly tokens: number;
}

export function modelContextWindowPreference(
  preferences: Readonly<Record<string, ModelContextWindowPreference>>,
  modelId: string,
): ModelContextWindowPreference {
  return preferences[modelId] ?? "default";
}

export function modelContextWindowOptions(
  model: CodexModel | undefined,
): readonly ModelContextWindowOption[] {
  const window = model?.contextWindow ?? null;
  const maximum = window?.maximumTokens ?? null;
  if (window === null || maximum === null || maximum <= window.tokens) {
    return [];
  }
  return [
    { preference: "default", tokens: window.tokens },
    { preference: "maximum", tokens: maximum },
  ];
}

export function resolveModelContextWindow(
  model: CodexModel | undefined,
  preference: ModelContextWindowPreference,
): ModelContextWindow | null {
  const window = model?.contextWindow ?? null;
  const maximum = window?.maximumTokens ?? null;
  if (window === null || preference !== "maximum" || maximum === null || maximum <= window.tokens) {
    return window;
  }
  return {
    ...window,
    tokens: maximum,
    usableTokens: Math.floor((maximum * window.usablePercent) / 100),
  };
}

export function formatModelContextTokens(tokens: number, locale: string): string {
  const usesMillions = tokens >= MILLION_TOKEN_THRESHOLD;
  const divisor = usesMillions ? MILLION_TOKEN_DIVISOR : KILO_TOKEN_DIVISOR;
  const maximumFractionDigits = tokens % divisor === 0 ? 0 : usesMillions ? 2 : 1;
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits,
    notation: "compact",
  }).format(tokens);
}
