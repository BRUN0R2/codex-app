import type { CodexModel, ReasoningEffort } from "../contracts/types";

export function reasoningEffortIsRuntimeCompatible(
  model: CodexModel | undefined,
  effort: ReasoningEffort,
): boolean {
  return (
    model !== undefined &&
    !model.unsupportedReasoningEfforts.includes(effort) &&
    model.supportedReasoningEfforts.some((option) => option.reasoningEffort === effort)
  );
}

export function selectRuntimeCompatibleModel(
  models: readonly CodexModel[],
  requested: string | null,
  fallback: string | null,
): CodexModel | undefined {
  for (const id of [requested, fallback]) {
    const candidate = id === null ? undefined : models.find((model) => model.id === id);
    if (candidate !== undefined) {
      return candidate;
    }
  }

  return models.find((model) => model.isDefault) ?? models[0];
}

export function selectRuntimeCompatibleReasoningEffort(
  model: CodexModel | undefined,
  requested: ReasoningEffort | null,
): ReasoningEffort | null {
  if (requested !== null && reasoningEffortIsRuntimeCompatible(model, requested)) {
    return requested;
  }

  const defaultEffort = model?.defaultReasoningEffort ?? null;
  return defaultEffort !== null && reasoningEffortIsRuntimeCompatible(model, defaultEffort)
    ? defaultEffort
    : null;
}

export function selectRuntimeCompatibleServiceTier(
  model: CodexModel | undefined,
  requested: string | null,
): string | null {
  if (requested !== null && model?.serviceTiers.some((tier) => tier.id === requested) === true) {
    return requested;
  }
  return model?.defaultServiceTier ?? null;
}
