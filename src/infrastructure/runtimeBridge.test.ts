import { afterEach, describe, expect, it, vi } from "vitest";

import {
  emitBrowserPreviewRuntimeEvent,
  installBrowserPreviewRuntime,
  invokeRuntime,
  listenRuntime,
  resetBrowserPreviewRuntime,
} from "./runtimeBridge";

afterEach(resetBrowserPreviewRuntime);

describe("runtime bridge", () => {
  it("routes preview invocations without touching Tauri internals", async () => {
    const handler = vi.fn((command: string) => ({ command }));
    installBrowserPreviewRuntime(handler);

    await expect(invokeRuntime("engine_start")).resolves.toEqual({ command: "engine_start" });
    expect(handler).toHaveBeenCalledWith("engine_start", undefined);
  });

  it("delivers and removes preview event listeners", async () => {
    installBrowserPreviewRuntime(() => null);
    const listener = vi.fn();
    const unlisten = await listenRuntime("browser://metric", listener);

    expect(emitBrowserPreviewRuntimeEvent("browser://metric", { id: "metric-a" })).toBe(true);
    unlisten();
    expect(emitBrowserPreviewRuntimeEvent("browser://metric", { id: "metric-b" })).toBe(false);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      event: "browser://metric",
      id: 1,
      payload: { id: "metric-a" },
    });
  });
});
