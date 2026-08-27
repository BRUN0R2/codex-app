import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ACTIVITY_SHIMMER_DURATION_MS,
  ACTIVITY_SHIMMER_INITIAL_DELAY_MS,
  ACTIVITY_SHIMMER_INTERVAL_MS,
  scheduleCadencedActivityShimmer,
} from "./activityShimmer";

describe("cadenced activity shimmer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("matches the official delayed one-second pulse on a four-second cadence", () => {
    vi.useFakeTimers();
    const states: boolean[] = [];
    const stop = scheduleCadencedActivityShimmer((active) => states.push(active));

    vi.advanceTimersByTime(ACTIVITY_SHIMMER_INITIAL_DELAY_MS - 1);
    expect(states).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(states).toEqual([false, true]);

    vi.advanceTimersByTime(ACTIVITY_SHIMMER_DURATION_MS);
    expect(states).toEqual([false, true, false]);

    vi.advanceTimersByTime(ACTIVITY_SHIMMER_INTERVAL_MS - ACTIVITY_SHIMMER_DURATION_MS);
    expect(states).toEqual([false, true, false, false, true]);

    stop();
    expect(states.at(-1)).toBe(false);
    vi.advanceTimersByTime(ACTIVITY_SHIMMER_INTERVAL_MS * 2);
    expect(states.at(-1)).toBe(false);
  });

  it("cancels cleanly before the first pulse", () => {
    vi.useFakeTimers();
    const states: boolean[] = [];
    const stop = scheduleCadencedActivityShimmer((active) => states.push(active));

    stop();
    vi.advanceTimersByTime(ACTIVITY_SHIMMER_INITIAL_DELAY_MS + ACTIVITY_SHIMMER_INTERVAL_MS);

    expect(states).toEqual([false]);
  });
});
