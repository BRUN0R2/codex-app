import { describe, expect, it } from "vitest";

import { findCatalog, translationCatalogs } from "../i18n/catalog";
import { previewCurrentPlanPrice } from "../preview/accountUsageFixtures";
import { planPriceLabel } from "./accountPresentation";

const english = findCatalog(translationCatalogs, "en")?.messages.settings;
const portuguese = findCatalog(translationCatalogs, "pt-BR")?.messages.settings;
if (english === undefined) throw new Error("The English translation catalog is unavailable.");
if (portuguese === undefined) {
  throw new Error("The Portuguese translation catalog is unavailable.");
}

describe("plan price labels", () => {
  it("formats localized monthly prices with a spaced period suffix", () => {
    const plus = {
      planType: "plus" as const,
      amount: 9_990,
      currency: "BRL",
      minorUnitExponent: 2,
    };

    expect(planPriceLabel(plus, "en", english)?.endsWith(" / month")).toBe(true);
    expect(planPriceLabel(plus, "pt-BR", portuguese)?.endsWith(" / mês")).toBe(true);
    expect(planPriceLabel(plus, "en", english)).toContain("99.90");
    expect(planPriceLabel(plus, "pt-BR", portuguese)).toContain("99,90");
    expect(planPriceLabel(null, "en", english)).toBeNull();
  });

  it("formats the preview current plan with the Portuguese monthly suffix", () => {
    const label = planPriceLabel(previewCurrentPlanPrice(), "pt-BR", portuguese);
    expect(label).toContain("999,90");
    expect(label?.endsWith(" / mês")).toBe(true);
    expect(portuguese.perMonth).toBe("{price} / mês");
  });
});
