import { describe, expect, it } from "vitest";

import {
  activeWorkspaceTab,
  browserWorkspaceTabId,
  closeWorkspaceTab,
  emptyWorkspaceTabsState,
  hideWorkspaceTabs,
  reconcileBrowserWorkspaceTabs,
  removeReviewWorkspaceTab,
  showBrowserWorkspaceTab,
  showEmptyWorkspace,
  showReviewWorkspaceTab,
} from "./workspaceTabs";

describe("workspace tabs", () => {
  it("reconciles native browser topology without recreating stable tabs", () => {
    const initial = reconcileBrowserWorkspaceTabs(emptyWorkspaceTabsState(), {
      activeBrowserTabId: "one",
      browserTabIds: ["one", "two"],
      conversationId: "thread-1",
    });
    const withReview = showReviewWorkspaceTab(initial);
    const reconciled = reconcileBrowserWorkspaceTabs(withReview, {
      activeBrowserTabId: "three",
      browserTabIds: ["two", "three"],
      conversationId: "thread-1",
    });

    expect(reconciled.tabs.map(({ id }) => id)).toEqual([
      browserWorkspaceTabId("two"),
      "review",
      browserWorkspaceTabId("three"),
    ]);
    expect(activeWorkspaceTab(reconciled)?.kind).toBe("review");
    expect(reconciled.visible).toBe(true);
  });

  it("isolates tab state when the active conversation changes", () => {
    const first = showReviewWorkspaceTab(
      reconcileBrowserWorkspaceTabs(emptyWorkspaceTabsState(), {
        activeBrowserTabId: "one",
        browserTabIds: ["one"],
        conversationId: "thread-1",
      }),
    );
    const second = reconcileBrowserWorkspaceTabs(first, {
      activeBrowserTabId: "two",
      browserTabIds: ["two"],
      conversationId: "thread-2",
    });

    expect(second.tabs.map(({ id }) => id)).toEqual([browserWorkspaceTabId("two")]);
    expect(second.activeTabId).toBe(browserWorkspaceTabId("two"));
    expect(second.visible).toBe(false);
  });

  it("opens, hides, and restores browser and review surfaces predictably", () => {
    const reconciled = reconcileBrowserWorkspaceTabs(emptyWorkspaceTabsState(), {
      activeBrowserTabId: "one",
      browserTabIds: ["one"],
      conversationId: "thread-1",
    });
    const browser = showBrowserWorkspaceTab(reconciled, "one");
    const hidden = hideWorkspaceTabs(browser);
    const review = showReviewWorkspaceTab(hidden);

    expect(browser.visible).toBe(true);
    expect(hidden.visible).toBe(false);
    expect(activeWorkspaceTab(review)?.kind).toBe("review");
    expect(removeReviewWorkspaceTab(review)).toMatchObject({
      activeTabId: browserWorkspaceTabId("one"),
      visible: true,
    });
  });

  it("selects the nearest surviving tab when the active tab closes", () => {
    const state = showReviewWorkspaceTab(
      reconcileBrowserWorkspaceTabs(emptyWorkspaceTabsState(), {
        activeBrowserTabId: "one",
        browserTabIds: ["one", "two"],
        conversationId: "thread-1",
      }),
    );
    const withoutReview = closeWorkspaceTab(state, "review");
    const secondActive = showBrowserWorkspaceTab(withoutReview, "two");
    const withoutSecond = closeWorkspaceTab(secondActive, browserWorkspaceTabId("two"));

    expect(withoutReview.activeTabId).toBe(browserWorkspaceTabId("two"));
    expect(withoutSecond.activeTabId).toBe(browserWorkspaceTabId("one"));
    expect(withoutSecond.visible).toBe(true);
  });

  it("ignores requests for tabs outside the reconciled topology", () => {
    const state = reconcileBrowserWorkspaceTabs(emptyWorkspaceTabsState(), {
      activeBrowserTabId: "one",
      browserTabIds: ["one"],
      conversationId: "thread-1",
    });

    expect(showBrowserWorkspaceTab(state, "missing")).toBe(state);
    expect(closeWorkspaceTab(state, browserWorkspaceTabId("missing"))).toBe(state);
  });

  it.each(["browser", "review"] as const)("hides the panel when its last %s tab closes", (kind) => {
    const initial = reconcileBrowserWorkspaceTabs(emptyWorkspaceTabsState(), {
      activeBrowserTabId: kind === "browser" ? "one" : null,
      browserTabIds: kind === "browser" ? ["one"] : [],
      conversationId: "thread-1",
    });
    const opened =
      kind === "browser"
        ? showBrowserWorkspaceTab(initial, "one")
        : showReviewWorkspaceTab(initial);
    const closed = closeWorkspaceTab(
      opened,
      kind === "browser" ? browserWorkspaceTabId("one") : "review",
    );

    expect(closed).toEqual({
      activeTabId: null,
      conversationId: "thread-1",
      tabs: [],
      visible: false,
    });
  });

  it("hides the panel when the native browser removes its last tab", () => {
    const opened = showBrowserWorkspaceTab(
      reconcileBrowserWorkspaceTabs(emptyWorkspaceTabsState(), {
        activeBrowserTabId: "one",
        browserTabIds: ["one"],
        conversationId: "thread-1",
      }),
      "one",
    );
    const reconciled = reconcileBrowserWorkspaceTabs(opened, {
      activeBrowserTabId: null,
      browserTabIds: [],
      conversationId: "thread-1",
    });

    expect(reconciled).toEqual({
      activeTabId: null,
      conversationId: "thread-1",
      tabs: [],
      visible: false,
    });
    expect(
      reconcileBrowserWorkspaceTabs(reconciled, {
        activeBrowserTabId: null,
        browserTabIds: [],
        conversationId: "thread-1",
      }),
    ).toBe(reconciled);
  });

  it("opens and preserves a clean workspace without creating a browser tab", () => {
    const opened = showEmptyWorkspace(emptyWorkspaceTabsState(), "thread-1");
    const reconciled = reconcileBrowserWorkspaceTabs(opened, {
      activeBrowserTabId: null,
      browserTabIds: [],
      conversationId: "thread-1",
    });

    expect(reconciled).toEqual({
      activeTabId: null,
      conversationId: "thread-1",
      tabs: [],
      visible: true,
    });
  });
});
