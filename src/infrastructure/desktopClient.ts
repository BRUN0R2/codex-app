import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { listenRuntime as listen } from "./runtimeBridge";

const MENU_NEW_THREAD_EVENT = "menu:new-thread";
const MENU_SETTINGS_EVENT = "menu:settings";
const MENU_TOGGLE_SIDEBAR_EVENT = "menu:toggle-sidebar";

export interface MenuEventHandlers {
  readonly onNewThread: () => void;
  readonly onToggleSettings: () => void;
  readonly onToggleSidebar: () => void;
}

export async function subscribeToMenuEvents(handlers: MenuEventHandlers): Promise<() => void> {
  const activeUnlisteners: UnlistenFn[] = [];
  let disposed = false;

  function registerUnlistener(unlisten: UnlistenFn): void {
    if (disposed) {
      unlisten();
      return;
    }
    activeUnlisteners.push(unlisten);
  }

  function disposeActiveUnlisteners(): void {
    disposed = true;
    while (activeUnlisteners.length > 0) {
      activeUnlisteners.pop()?.();
    }
  }

  try {
    registerUnlistener(await listen(MENU_NEW_THREAD_EVENT, () => handlers.onNewThread()));
    registerUnlistener(await listen(MENU_SETTINGS_EVENT, () => handlers.onToggleSettings()));
    registerUnlistener(await listen(MENU_TOGGLE_SIDEBAR_EVENT, () => handlers.onToggleSidebar()));
  } catch (reason) {
    disposeActiveUnlisteners();
    throw asError(reason, "Não foi possível registrar os eventos do menu.");
  }
  return disposeActiveUnlisteners;
}

export async function isMainWindowMaximized(): Promise<boolean> {
  return getCurrentWindow().isMaximized();
}

export function onMainWindowFocusChanged(handler: (focused: boolean) => void): Promise<() => void> {
  return getCurrentWindow().onFocusChanged(({ payload: focused }) => handler(focused));
}

export async function minimizeMainWindow(): Promise<void> {
  await getCurrentWindow().minimize();
}

export async function toggleMainWindowMaximize(): Promise<void> {
  await getCurrentWindow().toggleMaximize();
}

export async function closeMainWindow(): Promise<void> {
  await getCurrentWindow().close();
}

function asError(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback);
}
