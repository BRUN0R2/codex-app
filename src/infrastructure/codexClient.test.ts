import { openUrl } from "@tauri-apps/plugin-opener";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openExternalUrl } from "./codexClient";
import { resetBrowserPreviewRuntime } from "./runtimeBridge";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  resetBrowserPreviewRuntime();
});

describe("codex client", () => {
  it("keeps the opener plugin's undefined Promise<void> result as success", async () => {
    vi.mocked(openUrl).mockResolvedValue(undefined);

    await expect(
      openExternalUrl("https://auth.openai.com/oauth/authorize"),
    ).resolves.toBeUndefined();
    expect(openUrl).toHaveBeenCalledWith("https://auth.openai.com/oauth/authorize");
  });
});
