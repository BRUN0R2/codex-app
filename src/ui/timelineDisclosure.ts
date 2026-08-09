import { createSignal } from "solid-js";

export interface TimelineDisclosureStore {
  readonly keepOpen: (key: string) => void;
  readonly read: (key: string, fallback?: boolean) => boolean;
  readonly write: (key: string, open: boolean) => void;
}

export function createTimelineDisclosureStore(): TimelineDisclosureStore {
  const [entries, setEntries] = createSignal<ReadonlyMap<string, boolean>>(new Map());

  return {
    keepOpen(key) {
      setEntries((current) => {
        if (current.has(key)) {
          return current;
        }
        const next = new Map(current);
        next.set(key, true);
        return next;
      });
    },
    read(key, fallback = false) {
      return entries().get(key) ?? fallback;
    },
    write(key, open) {
      setEntries((current) => {
        if (current.get(key) === open) {
          return current;
        }
        const next = new Map(current);
        next.set(key, open);
        return next;
      });
    },
  };
}
