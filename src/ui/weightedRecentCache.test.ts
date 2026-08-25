import { describe, expect, it } from "vitest";

import { WeightedRecentCache } from "./weightedRecentCache";

describe("WeightedRecentCache", () => {
  it("evicts the least recently used entry by count and weight", () => {
    const cache = new WeightedRecentCache<string, { readonly value: number }>(2, 5);
    cache.write("a", { value: 1 }, 2);
    cache.write("b", { value: 2 }, 2);
    expect(cache.read("a")?.value).toBe(1);

    cache.write("c", { value: 3 }, 2);

    expect(cache.read("b")).toBeNull();
    expect(cache.read("a")?.value).toBe(1);
    expect(cache.read("c")?.value).toBe(3);
    expect(cache.size).toBe(2);
    expect(cache.weight).toBe(4);
  });

  it("does not retain a single entry larger than its entire budget", () => {
    const cache = new WeightedRecentCache<string, { readonly value: number }>(2, 3);
    cache.write("stable", { value: 1 }, 2);

    expect(cache.write("oversized", { value: 2 }, 4)).toBe(false);
    expect(cache.read("stable")?.value).toBe(1);
    expect(cache.read("oversized")).toBeNull();
  });

  it("rejects invalid capacities and entry weights", () => {
    expect(() => new WeightedRecentCache(0, 1)).toThrow();
    expect(() => new WeightedRecentCache(1, 0)).toThrow();
    const cache = new WeightedRecentCache<string, { readonly value: number }>(1, 1);
    expect(() => cache.write("invalid", { value: 1 }, 0)).toThrow();
  });
});
