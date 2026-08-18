export function isBrowserPreview(): boolean {
  return (
    typeof window !== "undefined" &&
    window.document.documentElement.getAttribute("data-runtime") === "browser-preview"
  );
}

export function isDesktopRuntime(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  if (isBrowserPreview()) {
    return false;
  }

  const windowWithInternals = window as { __TAURI_INTERNALS__?: unknown };
  return windowWithInternals.__TAURI_INTERNALS__ !== undefined;
}

export function shouldRenderWindowChrome(): boolean {
  if (isDesktopRuntime()) {
    return true;
  }
  return (
    isBrowserPreview() &&
    window.document.documentElement.getAttribute("data-window-chrome-preview") === "true"
  );
}
