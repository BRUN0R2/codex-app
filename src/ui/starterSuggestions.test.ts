import { describe, expect, it } from "vitest";

import { findCatalog, translationCatalogs } from "../i18n/catalog";
import { starterSuggestions } from "./starterSuggestions";

const messages = findCatalog(translationCatalogs, "en")?.messages.timeline;
if (messages === undefined) throw new Error("The English translation catalog is unavailable.");

describe("starter suggestion icon colors", () => {
  it("keeps the requested color sequence on the four starter cards", () => {
    expect(starterSuggestions(messages).map(({ icon, iconColor }) => [icon, iconColor])).toEqual([
      ["telescope", "#2563eb"],
      ["hammer", "#a855f7"],
      ["syncCheck", "#16a34a"],
      ["bug", "#f97316"],
    ]);
  });
});
