import { describe, expect, it } from "vitest";

import { hasForbiddenPresentationImport } from "./presentationBoundary";

describe("presentation boundary scanner", () => {
  it("rejects every IPC import form", () => {
    for (const source of [
      'import { invoke } from "@tauri-apps/api/core";',
      'import "@tauri-apps/plugin-opener";',
      'import type { Client } from "../infrastructure/codexClient";',
      'const client = await import("../infrastructure/codexClient");',
      'export { readAccount } from "../infrastructure/codexClient";',
    ]) {
      expect(hasForbiddenPresentationImport(source)).toBe(true);
    }
  });

  it("allows presentation imports that do not cross the native boundary", () => {
    for (const source of [
      'import { useI18n } from "../i18n/context";',
      'import type { AppController } from "../state/appController";',
      'import { Icon } from "./Icon";',
    ]) {
      expect(hasForbiddenPresentationImport(source)).toBe(false);
    }
  });
});
