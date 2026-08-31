import { createContext, createMemo, useContext } from "solid-js";

import type { TimelineDisclosureKey, TimelineDisclosureStore } from "./timelineDisclosure";
import { encodeTimelineIdentitySegment } from "./timelineIdentity";

export interface TimelineDisclosureBinding {
  readonly descendantContext: TimelineDisclosureContextValue;
  readonly isOpen: () => boolean;
  readonly openDescendantCount: () => number;
  readonly setOpen: (open: boolean) => void;
  readonly storageKey: () => TimelineDisclosureKey;
  readonly subtreeRevision: () => number;
  readonly toggle: () => void;
}

export interface TimelineDisclosureContextValue {
  readonly keyPrefix: () => TimelineDisclosureKey;
  readonly onLayoutChange: () => void;
  readonly store: TimelineDisclosureStore;
}

export const TimelineDisclosureContext = createContext<TimelineDisclosureContextValue>();

export function timelineDisclosureNamespacePrefix(namespace: string): TimelineDisclosureKey {
  return encodeTimelineIdentitySegment(namespace) as TimelineDisclosureKey;
}

export function timelineDisclosureChildKey(
  parentKey: TimelineDisclosureKey,
  key: string,
): TimelineDisclosureKey {
  return `${parentKey}${encodeTimelineIdentitySegment(key)}` as TimelineDisclosureKey;
}

export function timelineDisclosureStorageKey(
  namespace: string,
  key: string,
): TimelineDisclosureKey {
  return timelineDisclosureChildKey(timelineDisclosureNamespacePrefix(namespace), key);
}

export function useTimelineDisclosure(
  key: () => string,
  initialOpen: () => boolean = () => false,
): TimelineDisclosureBinding {
  const context = useTimelineDisclosureContext();

  const storageKey = createMemo(() => timelineDisclosureChildKey(context.keyPrefix(), key()));
  const isOpen = createMemo(() => context.store.read(storageKey(), initialOpen()));
  const setOpen = (open: boolean) => {
    if (isOpen() === open) {
      return;
    }
    context.store.setOpen(storageKey(), open);
    context.onLayoutChange();
  };

  return {
    descendantContext: {
      keyPrefix: storageKey,
      onLayoutChange: context.onLayoutChange,
      store: context.store,
    },
    isOpen,
    openDescendantCount: () => context.store.countOpenDescendants(storageKey()),
    setOpen,
    storageKey,
    subtreeRevision: () => context.store.subtreeRevision(storageKey()),
    toggle: () => setOpen(!isOpen()),
  };
}

export function useTimelineDisclosureStorageKey(key: () => string): () => TimelineDisclosureKey {
  const context = useTimelineDisclosureContext();
  return () => timelineDisclosureChildKey(context.keyPrefix(), key());
}

function useTimelineDisclosureContext(): TimelineDisclosureContextValue {
  const context = useContext(TimelineDisclosureContext);
  if (context === undefined) {
    throw new Error("The timeline disclosure state was not initialized.");
  }
  return context;
}
