import type { AccountPlanType, PlanPriceSnapshot } from "../contracts/types";
import { formatMessage, type TranslationMessages } from "../i18n/messages";

export function accountPlanName(
  planType: AccountPlanType | null,
  messages: TranslationMessages["account"],
): string {
  switch (planType) {
    case "free":
      return messages.free;
    case "go":
      return messages.go;
    case "plus":
      return messages.plus;
    case "pro":
      return messages.pro;
    case "prolite":
      return messages.prolite;
    case "team":
      return messages.team;
    case "business":
      return messages.business;
    case "edu":
      return messages.education;
    case "ent26":
    case "enterprise":
      return messages.enterprise;
    case "enterprise_cbp_usage_based":
      return messages.enterpriseCredits;
    case "self_serve_business_prolite":
      return messages.businessProLite;
    case "self_serve_business_usage_based":
      return messages.businessCredits;
    case null:
      return messages.chatgpt;
  }
}

export function accountPlanLabel(
  planType: AccountPlanType | null,
  messages: TranslationMessages["account"],
): string {
  return formatMessage(messages.plan, { name: accountPlanName(planType, messages) });
}

export function planPriceLabel(
  price: PlanPriceSnapshot | null,
  locale: string,
  messages: Pick<TranslationMessages["settings"], "perMonth">,
): string | null {
  if (price === null) {
    return null;
  }
  const amount = price.amount / 10 ** price.minorUnitExponent;
  const formattedPrice = new Intl.NumberFormat(locale, {
    style: "currency",
    currency: price.currency,
  }).format(amount);
  return formatMessage(messages.perMonth, { price: formattedPrice });
}
