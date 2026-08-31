import type { ModelVerbosity } from "../contracts/types";
import type { TranslationMessages } from "../i18n/messages";

export interface OutputDetailOption {
  readonly description: string | null;
  readonly label: string;
  readonly value: ModelVerbosity | null;
}

type OutputDetailMessages = Pick<
  TranslationMessages["settings"],
  | "outputDefault"
  | "outputHigh"
  | "outputHighDescription"
  | "outputLow"
  | "outputLowDescription"
  | "outputMedium"
  | "outputMediumDescription"
>;

export function outputDetailOptions(messages: OutputDetailMessages): readonly OutputDetailOption[] {
  return [
    {
      value: null,
      label: messages.outputDefault,
      description: null,
    },
    {
      value: "low",
      label: messages.outputLow,
      description: messages.outputLowDescription,
    },
    {
      value: "medium",
      label: messages.outputMedium,
      description: messages.outputMediumDescription,
    },
    {
      value: "high",
      label: messages.outputHigh,
      description: messages.outputHighDescription,
    },
  ];
}

export function outputDetailLabel(
  value: ModelVerbosity | null,
  messages: OutputDetailMessages,
): string {
  return (
    outputDetailOptions(messages).find((option) => option.value === value)?.label ??
    messages.outputDefault
  );
}
