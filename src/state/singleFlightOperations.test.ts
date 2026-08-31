import { describe, expect, it, vi } from "vitest";

import { SingleFlightOperations } from "./singleFlightOperations";

describe("single-flight operations", () => {
  it("shares one effect and result among concurrent callers for the same key", async () => {
    let release: ((value: boolean) => void) | undefined;
    const effect = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const operations = new SingleFlightOperations<string, boolean>();

    const first = operations.run("thread:interrupt:a", effect);
    const second = operations.run("thread:interrupt:a", effect);
    await Promise.resolve();

    expect(effect).toHaveBeenCalledTimes(1);
    release?.(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });

  it("isolates keys and permits a new attempt after success or failure", async () => {
    const operations = new SingleFlightOperations<string, number>();
    const first = vi.fn().mockResolvedValue(1);
    const other = vi.fn().mockResolvedValue(2);

    await expect(
      Promise.all([operations.run("thread:a", first), operations.run("thread:b", other)]),
    ).resolves.toEqual([1, 2]);
    await expect(
      operations.run("thread:a", () => Promise.reject(new Error("failed"))),
    ).rejects.toThrow("failed");
    await expect(operations.run("thread:a", first)).resolves.toBe(1);

    expect(first).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(1);
  });

  it("collapses a burst of one thousand callers into one effect", async () => {
    const operations = new SingleFlightOperations<string, string>();
    const effect = vi.fn().mockResolvedValue("settled");

    const results = await Promise.all(
      Array.from({ length: 1_000 }, () => operations.run("turn:interrupt:burst", effect)),
    );

    expect(effect).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(1_000);
    expect(results.every((result) => result === "settled")).toBe(true);
  });
});
