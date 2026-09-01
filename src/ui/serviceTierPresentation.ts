import type { ModelServiceTier } from "../contracts/types";
import type { TranslationMessages } from "../i18n/messages";

type ServiceTierMessages = Pick<
  TranslationMessages["composer"],
  "default" | "speedFast" | "speedFastDescription" | "speedUltrafast" | "speedUltrafastDescription"
>;

export interface ServiceTierPresentation {
  readonly description: string;
  readonly name: string;
}

export function presentServiceTier(
  tier: ModelServiceTier,
  messages: ServiceTierMessages,
): ServiceTierPresentation {
  switch (tier.id) {
    case "fast":
    case "priority":
      return {
        description: messages.speedFastDescription,
        name: messages.speedFast,
      };
    case "ultrafast":
      return {
        description: messages.speedUltrafastDescription,
        name: messages.speedUltrafast,
      };
    default:
      return {
        description: tier.description,
        name: tier.name,
      };
  }
}

export function selectedServiceTierLabel(
  tiers: readonly ModelServiceTier[],
  selectedTierId: string | null,
  messages: ServiceTierMessages,
): string {
  if (selectedTierId === null) {
    return messages.default;
  }
  const selectedTier = tiers.find((tier) => tier.id === selectedTierId);
  return selectedTier === undefined
    ? selectedTierId
    : presentServiceTier(selectedTier, messages).name;
}
