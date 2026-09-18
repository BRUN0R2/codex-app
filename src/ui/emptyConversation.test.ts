import { describe, expect, it } from "vitest";

import { findCatalog, translationCatalogs } from "../i18n/catalog";
import { emptyConversationTitle } from "./emptyConversation";
import { starterSuggestions } from "./starterSuggestions";

const english = findCatalog(translationCatalogs, "en")?.messages.timeline;
const portuguese = findCatalog(translationCatalogs, "pt-BR")?.messages.timeline;
if (english === undefined) throw new Error("The English translation catalog is unavailable.");
if (portuguese === undefined) {
  throw new Error("The Portuguese translation catalog is unavailable.");
}

describe("empty conversation copy", () => {
  it("derives the heading and starter cards from the same active catalog", () => {
    expect(emptyConversationTitle("codex", "C:\\Users\\bruno\\cometa-app", english)).toBe(
      "What should we work on in cometa-app?",
    );
    expect(starterSuggestions(english).map((suggestion) => suggestion.label)).toEqual([
      "Explore and understand code",
      "Build a new feature, application, or tool",
      "Review code and suggest changes",
      "Fix problems and failures",
    ]);

    expect(emptyConversationTitle("codex", "C:\\Users\\bruno\\cometa-app", portuguese)).toBe(
      "Em que devemos trabalhar em cometa-app?",
    );
    expect(starterSuggestions(portuguese).map((suggestion) => suggestion.label)).toEqual([
      "Explore e entenda código",
      "Crie um novo recurso, aplicativo ou ferramenta",
      "Revisar código e sugerir mudanças",
      "Corrigir problemas e falhas",
    ]);
  });

  it("keeps chat and work headings on the active catalog without a workspace", () => {
    expect(emptyConversationTitle("chat", null, english)).toBe("Ready when you are.");
    expect(emptyConversationTitle("work", null, english)).toBe("What should we work on?");
    expect(emptyConversationTitle("codex", null, english)).toBe("What should we work on today?");
    expect(emptyConversationTitle("chat", null, portuguese)).toBe("Pronto quando você quiser.");
    expect(emptyConversationTitle("work", null, portuguese)).toBe("No que devemos trabalhar?");
    expect(emptyConversationTitle("codex", null, portuguese)).toBe("Em que vamos trabalhar hoje?");
  });
});
