import { describe, expect, it } from "vitest";

import { overlayVisibleTurns, type VisibleThreadTurn } from "./visibleTurnSequence";

describe("visible turn sequence", () => {
  it("projects multiple owned turn overlays without cloning the persisted array", () => {
    const persisted = [turn("turn-old", "old"), turn("turn-new", "new")] as const;
    const oldOverlay = turn("turn-old", "old-updated");
    const newOverlay = turn("turn-new", "new-updated");

    const result = overlayVisibleTurns(
      persisted,
      new Map([
        [0, oldOverlay],
        [1, newOverlay],
      ]),
    );

    expect(Array.isArray(result)).toBe(false);
    expect(result.length).toBe(2);
    expect(result.at(0)).toBe(oldOverlay);
    expect(result.at(1)).toBe(newOverlay);
    expect(result.slice()).toEqual([oldOverlay, newOverlay]);
    expect(persisted[0].items[0]).toMatchObject({ type: "agentMessage", text: "old" });
  });

  it("supports one synthetic active turn after persisted history", () => {
    const persisted = [turn("turn-old", "old")] as const;
    const active = { ...turn("turn-active", "streaming"), status: "inProgress" as const };

    const result = overlayVisibleTurns(persisted, new Map([[persisted.length, active]]));

    expect(result.length).toBe(2);
    expect(result.at(0)).toBe(persisted[0]);
    expect(result.at(1)).toBe(active);
  });
});

function turn(id: string, text: string): VisibleThreadTurn {
  return {
    id,
    status: "completed",
    error: null,
    createdAt: 1,
    updatedAt: 2,
    items: [{ type: "agentMessage", id: `${id}-message`, text, phase: null }],
  };
}
