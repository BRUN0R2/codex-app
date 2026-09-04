import { describe, expect, it } from "vitest";

import { approvalDecisionsFor } from "../contracts/approval";
import type { EngineServerRequest } from "../contracts/types";

const commandRequest = {
  id: "approval-command",
  method: "approval.command",
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    command: "pnpm verify",
    cwd: "D:\\workspace",
    reason: "Verify the change",
  },
} as const satisfies EngineServerRequest;

const browserRequest = {
  id: "approval-browser",
  method: "approval.browserOrigin",
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-2",
    origin: "https://example.com",
    reason: "Open the documentation",
  },
} as const satisfies EngineServerRequest;

describe("approval decision controls", () => {
  it("exposes the complete command decision set to every approval surface", () => {
    expect(approvalDecisionsFor(commandRequest)).toEqual([
      "cancel",
      "decline",
      "acceptForSession",
      "accept",
    ]);
  });

  it("does not offer session-wide access for a browser origin", () => {
    expect(approvalDecisionsFor(browserRequest)).toEqual(["cancel", "decline", "accept"]);
  });
});
