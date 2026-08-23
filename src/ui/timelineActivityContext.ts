import { createContext, useContext } from "solid-js";

import type { ActivityVirtualizerStore } from "./activityVirtualization";

export interface TimelineActivityViewportSnapshot {
  readonly element: HTMLElement;
  readonly scrollTop: number;
  readonly size: number;
}

export interface TimelineActivityContextValue {
  readonly adjustScrollBy: (delta: number) => void;
  readonly contentDeferred: () => boolean;
  readonly layoutSignature: () => string | null;
  readonly notifyLayoutChange: () => void;
  readonly sessions: ActivityVirtualizerStore;
  readonly shouldPreserveAnchor: () => boolean;
  readonly viewport: () => TimelineActivityViewportSnapshot | null;
}

export const TimelineActivityContext = createContext<TimelineActivityContextValue>();

export function useTimelineActivityContext(): TimelineActivityContextValue {
  const context = useContext(TimelineActivityContext);
  if (context === undefined) {
    throw new Error("A virtualização das atividades da timeline não foi inicializada.");
  }
  return context;
}
