import { describe, expect, it } from "vitest";

import { ContractError } from "../contracts/decode/primitives";
import { decodeTauriMonitor } from "./tauriMonitor";

const monitor = {
  name: null,
  position: { x: -2_400, y: -300 },
  size: { width: 2_400, height: 1_350 },
  workArea: {
    position: { x: -2_400, y: -300 },
    size: { width: 2_400, height: 1_300 },
  },
  scaleFactor: 1.25,
};

describe("Tauri monitor boundary", () => {
  it("decodes physical coordinates and the work area with their native DPI conversions", () => {
    const decoded = decodeTauriMonitor(monitor);
    expect(decoded.name).toBeNull();
    expect(decoded.position.toLogical(decoded.scaleFactor)).toMatchObject({ x: -1_920, y: -240 });
    expect(decoded.size.toLogical(decoded.scaleFactor)).toMatchObject({
      width: 1_920,
      height: 1_080,
    });
    expect(decoded.workArea.position.toLogical(decoded.scaleFactor)).toMatchObject({
      x: -1_920,
      y: -240,
    });
    expect(decoded.workArea.size.toLogical(decoded.scaleFactor)).toMatchObject({
      width: 1_920,
      height: 1_040,
    });
  });

  it.each([
    null,
    [],
    { ...monitor, workArea: undefined },
    { ...monitor, unexpected: true },
    { ...monitor, name: 123 },
    { ...monitor, scaleFactor: 0 },
    { ...monitor, scaleFactor: -1 },
    { ...monitor, scaleFactor: Number.NaN },
    { ...monitor, scaleFactor: Number.POSITIVE_INFINITY },
    { ...monitor, position: { x: -(2 ** 31) - 1, y: 0 } },
    { ...monitor, position: { x: 2 ** 31, y: 0 } },
    { ...monitor, position: { x: 0.5, y: 0 } },
    { ...monitor, size: { width: 2 ** 32, height: 1_080 } },
    { ...monitor, workArea: { ...monitor.workArea, position: { x: "0", y: 0 } } },
    { ...monitor, workArea: { ...monitor.workArea, size: { width: 1_920, height: 0 } } },
  ])("rejects malformed or unusable native geometry: %j", (value) => {
    expect(() => decodeTauriMonitor(value)).toThrow(ContractError);
  });
});
