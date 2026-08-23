import { describe, expect, it } from "vitest";

import { decodePersistedBrowserState } from "./browserPersistence";

describe("browser persistence", () => {
  it("decodes a closed versioned tab topology", () => {
    const state = {
      version: 1,
      conversations: [
        {
          conversationId: "thread-1",
          activeBrowserTabId: "tab-1",
          tabs: [
            { browserTabId: "tab-1", url: "https://example.com" },
            { browserTabId: "tab-2", url: "about:blank" },
          ],
        },
      ],
    };

    expect(decodePersistedBrowserState(state)).toEqual(state);
  });

  it("rejects privileged URLs, duplicate ids, and unknown fields", () => {
    const conversation = {
      conversationId: "thread-1",
      activeBrowserTabId: "tab-1",
      tabs: [{ browserTabId: "tab-1", url: "file:///C:/secret.txt" }],
    };
    expect(() =>
      decodePersistedBrowserState({ version: 1, conversations: [conversation] }),
    ).toThrow("not allowed");
    expect(() =>
      decodePersistedBrowserState({
        version: 1,
        conversations: [
          {
            ...conversation,
            tabs: [
              { browserTabId: "tab-1", url: "about:blank" },
              { browserTabId: "tab-1", url: "about:blank" },
            ],
          },
        ],
      }),
    ).toThrow("globally unique");
    expect(() =>
      decodePersistedBrowserState({ version: 1, conversations: [], future: true }),
    ).toThrow("unexpected fields");
  });
});
