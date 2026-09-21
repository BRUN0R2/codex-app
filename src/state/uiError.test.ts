import { describe, expect, it } from "vitest";

import englishCatalog from "../i18n/locales/en.json";
import portugueseCatalog from "../i18n/locales/pt-BR.json";
import { formatUiError, uiError } from "./uiError";

describe("UI errors", () => {
  it("keeps the translated message when no operational detail exists", () => {
    expect(formatUiError(uiError("loginFailed"), englishCatalog.messages.errors)).toBe(
      "The ChatGPT login did not complete.",
    );
  });

  it("renders the backend login failure detail through the localized prefix", () => {
    const detail = "the local OAuth callback is unavailable on ports 1455 and 1457";

    expect(formatUiError(uiError("loginFailed", detail), englishCatalog.messages.errors)).toBe(
      "The ChatGPT login did not complete. Details: the local OAuth callback is unavailable on ports 1455 and 1457",
    );
    expect(formatUiError(uiError("loginFailed", detail), portugueseCatalog.messages.errors)).toBe(
      "O login do ChatGPT não foi concluído. Detalhes: the local OAuth callback is unavailable on ports 1455 and 1457",
    );
  });

  it("normalizes control characters and bounds dynamic details", () => {
    const error = uiError("unexpected", `  first\nsecond${"x".repeat(600)}  `);

    expect(error.detail).toMatch(/^first secondx+…$/u);
    expect(error.detail).toHaveLength(513);
    expect(uiError("unexpected", "  \n\t  ")).toEqual({ key: "unexpected" });
  });
});
