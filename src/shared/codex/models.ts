import type {
  CodexModel,
  ConfigReadResponse,
  ReasoningEffortOption,
} from "./types";

const FALLBACK_REASONING_EFFORTS: ReasoningEffortOption[] = [
  { reasoningEffort: "minimal", description: "Resposta mais rápida" },
  { reasoningEffort: "low", description: "Raciocínio leve" },
  { reasoningEffort: "medium", description: "Equilíbrio entre velocidade e profundidade" },
  { reasoningEffort: "high", description: "Raciocínio aprofundado" },
  { reasoningEffort: "xhigh", description: "Profundidade ampliada" },
  { reasoningEffort: "max", description: "Máximo suportado pelo modelo" },
  { reasoningEffort: "ultra", description: "Ultra, quando disponível" },
];

export function configString(
  config: ConfigReadResponse | null,
  key: string,
): string | null {
  const value = config?.config[key];
  return typeof value === "string" ? value : null;
}

export function configuredModel(
  config: ConfigReadResponse | null,
  models: CodexModel[],
): CodexModel | null {
  const configured = configString(config, "model");
  if (configured !== null) {
    const exact = models.find(
      (model) => model.model === configured || model.id === configured,
    );
    if (exact !== undefined) {
      return exact;
    }
  }
  return models.find((model) => model.isDefault) ?? models[0] ?? null;
}

export function configuredReasoningEffort(
  config: ConfigReadResponse | null,
  model: CodexModel | null,
): string {
  return (
    configString(config, "model_reasoning_effort") ??
    model?.defaultReasoningEffort ??
    "medium"
  );
}

export function configuredServiceTier(
  config: ConfigReadResponse | null,
  model: CodexModel | null,
): string | null {
  const value = configString(config, "service_tier") ?? model?.defaultServiceTier ?? null;
  return value === "default" ? null : value;
}

export function reasoningEfforts(model: CodexModel | null): ReasoningEffortOption[] {
  return model?.supportedReasoningEfforts.length
    ? model.supportedReasoningEfforts
    : FALLBACK_REASONING_EFFORTS;
}

export function accessModeLabel(config: ConfigReadResponse | null): string {
  if (config === null) {
    return "Permissões";
  }
  switch (configuredPermissionPreset(config)) {
    case "full-access":
      return "Acesso completo";
    case "approve-for-me":
      return "Aprovar por mim";
    default:
      return "Personalizado";
  }
}

export type PermissionPreset = "approve-for-me" | "custom" | "full-access";

export function configuredPermissionPreset(
  config: ConfigReadResponse | null,
): PermissionPreset {
  const sandboxMode = configString(config, "sandbox_mode");
  const approvalPolicy = configString(config, "approval_policy");
  if (sandboxMode === "danger-full-access" && approvalPolicy === "never") {
    return "full-access";
  }
  if (sandboxMode === "workspace-write" && approvalPolicy === "on-request") {
    return "approve-for-me";
  }
  return "custom";
}

export function reasoningLabel(value: string): string {
  switch (value) {
    case "none":
      return "Sem raciocínio";
    case "minimal":
      return "Mínimo";
    case "low":
      return "Leve";
    case "medium":
      return "Médio";
    case "high":
      return "Alto";
    case "xhigh":
      return "Extra alto";
    case "max":
      return "Máximo";
    case "ultra":
      return "Ultra";
    default:
      return value;
  }
}

export function serviceTierLabel(
  value: string | null,
  model: CodexModel | null,
): string {
  if (value === null) {
    return "Padrão";
  }
  if (value === "fast" || value === "priority") {
    return "Rápido";
  }
  const tier = model?.serviceTiers?.find((candidate) => candidate.id === value);
  if (tier?.name.toLowerCase() === "fast") {
    return "Rápido";
  }
  return tier?.name ?? value;
}

export function compactModelName(value: string): string {
  return value.replace(/^GPT-/i, "").replaceAll("-", " ");
}
