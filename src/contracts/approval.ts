import type { ApprovalDecision, EngineServerRequest } from "./types";

const COMMAND_APPROVAL_DECISIONS = [
  "cancel",
  "decline",
  "acceptForSession",
  "accept",
] as const satisfies readonly ApprovalDecision[];
const BROWSER_APPROVAL_DECISIONS = [
  "cancel",
  "decline",
  "accept",
] as const satisfies readonly ApprovalDecision[];

export function approvalDecisionsFor(request: EngineServerRequest): readonly ApprovalDecision[] {
  return request.method === "approval.command"
    ? COMMAND_APPROVAL_DECISIONS
    : BROWSER_APPROVAL_DECISIONS;
}
