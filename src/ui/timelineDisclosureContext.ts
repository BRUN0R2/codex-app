import { createContext, useContext } from "solid-js";

import type { TimelineDisclosureKey, TimelineDisclosureStore } from "./timelineDisclosure";

export interface TimelineDisclosureBinding {
  readonly descendantContext: TimelineDisclosureContextValue;
  readonly isOpen: () => boolean;
  readonly setOpen: (open: boolean) => void;
  readonly toggle: () => void;
}

export interface TimelineDisclosureContextValue {
  readonly keyPrefix: () => TimelineDisclosureKey;
  readonly store: TimelineDisclosureStore;
}

export const TimelineDisclosureContext = createContext<TimelineDisclosureContextValue>();

function encodeTimelineDisclosureSegment(segment: string): string {
  return `${segment.length}:${segment}|`;
}

export function timelineDisclosureNamespacePrefix(namespace: string): TimelineDisclosureKey {
  return encodeTimelineDisclosureSegment(namespace) as TimelineDisclosureKey;
}

export function timelineDisclosureChildKey(
  parentKey: TimelineDisclosureKey,
  key: string,
): TimelineDisclosureKey {
  return `${parentKey}${encodeTimelineDisclosureSegment(key)}` as TimelineDisclosureKey;
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
  const context = useContext(TimelineDisclosureContext);
  if (context === undefined) {
    throw new Error("O estado visual da timeline não foi inicializado.");
  }

  const storageKey = () => timelineDisclosureChildKey(context.keyPrefix(), key());
  const isOpen = () => context.store.read(storageKey(), initialOpen());
  const setOpen = (open: boolean) => context.store.setOpen(storageKey(), open);

  return {
    descendantContext: {
      keyPrefix: storageKey,
      store: context.store,
    },
    isOpen,
    setOpen,
    toggle: () => setOpen(!isOpen()),
  };
}

export function handleTimelineDetailsToggle(
  event: ToggleEvent & { readonly currentTarget: HTMLDetailsElement },
  disclosure: TimelineDisclosureBinding,
): void {
  disclosure.setOpen(event.currentTarget.open);
}
