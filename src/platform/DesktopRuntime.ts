export function isDesktopRuntime(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  // biome-ignore lint/complexity/useLiteralKeys: TypeScript requires bracket access with noPropertyAccessFromIndexSignature.
  if (window.document.documentElement.dataset["runtime"] === "browser-preview") {
    return false;
  }

  const windowWithInternals = window as { __TAURI_INTERNALS__?: unknown };
  return windowWithInternals.__TAURI_INTERNALS__ !== undefined;
}
