import { invoke as invokeTauri } from "@tauri-apps/api/core";
import { listen as listenTauri, type UnlistenFn } from "@tauri-apps/api/event";

type BrowserPreviewInvokeHandler = (
  command: string,
  args: Record<string, unknown> | undefined,
) => unknown;

interface BrowserPreviewListener {
  readonly id: number;
  readonly receive: (event: RuntimeEvent<unknown>) => void;
}

interface BrowserPreviewRuntime {
  handler: BrowserPreviewInvokeHandler;
  listenerSequence: number;
  readonly listeners: Map<string, BrowserPreviewListener[]>;
}

export interface RuntimeEvent<T> {
  readonly event: string;
  readonly id: number;
  readonly payload: T;
}

let browserPreviewRuntime: BrowserPreviewRuntime | null = null;

export function installBrowserPreviewRuntime(handler: BrowserPreviewInvokeHandler): void {
  browserPreviewRuntime = {
    handler,
    listenerSequence: 0,
    listeners: new Map(),
  };
}

export function hasBrowserPreviewRuntime(): boolean {
  return browserPreviewRuntime !== null;
}

export async function invokeRuntime<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const preview = browserPreviewRuntime;
  if (preview !== null) {
    return (await preview.handler(command, args)) as T;
  }
  return invokeTauri<T>(command, args);
}

export function listenRuntime<T>(
  event: string,
  receive: (event: RuntimeEvent<T>) => void,
): Promise<UnlistenFn> {
  const preview = browserPreviewRuntime;
  if (preview === null) {
    return listenTauri<T>(event, receive);
  }
  preview.listenerSequence += 1;
  const listener: BrowserPreviewListener = {
    id: preview.listenerSequence,
    receive: receive as (event: RuntimeEvent<unknown>) => void,
  };
  const listeners = preview.listeners.get(event);
  if (listeners === undefined) {
    preview.listeners.set(event, [listener]);
  } else {
    listeners.push(listener);
  }
  return Promise.resolve(() => {
    const current = preview.listeners.get(event);
    if (current === undefined) {
      return;
    }
    const next = current.filter((entry) => entry.id !== listener.id);
    if (next.length === 0) {
      preview.listeners.delete(event);
    } else {
      preview.listeners.set(event, next);
    }
  });
}

export function emitBrowserPreviewRuntimeEvent(event: string, payload: unknown): boolean {
  const preview = browserPreviewRuntime;
  if (preview === null) {
    throw new Error("The preview runtime has not been installed yet.");
  }
  const listeners = preview.listeners.get(event) ?? [];
  for (const listener of listeners) {
    listener.receive({ event, id: listener.id, payload });
  }
  return listeners.length > 0;
}

export function resetBrowserPreviewRuntime(): void {
  browserPreviewRuntime = null;
}
