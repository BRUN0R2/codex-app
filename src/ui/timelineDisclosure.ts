import { createSignal } from "solid-js";

declare const timelineDisclosureKeyBrand: unique symbol;

export type TimelineDisclosureKey = string & {
  readonly [timelineDisclosureKeyBrand]: true;
};

export interface TimelineDisclosureStore {
  readonly read: (key: TimelineDisclosureKey, fallback?: boolean) => boolean;
  readonly setOpen: (key: TimelineDisclosureKey, open: boolean) => void;
}

export function createTimelineDisclosureStore(): TimelineDisclosureStore {
  const [entries, setEntries] = createSignal<ReadonlyMap<string, boolean>>(new Map());

  return {
    read(key, fallback = false) {
      return entries().get(key) ?? fallback;
    },
    setOpen(key, open) {
      setEntries((current) => {
        if (open) {
          if (current.get(key) === true) {
            return current;
          }
          const next = new Map(current);
          next.set(key, true);
          return next;
        }

        let next: Map<string, boolean> | undefined;
        for (const currentKey of current.keys()) {
          if (!currentKey.startsWith(key)) {
            continue;
          }
          next ??= new Map(current);
          next.delete(currentKey);
        }
        if (next === undefined) {
          return current;
        }
        return next;
      });
    },
  };
}
