import type { IconName } from "../contracts/iconNames";
import type { TranslationMessages } from "../i18n/messages";

export interface StarterSuggestion {
  readonly icon: IconName;
  readonly iconColor: string;
  readonly label: string;
  readonly prompt: string;
}

export function starterSuggestions(
  messages: TranslationMessages["timeline"],
): readonly StarterSuggestion[] {
  return [
    {
      icon: "telescope",
      iconColor: "#2563eb",
      label: messages.suggestExploreLabel,
      prompt: messages.suggestExplorePrompt,
    },
    {
      icon: "hammer",
      iconColor: "#a855f7",
      label: messages.suggestBuildLabel,
      prompt: messages.suggestBuildPrompt,
    },
    {
      icon: "syncCheck",
      iconColor: "#16a34a",
      label: messages.suggestReviewLabel,
      prompt: messages.suggestReviewPrompt,
    },
    {
      icon: "bug",
      iconColor: "#f97316",
      label: messages.suggestFixLabel,
      prompt: messages.suggestFixPrompt,
    },
  ];
}
