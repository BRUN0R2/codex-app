import { batch, createComputed, createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";

import { createActivityBodyMaterialization } from "./activityBodyMaterialization";

describe("activity body materialization", () => {
  it("does not propagate 100,000 viewport updates through an already materialized body", () => {
    createRoot((dispose) => {
      const [viewport, setViewport] = createSignal(0);
      let eligibilityReads = 0;
      let bodyUpdates = 0;
      const materialized = createActivityBodyMaterialization(
        () => "retained",
        () => {
          eligibilityReads += 1;
          return viewport() >= 0;
        },
      );
      createComputed(() => {
        materialized();
        bodyUpdates += 1;
      });
      for (let index = 1; index <= 100_000; index += 1) setViewport(index);
      expect(materialized()).toBe(true);
      expect(eligibilityReads).toBe(1);
      expect(bodyUpdates).toBe(1);
      dispose();
    });
  });

  it("keeps the last body across a deferred slot and resets when a replacement materializes", () => {
    createRoot((dispose) => {
      const [key, setKey] = createSignal("first");
      const [visible, setVisible] = createSignal(true);
      const materialized = createActivityBodyMaterialization(key, visible);
      expect(materialized()).toBe(true);
      batch(() => {
        setVisible(false);
        setKey("second");
      });
      expect(materialized()).toBe(false);
      setKey("first");
      expect(materialized()).toBe(true);
      setKey("second");
      expect(materialized()).toBe(false);
      setVisible(true);
      expect(materialized()).toBe(true);
      setVisible(false);
      expect(materialized()).toBe(true);
      setKey("first");
      expect(materialized()).toBe(false);
      dispose();
    });
  });
});
