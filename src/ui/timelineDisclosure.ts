import { createSignal } from "solid-js";

export interface TimelineDisclosureStore {
  readonly clear: (keys: readonly string[], prefixes?: readonly string[]) => void;
  readonly read: (key: string, fallback?: boolean) => boolean;
  readonly write: (key: string, open: boolean) => void;
}

export function createTimelineDisclosureStore(): TimelineDisclosureStore {
  const [entries, setEntries] = createSignal<ReadonlyMap<string, boolean>>(new Map());

  return {
    clear(keys, prefixes = []) {
      setEntries((current) => {
        const exact = new Set(keys);
        const shouldClear = (key: string) =>
          exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix));
        if (![...current.keys()].some(shouldClear)) {
          return current;
        }
        return new Map([...current].filter(([key]) => !shouldClear(key)));
      });
    },
    read(key, fallback = false) {
      return entries().get(key) ?? fallback;
    },
    write(key, open) {
      setEntries((current) => {
        if ((open && current.get(key) === true) || (!open && !current.has(key))) {
          return current;
        }
        const next = new Map(current);
        if (open) {
          next.set(key, true);
        } else {
          next.delete(key);
        }
        return next;
      });
    },
  };
}
