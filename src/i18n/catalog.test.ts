import { describe, expect, it } from "vitest";

import { decodeTranslationCatalogs, resolveCatalog, translationCatalogs } from "./catalog";
import { formatMessage } from "./messages";

describe("translation catalogs", () => {
  it("discovers complete JSON catalogs and orders them deterministically", () => {
    expect(translationCatalogs.map((catalog) => catalog.locale)).toEqual(["en", "pt-BR"]);
    expect(translationCatalogs.map((catalog) => catalog.name)).toEqual([
      "English",
      "Português (Brasil)",
    ]);
    expect(Object.isFrozen(translationCatalogs)).toBe(true);
  });

  it("resolves exact, language-family, and default matches", () => {
    expect(resolveCatalog(translationCatalogs, ["pt-BR"]).locale).toBe("pt-BR");
    expect(resolveCatalog(translationCatalogs, ["pt-PT"]).locale).toBe("pt-BR");
    expect(resolveCatalog(translationCatalogs, ["invalid_locale", "fr-FR"]).locale).toBe("en");
  });

  it("rejects missing messages instead of falling back silently", () => {
    const english = structuredClone(translationCatalogs.find((catalog) => catalog.locale === "en"));
    const portuguese = structuredClone(
      translationCatalogs.find((catalog) => catalog.locale === "pt-BR"),
    );
    if (english === undefined) throw new Error("English test catalog is unavailable.");
    if (portuguese === undefined) throw new Error("Portuguese test catalog is unavailable.");
    const messages = portuguese.messages as Partial<typeof portuguese.messages>;
    delete messages.language;

    expect(() =>
      decodeTranslationCatalogs({
        "./locales/en.json": english,
        "./locales/pt-BR.json": portuguese,
      }),
    ).toThrow(/must contain exactly/u);
  });

  it("requires the catalog locale to match its file name", () => {
    const english = structuredClone(translationCatalogs.find((catalog) => catalog.locale === "en"));
    if (english === undefined) throw new Error("English test catalog is unavailable.");

    expect(() => decodeTranslationCatalogs({ "./locales/fr.json": english })).toThrow(
      /must match its file name/u,
    );
  });

  it("formats only an exact placeholder set", () => {
    expect(formatMessage("Delete {name}?", { name: "Project" })).toBe("Delete Project?");
    expect(() => formatMessage("Delete {name}?", {})).toThrow(/placeholders/u);
    expect(() => formatMessage("Ready", { name: "Project" })).toThrow(/placeholders/u);
  });
});
