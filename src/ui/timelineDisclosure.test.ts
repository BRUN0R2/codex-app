import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";

import { createTimelineDisclosureStore } from "./timelineDisclosure";

describe("timeline disclosure state", () => {
  it("uses a live fallback without persisting it after the running phase", () => {
    createRoot((dispose) => {
      const disclosures = createTimelineDisclosureStore();

      expect(disclosures.read("turn:1", true)).toBe(true);
      expect(disclosures.read("turn:1", false)).toBe(false);

      disclosures.write("turn:1", true);
      expect(disclosures.read("turn:1", false)).toBe(true);

      disclosures.write("turn:1", false);
      expect(disclosures.read("turn:1", false)).toBe(false);
      dispose();
    });
  });

  it("keeps independent state for commands and file diffs", () => {
    createRoot((dispose) => {
      const disclosures = createTimelineDisclosureStore();

      disclosures.write("command:1", true);
      disclosures.write("change:1:0", false);

      expect(disclosures.read("command:1")).toBe(true);
      expect(disclosures.read("change:1:0", true)).toBe(true);
      expect(disclosures.read("command:2")).toBe(false);
      dispose();
    });
  });

  it("clears nested disclosure scopes when their parent closes", () => {
    createRoot((dispose) => {
      const disclosures = createTimelineDisclosureStore();

      disclosures.write("activity:one", true);
      disclosures.write("command:item-1:running", true);
      disclosures.write("change:item-2:0:settled", true);
      disclosures.write("command:unrelated:running", true);

      disclosures.clear(["activity:one"], ["command:item-1:", "change:item-2:"]);

      expect(disclosures.read("activity:one")).toBe(false);
      expect(disclosures.read("command:item-1:running")).toBe(false);
      expect(disclosures.read("change:item-2:0:settled")).toBe(false);
      expect(disclosures.read("command:unrelated:running")).toBe(true);
      dispose();
    });
  });
});
