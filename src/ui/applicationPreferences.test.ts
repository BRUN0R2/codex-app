import { describe, expect, it } from "vitest";

import {
  DEFAULT_APPLICATION_PREFERENCES,
  mergeApplicationPreferences,
} from "./applicationPreferences";

describe("application preferences", () => {
  it("preserves independent preferences while applying a patch", () => {
    expect(
      mergeApplicationPreferences(DEFAULT_APPLICATION_PREFERENCES, {
        closeToTray: true,
      }),
    ).toEqual({
      ...DEFAULT_APPLICATION_PREFERENCES,
      closeToTray: true,
    });
  });

  it("turns off minimized startup when Windows startup is disabled", () => {
    expect(
      mergeApplicationPreferences(
        {
          ...DEFAULT_APPLICATION_PREFERENCES,
          startWithWindows: true,
          startMinimized: true,
        },
        { startWithWindows: false },
      ),
    ).toEqual(DEFAULT_APPLICATION_PREFERENCES);
  });
});
