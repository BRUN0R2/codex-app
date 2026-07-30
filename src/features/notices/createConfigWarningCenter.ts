import { createSignal, type Accessor } from "solid-js";

import type { ConfigWarningNotification } from "../../shared/codex/types";

const MAX_CONFIG_WARNINGS = 20;

export interface ConfigWarningCenter {
  warnings: Accessor<readonly ConfigWarningNotification[]>;
  dismiss: (warning: ConfigWarningNotification) => void;
  push: (warning: ConfigWarningNotification) => void;
}

export function createConfigWarningCenter(): ConfigWarningCenter {
  const [warnings, setWarnings] =
    createSignal<readonly ConfigWarningNotification[]>([]);

  function push(warning: ConfigWarningNotification) {
    setWarnings((current) => {
      if (current.some((candidate) => warningsEqual(candidate, warning))) {
        return current;
      }
      return [...current.slice(-(MAX_CONFIG_WARNINGS - 1)), warning];
    });
  }

  function dismiss(warning: ConfigWarningNotification) {
    setWarnings((current) => current.filter((candidate) => candidate !== warning));
  }

  return { warnings, dismiss, push };
}

function warningsEqual(
  left: ConfigWarningNotification,
  right: ConfigWarningNotification,
): boolean {
  return (
    left.summary === right.summary
    && left.details === right.details
    && left.path === right.path
    && rangesEqual(left.range, right.range)
  );
}

function rangesEqual(
  left: ConfigWarningNotification["range"],
  right: ConfigWarningNotification["range"],
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return (
    left.start.line === right.start.line
    && left.start.column === right.start.column
    && left.end.line === right.end.line
    && left.end.column === right.end.column
  );
}
