import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";

import { createI18nController } from "./context";

describe("i18n controller", () => {
  it("auto-detects the closest available system language by default", () => {
    createRoot((dispose) => {
      const controller = createI18nController({ languages: ["pt-PT"], storage: null });

      expect(controller.preference()).toBe("auto");
      expect(controller.locale()).toBe("pt-BR");
      expect(controller.messages().app.retry).toBe("Tentar novamente");
      dispose();
    });
  });

  it("persists an explicit locale and updates messages reactively", () => {
    const values = new Map<string, string>();
    createRoot((dispose) => {
      const controller = createI18nController({
        languages: ["en-US"],
        storage: {
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => values.set(key, value),
        },
      });

      controller.setPreference("pt-BR" as ReturnType<typeof controller.locale>);

      expect(controller.preference()).toBe("pt-BR");
      expect(controller.messages().app.retry).toBe("Tentar novamente");
      expect([...values.values()]).toEqual(["pt-BR"]);
      expect(controller.storageIssue()).toBeNull();
      dispose();
    });
  });

  it("reports invalid persisted values and storage failures explicitly", () => {
    createRoot((dispose) => {
      const invalid = createI18nController({
        languages: ["en"],
        storage: { getItem: () => "fr", setItem: () => undefined },
      });
      expect(invalid.preference()).toBe("auto");
      expect(invalid.storageIssue()).toBe("unsupportedPreference");

      const unreadable = createI18nController({
        languages: ["en"],
        storage: {
          getItem: () => {
            throw new Error("denied");
          },
          setItem: () => undefined,
        },
      });
      expect(unreadable.storageIssue()).toBe("readFailure");

      const unwritable = createI18nController({
        languages: ["en"],
        storage: {
          getItem: () => null,
          setItem: () => {
            throw new Error("denied");
          },
        },
      });
      unwritable.setPreference("en" as ReturnType<typeof unwritable.locale>);
      expect(unwritable.storageIssue()).toBe("writeFailure");
      dispose();
    });
  });
});
