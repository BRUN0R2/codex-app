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
});
