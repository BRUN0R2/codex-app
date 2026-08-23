import { describe, expect, it } from "vitest";

import { profileTodayIso, projectProfileActivity } from "./profileActivity";

describe("profile activity", () => {
  it("projects a fixed Sunday-aligned 52-week window", () => {
    const projection = projectProfileActivity(
      [
        { date: "2026-08-22", tokens: 10 },
        { date: "2026-08-22", tokens: 5 },
        { date: "2026-08-23", tokens: 20 },
        { date: "2026-08-24", tokens: 999 },
        { date: "2025-01-01", tokens: 999 },
      ],
      "2026-08-23",
      "daily",
    );

    expect(projection.cells).toHaveLength(364);
    expect(projection.cells[0]?.date).toBe("2025-08-31");
    expect(projection.cells.at(-1)?.date).toBe("2026-08-29");
    expect(projection.cells.find((cell) => cell.date === "2026-08-22")?.tokens).toBe(15);
    expect(projection.cells.find((cell) => cell.date === "2026-08-23")?.tokens).toBe(20);
    expect(projection.cells.find((cell) => cell.date === "2026-08-24")).toMatchObject({
      future: true,
      level: 0,
      tokens: 0,
    });
  });

  it("uses deterministic daily intensity thresholds", () => {
    const projection = projectProfileActivity(
      [
        { date: "2026-08-19", tokens: 1 },
        { date: "2026-08-20", tokens: 3 },
        { date: "2026-08-21", tokens: 6 },
        { date: "2026-08-22", tokens: 8 },
      ],
      "2026-08-23",
      "daily",
    );

    expect(
      ["2026-08-19", "2026-08-20", "2026-08-21", "2026-08-22"].map(
        (date) => projection.cells.find((cell) => cell.date === date)?.level,
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  it("builds bottom-aligned weekly and cumulative bars", () => {
    const usage = [
      { date: "2026-08-15", tokens: 10 },
      { date: "2026-08-22", tokens: 30 },
    ] as const;
    const weekly = projectProfileActivity(usage, "2026-08-23", "weekly");
    const cumulative = projectProfileActivity(usage, "2026-08-23", "cumulative");
    const weeklyColumn = weekly.cells.slice(51 * 7, 52 * 7).map((cell) => cell.level);
    const cumulativeColumn = cumulative.cells.slice(51 * 7, 52 * 7).map((cell) => cell.level);

    expect(weekly.weeklyTotals.at(-2)).toBe(30);
    expect(weekly.weeklyTotals.at(-3)).toBe(10);
    expect(weeklyColumn.every((level) => level === 0)).toBe(true);
    expect(cumulative.cumulativeTotals.at(-1)).toBe(40);
    expect(cumulativeColumn.at(-1)).toBe(4);
    expect(cumulativeColumn.filter((level) => level === 4).length).toBeGreaterThan(
      weeklyColumn.filter((level) => level === 4).length,
    );
  });

  it("formats today in UTC and emits sparse month labels", () => {
    expect(profileTodayIso(new Date("2026-08-23T23:59:59.000Z"))).toBe("2026-08-23");
    const projection = projectProfileActivity([], "2026-08-23", "daily");

    expect(projection.monthLabels.length).toBeGreaterThanOrEqual(10);
    expect(
      projection.monthLabels.every(
        (label, index, labels) => index === 0 || label.column > (labels[index - 1]?.column ?? -1),
      ),
    ).toBe(true);
  });
});
