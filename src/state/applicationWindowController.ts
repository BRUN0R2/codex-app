import { type Accessor, createSignal } from "solid-js";

import {
  closeMainWindow,
  isMainWindowMaximized,
  minimizeMainWindow,
  onMainWindowFocusChanged,
  toggleMainWindowMaximize,
} from "../infrastructure/desktopClient";

export interface ApplicationWindowController {
  readonly focusSequence: Accessor<number>;
  readonly maximized: Accessor<boolean>;
  readonly close: () => Promise<boolean>;
  readonly dispose: () => void;
  readonly minimize: () => Promise<boolean>;
  readonly refreshMaximized: () => Promise<boolean>;
  readonly start: () => void;
  readonly toggleMaximize: () => Promise<boolean>;
}

export function createApplicationWindowController(
  reportError: (reason: unknown) => void,
): ApplicationWindowController {
  const [focusSequence, setFocusSequence] = createSignal(0);
  const [maximized, setMaximized] = createSignal(false);
  let disposed = false;
  let started = false;
  let unsubscribeFromFocus: (() => void) | null = null;

  async function refreshMaximized(): Promise<boolean> {
    try {
      const value = await isMainWindowMaximized();
      if (!disposed) setMaximized(value);
      return true;
    } catch (reason) {
      reportFailure("read the window state", reason);
      return false;
    }
  }

  async function run(
    operation: string,
    action: () => Promise<void>,
    refreshAfterward: boolean,
  ): Promise<boolean> {
    try {
      await action();
      return refreshAfterward ? refreshMaximized() : true;
    } catch (reason) {
      reportFailure(operation, reason);
      return false;
    }
  }

  function reportFailure(operation: string, reason: unknown): void {
    reportError(new Error(`Could not ${operation}.`, { cause: reason }));
  }

  function start(): void {
    if (started || disposed) return;
    started = true;
    void refreshMaximized();
    void onMainWindowFocusChanged((focused) => {
      if (focused && !disposed) setFocusSequence((sequence) => sequence + 1);
    })
      .then((unsubscribe) => {
        if (disposed) unsubscribe();
        else unsubscribeFromFocus = unsubscribe;
      })
      .catch((reason: unknown) => reportFailure("track window focus", reason));
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    unsubscribeFromFocus?.();
    unsubscribeFromFocus = null;
  }

  return {
    focusSequence,
    maximized,
    close: () => run("close the window", closeMainWindow, false),
    dispose,
    minimize: () => run("minimize the window", minimizeMainWindow, false),
    refreshMaximized,
    start,
    toggleMaximize: () => run("change the window size", toggleMainWindowMaximize, true),
  };
}
