import { createContext, useContext } from "solid-js";

import type { ActivityVirtualizerStore } from "./activityVirtualization";

export interface TimelineActivityViewportSnapshot {
  readonly element: HTMLElement;
  readonly scrollTop: number;
  readonly size: number;
}

export interface TimelineActivityVisualAnchor {
  readonly element: HTMLElement;
  readonly key: string;
  readonly scrollTop: number;
  readonly viewportOffset: number;
}

export interface TimelineActivityContextValue {
  readonly contentDeferred: () => boolean;
  readonly layoutRevision: () => number;
  readonly layoutSignature: () => string | null;
  readonly minimalOverscan: () => boolean;
  readonly notifyLayoutChange: () => void;
  readonly preserveVisualAnchor: (anchor: TimelineActivityVisualAnchor) => void;
  readonly sessions: ActivityVirtualizerStore;
  readonly shouldPreserveAnchor: () => boolean;
  readonly viewport: () => TimelineActivityViewportSnapshot | null;
}

export const TimelineActivityContext = createContext<TimelineActivityContextValue>();

export function useTimelineActivityContext(): TimelineActivityContextValue {
  const context = useContext(TimelineActivityContext);
  if (context === undefined) {
    throw new Error("Timeline activity virtualization was not initialized.");
  }
  return context;
}
