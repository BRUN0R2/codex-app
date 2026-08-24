import type { FileChange, PlanItem } from "../contracts/types";

export function shouldShowTurnProgress(
  plan: PlanItem | null,
  changes: readonly FileChange[],
): boolean {
  return plan !== null || changes.length > 0;
}
