import type { CodexThread, ThreadReadResponse } from "../contracts/types";
import { prependThreadHistory } from "./threadHistory";

export const MINIMUM_INITIAL_COMPLETE_TURNS = 8;

export interface HydratedThreadPage {
  readonly nextCursor: string | null;
  readonly thread: CodexThread;
}

export async function hydrateInitialThreadPage(input: {
  readonly initialPage: HydratedThreadPage;
  readonly isCurrent: () => boolean;
  readonly minimumCompleteTurns?: number | undefined;
  readonly readOlderPage: (cursor: string) => Promise<ThreadReadResponse>;
}): Promise<HydratedThreadPage | null> {
  const minimumCompleteTurns = input.minimumCompleteTurns ?? MINIMUM_INITIAL_COMPLETE_TURNS;
  if (!Number.isInteger(minimumCompleteTurns) || minimumCompleteTurns < 1) {
    throw new Error("Initial thread hydration requires a positive complete-turn target.");
  }

  let page = input.initialPage;
  const consumedCursors = new Set<string>();
  while (
    input.isCurrent() &&
    page.nextCursor !== null &&
    completeTurnCount(page) < minimumCompleteTurns
  ) {
    const cursor = page.nextCursor;
    if (consumedCursors.has(cursor)) {
      throw new Error("Thread history pagination repeated a cursor during initial hydration.");
    }
    consumedCursors.add(cursor);
    const olderPage = await input.readOlderPage(cursor);
    if (!input.isCurrent()) {
      return null;
    }
    if (olderPage.nextCursor === cursor) {
      throw new Error("Thread history pagination did not advance during initial hydration.");
    }
    if (olderPage.thread.turns.length === 0 && olderPage.nextCursor !== null) {
      throw new Error("Thread history pagination returned an empty non-terminal page.");
    }
    page = {
      nextCursor: olderPage.nextCursor,
      thread: prependThreadHistory(page.thread, olderPage.thread),
    };
  }
  return input.isCurrent() ? page : null;
}

function completeTurnCount(page: HydratedThreadPage): number {
  return page.nextCursor === null
    ? page.thread.turns.length
    : Math.max(0, page.thread.turns.length - 1);
}
