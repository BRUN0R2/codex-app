import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BrowserTabSnapshot } from "../contracts/types";
import {
  loadPersistedBrowserConversations,
  savePersistedBrowserConversations,
} from "./browserPersistence";

const browserMocks = vi.hoisted(() => ({
  closeBrowserTab: vi.fn().mockResolvedValue({ applied: true }),
  createBrowserTab: vi.fn(),
  onThreadDeleted: null as ((threadId: string) => void) | null,
  synchronizeBrowserSurface: vi.fn().mockResolvedValue({ applied: true }),
}));

vi.mock("../infrastructure/browserClient", () => ({
  closeBrowserTab: browserMocks.closeBrowserTab,
  createBrowserTab: browserMocks.createBrowserTab,
  goBackInBrowserTab: vi.fn(),
  goForwardInBrowserTab: vi.fn(),
  listenBrowserAgentActivity: vi.fn().mockResolvedValue(() => {}),
  listenBrowserMetric: vi.fn().mockResolvedValue(() => {}),
  listenBrowserNewWindow: vi.fn().mockResolvedValue(() => {}),
  listenBrowserState: vi.fn().mockResolvedValue(() => {}),
  listenThreadDeleted: vi.fn((onDeleted: (threadId: string) => void) => {
    browserMocks.onThreadDeleted = onDeleted;
    return Promise.resolve(() => {});
  }),
  navigateBrowserTab: vi.fn(),
  reloadBrowserTab: vi.fn(),
  setBrowserViewport: vi.fn(),
  synchronizeBrowserSurface: browserMocks.synchronizeBrowserSurface,
}));

import { createBrowserController } from "./browserController";

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

describe("browser native-tab single flight", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: new MemoryStorage(),
    });
    browserMocks.createBrowserTab.mockReset();
    browserMocks.closeBrowserTab.mockClear();
    browserMocks.onThreadDeleted = null;
    browserMocks.synchronizeBrowserSurface.mockClear();
  });

  it("creates one native tab when restore, selection, and surface sync race", async () => {
    const snapshot: BrowserTabSnapshot = {
      browserTabId: "tab-a",
      conversationId: "conversation-a",
      url: "https://example.com/",
      title: "Example",
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      viewport: null,
    };
    savePersistedBrowserConversations([
      {
        activeBrowserTabId: snapshot.browserTabId,
        conversationId: snapshot.conversationId,
        tabs: [{ browserTabId: snapshot.browserTabId, url: snapshot.url }],
      },
    ]);
    let completeCreation: ((value: BrowserTabSnapshot) => void) | undefined;
    browserMocks.createBrowserTab.mockImplementation(
      () =>
        new Promise<BrowserTabSnapshot>((resolve) => {
          completeCreation = resolve;
        }),
    );
    const errors: unknown[] = [];
    const controller = createBrowserController((reason) => errors.push(reason));

    const initialization = controller.ensureConversation(snapshot.conversationId);
    const selection = controller.selectTab(snapshot.conversationId, snapshot.browserTabId);
    const surface = controller.synchronizeSurface({
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      conversationId: snapshot.conversationId,
      visible: true,
    });
    await Promise.resolve();

    expect(browserMocks.createBrowserTab).toHaveBeenCalledTimes(1);
    completeCreation?.(snapshot);
    await expect(Promise.all([initialization, selection, surface])).resolves.toEqual([
      true,
      true,
      true,
    ]);
    expect(errors).toEqual([]);
  });

  it("does not count persisted tabs from other tasks against the current task", async () => {
    savePersistedBrowserConversations(
      ["conversation-a", "conversation-b"].map((conversationId, conversationIndex) => ({
        conversationId,
        activeBrowserTabId: `tab-${conversationIndex}-0`,
        tabs: Array.from({ length: 8 }, (_, tabIndex) => ({
          browserTabId: `tab-${conversationIndex}-${tabIndex}`,
          url: "about:blank",
        })),
      })),
    );
    browserMocks.createBrowserTab.mockImplementation(
      (identity: { browserTabId: string; conversationId: string }, url: string) =>
        Promise.resolve(browserSnapshot(identity.browserTabId, identity.conversationId, url)),
    );
    const errors: unknown[] = [];
    const controller = createBrowserController((reason) => errors.push(reason));

    await expect(controller.newTab("conversation-a")).resolves.toBe(true);

    expect(controller.tabs("conversation-a")).toHaveLength(9);
    expect(controller.tabs("conversation-b")).toHaveLength(8);
    expect(errors).toEqual([]);
  });

  it("releases native tabs and persisted topology when its task is deleted", async () => {
    savePersistedBrowserConversations([
      {
        activeBrowserTabId: "tab-a",
        conversationId: "conversation-a",
        tabs: [{ browserTabId: "tab-a", url: "https://example.com/" }],
      },
    ]);
    browserMocks.createBrowserTab.mockResolvedValue(
      browserSnapshot("tab-a", "conversation-a", "https://example.com/"),
    );
    const errors: unknown[] = [];
    const controller = createBrowserController((reason) => errors.push(reason));
    controller.start();
    await controller.ensureConversation("conversation-a");
    await Promise.resolve();

    browserMocks.onThreadDeleted?.("conversation-a");

    await vi.waitFor(() => {
      expect(controller.tabs("conversation-a")).toEqual([]);
      expect(browserMocks.closeBrowserTab).toHaveBeenCalledWith({
        browserTabId: "tab-a",
        conversationId: "conversation-a",
      });
    });
    expect(loadPersistedBrowserConversations()).toEqual({ conversations: [], error: null });
    expect(errors).toEqual([]);
  });
});

function browserSnapshot(
  browserTabId: string,
  conversationId: string,
  url: string,
): BrowserTabSnapshot {
  return {
    browserTabId,
    conversationId,
    url,
    title: null,
    canGoBack: false,
    canGoForward: false,
    isLoading: false,
    viewport: null,
  };
}
