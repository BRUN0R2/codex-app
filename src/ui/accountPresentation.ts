import type { AccountPlanType } from "../contracts/types";
import { formatMessage, type TranslationMessages } from "../i18n/messages";

export function accountPlanName(
  planType: AccountPlanType | null,
  messages: TranslationMessages["account"],
): string {
  switch (planType) {
    case "free":
      return messages.free;
    case "go":
      return "Go";
    case "plus":
      return "Plus";
    case "pro":
      return "Pro";
    case "prolite":
      return "Pro Lite";
    case "team":
      return "Team";
    case "business":
      return "Business";
    case "edu":
      return "Education";
    case "ent26":
    case "enterprise":
      return "Enterprise";
    case "enterprise_cbp_usage_based":
      return messages.enterpriseCredits;
    case "self_serve_business_prolite":
      return "Business Pro Lite";
    case "self_serve_business_usage_based":
      return messages.businessCredits;
    case null:
      return "ChatGPT";
  }
}

export function accountPlanLabel(
  planType: AccountPlanType | null,
  messages: TranslationMessages["account"],
): string {
  return formatMessage(messages.plan, { name: accountPlanName(planType, messages) });
}
