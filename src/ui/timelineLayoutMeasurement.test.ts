import { describe, expect, it } from "vitest";

import { TimelineLayoutMeasurement } from "./timelineLayoutMeasurement";

describe("timeline layout measurement", () => {
  it("measures the final layout once for a batch of disclosure changes", async () => {
    let height = 0;
    const measured: number[] = [];
    const measurement = new TimelineLayoutMeasurement(() => measured.push(height));
    for (let index = 0; index < 1000; index += 1) {
      height += 20;
      measurement.request();
    }
    expect(measured).toEqual([]);
    await Promise.resolve();
    expect(measured).toEqual([20000]);
    height = 40;
    measurement.request();
    await Promise.resolve();
    expect(measured).toEqual([20000, 40]);
  });

  it("cancels queued reads when the timeline changes or is disposed", async () => {
    let reads = 0;
    const measurement = new TimelineLayoutMeasurement(() => (reads += 1));
    measurement.request();
    measurement.cancel();
    await Promise.resolve();
    expect(reads).toBe(0);
  });

  it("does not let a cancelled callback consume a new timeline request", async () => {
    let reads = 0;
    const measurement = new TimelineLayoutMeasurement(() => (reads += 1));
    measurement.request();
    measurement.cancel();
    measurement.request();
    await Promise.resolve();
    expect(reads).toBe(1);
  });
});
