import { describe, expect, it } from "vitest";

import { createSolidTransformPlugin, SOLID_TRANSFORM_ID } from "./solidTransformPlugin";

describe("Solid transform plugin", () => {
  it("installs native hook filters for Solid source and refresh modules", () => {
    const plugin = createSolidTransformPlugin({ hot: false });

    expect(plugin.transform).toMatchObject({
      filter: { id: SOLID_TRANSFORM_ID },
      handler: expect.any(Function),
    });
    expect(plugin.resolveId).toMatchObject({
      filter: { id: /^\/@solid-refresh$/u },
      handler: expect.any(Function),
    });
    expect(plugin.load).toMatchObject({
      filter: { id: /^\/@solid-refresh$/u },
      handler: expect.any(Function),
    });
  });

  it("accepts only JSX-bearing module identifiers", () => {
    for (const id of ["App.tsx", "view.jsx", "entry.mtsx?direct", "legacy.cjsx?raw"]) {
      expect(SOLID_TRANSFORM_ID.test(id), id).toBe(true);
    }
    for (const id of [
      "state.ts",
      "config.js",
      "messages.json",
      "global.css",
      "global.css?source=component.tsx",
    ]) {
      expect(SOLID_TRANSFORM_ID.test(id), id).toBe(false);
    }
  });
});
