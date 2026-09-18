import type { PlanPriceSnapshot } from "../contracts/types";

export function formatPlanPriceAmount(price: PlanPriceSnapshot, locale: string): string {
  const amount = price.amount / 10 ** price.minorUnitExponent;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: price.currency,
  }).format(amount);
}
