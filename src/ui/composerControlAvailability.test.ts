import { describe, expect, it } from "vitest";

import { composerControlAvailability } from "./composerControlAvailability";

describe("composer control availability", () => {
  it("keeps draft attachments and access selection interactive during active work", () => {
    expect(composerControlAvailability(true)).toEqual({
      attachments: true,
      permissions: true,
    });
  });

  it("requires loaded configuration only for access selection", () => {
    expect(composerControlAvailability(false)).toEqual({
      attachments: true,
      permissions: false,
    });
  });
});
