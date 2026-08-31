import { afterEach, describe, expect, it } from "vitest";

import { findCatalog, translationCatalogs } from "../i18n/catalog";
import { synchronizeApplicationMenu } from "./desktopClient";
import { installBrowserPreviewRuntime, resetBrowserPreviewRuntime } from "./runtimeBridge";

afterEach(resetBrowserPreviewRuntime);

describe("desktop client", () => {
  it("forwards complete native-menu translations in selection order", async () => {
    const english = findCatalog(translationCatalogs, "en");
    const portuguese = findCatalog(translationCatalogs, "pt-BR");
    if (english === null || portuguese === null) {
      throw new Error("The translation fixtures are unavailable.");
    }

    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const calls: Array<{
      readonly args: Record<string, unknown> | undefined;
      readonly command: string;
    }> = [];
    installBrowserPreviewRuntime(async (command, args) => {
      calls.push({ args, command });
      if (calls.length === 1) await firstGate;
      return undefined;
    });

    const first = synchronizeApplicationMenu(english.messages.nativeMenu);
    const second = synchronizeApplicationMenu(portuguese.messages.nativeMenu);
    await Promise.resolve();
    expect(calls).toEqual([
      {
        args: { translation: english.messages.nativeMenu },
        command: "application_menu_update",
      },
    ]);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(calls).toEqual([
      {
        args: { translation: english.messages.nativeMenu },
        command: "application_menu_update",
      },
      {
        args: { translation: portuguese.messages.nativeMenu },
        command: "application_menu_update",
      },
    ]);
  });
});
