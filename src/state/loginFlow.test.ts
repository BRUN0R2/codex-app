import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createI18nController } from "../i18n/context";
import * as client from "../infrastructure/codexClient";
import {
  emitBrowserPreviewRuntimeEvent,
  resetBrowserPreviewRuntime,
} from "../infrastructure/runtimeBridge";
import { setupBrowserPreview } from "../preview/setupBrowserPreview";
import { createAppController } from "./createAppController";

const LOGIN_ID = "login-1";
const LOGIN_FAILURE = "the local OAuth callback is unavailable on ports 1455 and 1457";

describe("ChatGPT login flow", () => {
  let dispose: (() => void) | undefined;

  beforeEach(() => {
    const values = new Map<string, string>();
    const attributes = new Map<string, string>();
    const document = {
      title: "",
      visibilityState: "visible",
      documentElement: {
        getAttribute: (name: string) => attributes.get(name) ?? null,
        setAttribute: (name: string, value: string) => attributes.set(name, value),
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", {
      document,
      location: { search: "?preview=1" },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      open: vi.fn(),
    });
    vi.stubGlobal("localStorage", {
      get length() {
        return values.size;
      },
      key: (index: number) => [...values.keys()][index] ?? null,
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    setupBrowserPreview();
  });

  afterEach(() => {
    dispose?.();
    resetBrowserPreviewRuntime();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("surfaces the native login failure detail in state and diagnostics", async () => {
    const controller = createRoot((release) => {
      dispose = release;
      const i18n = createI18nController({ languages: ["en"], storage: null });
      return createAppController({
        confirmations: () => i18n.messages().confirmations,
        nativeMenu: () => i18n.messages().nativeMenu,
        notifications: () => i18n.messages().notifications,
      });
    });

    await vi.waitFor(() => expect(controller.engine()).not.toBeNull());
    vi.spyOn(client, "loginWithChatGpt").mockResolvedValue({
      authUrl: "https://auth.openai.com/oauth/authorize?state=test",
      loginId: LOGIN_ID,
      type: "chatgpt",
    });
    vi.spyOn(client, "openExternalUrl").mockResolvedValue();

    await expect(controller.login()).resolves.toBe(true);
    emitBrowserPreviewRuntimeEvent("engine://notification", {
      method: "auth.loginCompleted",
      params: { error: LOGIN_FAILURE, loginId: LOGIN_ID, success: false },
    });

    await vi.waitFor(() => {
      expect(controller.loginPending()).toBe(false);
      expect(controller.error()).toEqual({ key: "loginFailed", detail: LOGIN_FAILURE });
    });
    expect(controller.diagnostics().at(-1)?.message).toBe(LOGIN_FAILURE);
  });
});
