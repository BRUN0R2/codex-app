import { describe, expect, it } from "vitest";

import {
  decodeDesktopBoolean,
  decodeDesktopDialogButton,
  decodeDesktopDialogSelection,
  decodeRuntimeUnit,
} from "./desktop";

describe("desktop runtime decoders", () => {
  it("accepts only the native dialog selection union", () => {
    expect(decodeDesktopDialogSelection("C:\\workspace")).toBe("C:\\workspace");
    expect(decodeDesktopDialogSelection(["C:\\one", "C:\\two"])).toEqual(["C:\\one", "C:\\two"]);
    expect(decodeDesktopDialogSelection(null)).toBeNull();
    expect(() => decodeDesktopDialogSelection({ path: "C:\\workspace" })).toThrow();
  });

  it("rejects malformed boolean, button, and unit responses", () => {
    expect(decodeDesktopBoolean(true)).toBe(true);
    expect(decodeDesktopDialogButton("OK")).toBe("OK");
    expect(() => decodeDesktopBoolean("true")).toThrow();
    expect(() => decodeDesktopDialogButton(null)).toThrow();
    expect(() => decodeRuntimeUnit(undefined)).toThrow();
    expect(decodeRuntimeUnit(null)).toBeUndefined();
  });
});
