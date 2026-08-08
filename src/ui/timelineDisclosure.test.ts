import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";

import { createTimelineDisclosureStore } from "./timelineDisclosure";

describe("timeline disclosure state", () => {
  it("keeps an open panel open when its component is recreated", () => {
    createRoot((dispose) => {
      const disclosures = createTimelineDisclosureStore();

      disclosures.keepOpen("turn:1");
      expect(disclosures.read("turn:1", false)).toBe(true);

      // A conclusão do turno muda o padrão para fechado, mas não deve apagar
      // a escolha/estado que já estava visível durante o trabalho.
      expect(disclosures.read("turn:1", false)).toBe(true);

      disclosures.write("turn:1", false);
      expect(disclosures.read("turn:1", true)).toBe(false);
      dispose();
    });
  });

  it("keeps independent state for commands and file diffs", () => {
    createRoot((dispose) => {
      const disclosures = createTimelineDisclosureStore();

      disclosures.write("command:1", true);
      disclosures.write("change:1:0", false);

      expect(disclosures.read("command:1")).toBe(true);
      expect(disclosures.read("change:1:0", true)).toBe(false);
      expect(disclosures.read("command:2")).toBe(false);
      dispose();
    });
  });
});
