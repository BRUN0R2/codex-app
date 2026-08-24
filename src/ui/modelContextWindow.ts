import type {
  CodexModel,
  ModelContextWindow,
  ModelContextWindowPreference,
} from "../contracts/types";

const MILLION_TOKEN_THRESHOLD = 1_000_000;
const MILLION_TOKEN_DIVISOR = 1_000_000;
const KILO_TOKEN_DIVISOR = 1_000;

export function modelSupportsMaximumContext(model: CodexModel): boolean {
  const window = model.contextWindow;
  return window !== null && window.maximumTokens !== null && window.maximumTokens > window.tokens;
}

export function modelContextWindowPreference(
  preferences: Readonly<Record<string, ModelContextWindowPreference>>,
  modelId: string,
): ModelContextWindowPreference {
  return preferences[modelId] ?? "default";
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

export function formatModelContextTokens(tokens: number): string {
  if (tokens >= MILLION_TOKEN_THRESHOLD) {
    const value = new Intl.NumberFormat("pt-BR", {
      maximumFractionDigits: tokens % MILLION_TOKEN_DIVISOR === 0 ? 0 : 2,
    }).format(tokens / MILLION_TOKEN_DIVISOR);
    return `${value} mi`;
  }
  const value = new Intl.NumberFormat("pt-BR", {
    maximumFractionDigits: tokens % KILO_TOKEN_DIVISOR === 0 ? 0 : 1,
  }).format(tokens / KILO_TOKEN_DIVISOR);
  return `${value} mil`;
}
