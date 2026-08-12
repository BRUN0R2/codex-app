import type { ModelVerbosity } from "../contracts/types";

export interface OutputDetailOption {
  readonly description: string | null;
  readonly label: string;
  readonly value: ModelVerbosity | null;
}

const DEFAULT_OUTPUT_DETAIL_LABEL = "Padrão do modelo";

export const OUTPUT_DETAIL_OPTIONS: readonly OutputDetailOption[] = [
  {
    value: null,
    label: DEFAULT_OUTPUT_DETAIL_LABEL,
    description: null,
  },
  {
    value: "low",
    label: "Baixo",
    description: "Mantenha as respostas concisas",
  },
  {
    value: "medium",
    label: "Médio",
    description: "Equilibre detalhamento e concisão",
  },
  {
    value: "high",
    label: "Alto",
    description: "Inclua mais detalhes nas respostas",
  },
];

export function outputDetailLabel(value: ModelVerbosity | null): string {
  return (
    OUTPUT_DETAIL_OPTIONS.find((option) => option.value === value)?.label ??
    DEFAULT_OUTPUT_DETAIL_LABEL
  );
}
