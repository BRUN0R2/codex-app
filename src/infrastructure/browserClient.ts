import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  decodeBrowserNewWindowNotification,
  decodeBrowserTabSnapshot,
  decodeOperationAck,
} from "../contracts/decode";
import type {
  BrowserNewWindowNotification,
  BrowserSurfaceBounds,
  BrowserTabSnapshot,
  OperationAck,
} from "../contracts/types";

const BROWSER_STATE_EVENT = "browser://state";
const BROWSER_NEW_WINDOW_EVENT = "browser://new-window";

interface BrowserTabIdentity {
  readonly browserTabId: string;
  readonly conversationId: string;
}

export function createBrowserTab(
  identity: BrowserTabIdentity,
  url: string,
): Promise<BrowserTabSnapshot> {
  return invokeDecoded("browser_tab_create", decodeBrowserTabSnapshot, {
    request: { ...identity, url },
  });
}

export function navigateBrowserTab(
  identity: BrowserTabIdentity,
  url: string,
): Promise<BrowserTabSnapshot> {
  return invokeDecoded("browser_tab_navigate", decodeBrowserTabSnapshot, {
    request: { ...identity, url },
  });
}

export function goBackInBrowserTab(identity: BrowserTabIdentity): Promise<BrowserTabSnapshot> {
  return invokeDecoded("browser_tab_back", decodeBrowserTabSnapshot, { request: identity });
}

export function goForwardInBrowserTab(identity: BrowserTabIdentity): Promise<BrowserTabSnapshot> {
  return invokeDecoded("browser_tab_forward", decodeBrowserTabSnapshot, { request: identity });
}

export function reloadBrowserTab(identity: BrowserTabIdentity): Promise<BrowserTabSnapshot> {
  return invokeDecoded("browser_tab_reload", decodeBrowserTabSnapshot, { request: identity });
}

export function closeBrowserTab(identity: BrowserTabIdentity): Promise<OperationAck> {
  return invokeDecoded("browser_tab_close", decodeOperationAck, { request: identity });
}

export function synchronizeBrowserSurface(input: {
  readonly activeBrowserTabId: string | null;
  readonly bounds: BrowserSurfaceBounds | null;
  readonly conversationId: string | null;
  readonly visible: boolean;
}): Promise<OperationAck> {
  return invokeDecoded("browser_surface_sync", decodeOperationAck, { request: input });
}

export async function listenBrowserState(
  onState: (snapshot: BrowserTabSnapshot) => void,
  onError: (reason: unknown) => void,
): Promise<UnlistenFn> {
  return listen<unknown>(BROWSER_STATE_EVENT, (event) => {
    try {
      onState(decodeBrowserTabSnapshot(event.payload));
    } catch (reason) {
      onError(reason);
    }
  });
}

export async function listenBrowserNewWindow(
  onRequest: (request: BrowserNewWindowNotification) => void,
  onError: (reason: unknown) => void,
): Promise<UnlistenFn> {
  return listen<unknown>(BROWSER_NEW_WINDOW_EVENT, (event) => {
    try {
      onRequest(decodeBrowserNewWindowNotification(event.payload));
    } catch (reason) {
      onError(reason);
    }
  });
}

async function invokeDecoded<T>(
  command: string,
  decode: (value: unknown) => T,
  args: Record<string, unknown>,
): Promise<T> {
  return decode(await invoke<unknown>(command, args));
}
