import { createContext, useContext } from "solid-js";

export type FrontendFailureReporter = (reason: unknown) => void;

export const FrontendFailureContext = createContext<FrontendFailureReporter>();

export function useFrontendFailureReporter(): FrontendFailureReporter {
  const reporter = useContext(FrontendFailureContext);
  if (reporter === undefined) {
    throw new Error("Frontend failure reporting is unavailable.");
  }
  return reporter;
}

export function frontendFailureMessage(context: string, reason: unknown): string {
  const detail = reason instanceof Error ? reason.message : String(reason);
  return `${context}: ${detail}`;
}
