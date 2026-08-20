import type {
  CodexModel,
  ModelContextWindow,
  ModelContextWindowPreference,
} from "../contracts/types";

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
  if (tokens >= 1_000_000) {
    const value = new Intl.NumberFormat("pt-BR", {
      maximumFractionDigits: tokens % 1_000_000 === 0 ? 0 : 2,
    }).format(tokens / 1_000_000);
    return `${value} mi`;
  }
  const value = new Intl.NumberFormat("pt-BR", {
    maximumFractionDigits: tokens % 1_000 === 0 ? 0 : 1,
  }).format(tokens / 1_000);
  return `${value} mil`;
}
