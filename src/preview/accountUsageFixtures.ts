import type { AccountPlanType, PlanPriceSnapshot } from "../contracts/types";

export const PREVIEW_PLAN_TYPE = "pro" satisfies AccountPlanType;

export const PREVIEW_PLAN_PRICES = [
  { planType: "go", amount: 3_999, currency: "BRL", minorUnitExponent: 2 },
  { planType: "plus", amount: 9_990, currency: "BRL", minorUnitExponent: 2 },
  { planType: "prolite", amount: 52_500, currency: "BRL", minorUnitExponent: 2 },
  { planType: "pro", amount: 99_990, currency: "BRL", minorUnitExponent: 2 },
] as const satisfies readonly PlanPriceSnapshot[];

export function previewCurrentPlanPrice(): PlanPriceSnapshot {
  const price = PREVIEW_PLAN_PRICES.find((item) => item.planType === PREVIEW_PLAN_TYPE);
  if (price === undefined) {
    throw new Error("The preview catalog is missing the current plan price.");
  }
  return price;
}
