import { describe, expect, it } from "vitest";

import { findCatalog, translationCatalogs } from "../i18n/catalog";
import { outputDetailLabel } from "./outputDetail";

const english = findCatalog(translationCatalogs, "en")?.messages.settings;
if (english === undefined) throw new Error("The English translation catalog is unavailable.");

describe("output detail options", () => {
  it("uses the model default label when no override is selected", () => {
    expect(outputDetailLabel(null, english)).toBe("Model default");
    expect(outputDetailLabel("low", english)).toBe("Low");
    expect(outputDetailLabel("medium", english)).toBe("Medium");
    expect(outputDetailLabel("high", english)).toBe("High");
  });
});
