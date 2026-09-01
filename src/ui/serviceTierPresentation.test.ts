import { describe, expect, it } from "vitest";

import type { ModelServiceTier } from "../contracts/types";
import { findCatalog, translationCatalogs } from "../i18n/catalog";
import { presentServiceTier, selectedServiceTierLabel } from "./serviceTierPresentation";

const english = findCatalog(translationCatalogs, "en")?.messages.composer;
const portuguese = findCatalog(translationCatalogs, "pt-BR")?.messages.composer;
if (english === undefined || portuguese === undefined) {
  throw new Error("The service-tier translation catalogs are unavailable.");
}

const PRIORITY_TIER = {
  id: "priority",
  name: "Fast",
  description: "1.5x speed, increased usage",
} as const satisfies ModelServiceTier;

describe("service-tier presentation", () => {
  it("localizes the canonical and legacy fast-tier identifiers", () => {
    expect(presentServiceTier(PRIORITY_TIER, portuguese)).toEqual({
      name: "Rápido",
      description: "Velocidade 1,5x, mais uso",
    });
    expect(presentServiceTier({ ...PRIORITY_TIER, id: "fast" }, portuguese)).toEqual({
      name: "Rápido",
      description: "Velocidade 1,5x, mais uso",
    });
    expect(presentServiceTier(PRIORITY_TIER, english)).toEqual({
      name: "Fast",
      description: "1.5x speed, increased usage",
    });
  });

  it("localizes the distinct ultrafast tier", () => {
    expect(
      presentServiceTier(
        {
          id: "ultrafast",
          name: "Ultrafast",
          description: "The fastest available responses for latency-sensitive work.",
        },
        portuguese,
      ),
    ).toEqual({
      name: "Ultrarrápido",
      description: "As respostas mais rápidas disponíveis para trabalhos sensíveis à latência.",
    });
  });

  it("preserves explicit catalog metadata for future tiers", () => {
    const futureTier = {
      id: "future-tier",
      name: "Future tier",
      description: "Provider-defined behavior.",
    } as const satisfies ModelServiceTier;

    expect(presentServiceTier(futureTier, portuguese)).toEqual({
      name: futureTier.name,
      description: futureTier.description,
    });
    expect(selectedServiceTierLabel([futureTier], futureTier.id, portuguese)).toBe(futureTier.name);
    expect(selectedServiceTierLabel([], futureTier.id, portuguese)).toBe(futureTier.id);
    expect(selectedServiceTierLabel([], null, portuguese)).toBe("Padrão");
  });
});
