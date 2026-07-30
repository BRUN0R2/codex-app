import { createSignal, type Accessor } from "solid-js";

import type {
  ConfigWarningNotification,
  DeprecationNoticeNotification,
} from "../../shared/codex/types";

const MAX_APP_NOTICES = 20;
const MAX_NOTICE_SUMMARY_CHARACTERS = 512;
const MAX_NOTICE_DETAILS_CHARACTERS = 8 * 1024;
const MAX_NOTICE_PATH_CHARACTERS = 4 * 1024;

export type AppNotice =
  | {
      type: "configWarning";
      value: ConfigWarningNotification;
    }
  | {
      type: "deprecationNotice";
      value: DeprecationNoticeNotification;
    }
  | {
      type: "warning";
      message: string;
    };

export interface AppNoticeCenter {
  notices: Accessor<readonly AppNotice[]>;
  omittedCount: Accessor<number>;
  dismiss: (notice: AppNotice) => void;
  push: (notice: AppNotice) => void;
}

export function createAppNoticeCenter(): AppNoticeCenter {
  const [state, setState] = createSignal<{
    notices: readonly AppNotice[];
    omittedCount: number;
  }>({ notices: [], omittedCount: 0 });

  function push(notice: AppNotice) {
    const bounded = boundNotice(notice);
    setState((current) => {
      if (
        bounded.type === "configWarning"
        && current.notices.some((candidate) => noticesEqual(candidate, bounded))
      ) {
        return current;
      }
      const notices = [...current.notices, bounded];
      const overflow = Math.max(0, notices.length - MAX_APP_NOTICES);
      return {
        notices: notices.slice(overflow),
        omittedCount: current.omittedCount + overflow,
      };
    });
  }

  function dismiss(notice: AppNotice) {
    setState((current) => {
      const notices = current.notices.filter(
        (candidate) => candidate !== notice,
      );
      return {
        notices,
        omittedCount: notices.length === 0 ? 0 : current.omittedCount,
      };
    });
  }

  return {
    notices: () => state().notices,
    omittedCount: () => state().omittedCount,
    dismiss,
    push,
  };
}

function boundNotice(notice: AppNotice): AppNotice {
  switch (notice.type) {
    case "configWarning":
      return {
        type: "configWarning",
        value: {
          ...notice.value,
          summary: boundLeadingText(
            notice.value.summary,
            MAX_NOTICE_SUMMARY_CHARACTERS,
          ),
          details: boundOptionalLeadingText(
            notice.value.details,
            MAX_NOTICE_DETAILS_CHARACTERS,
          ),
          ...(notice.value.path === undefined
            ? {}
            : {
                path: boundPath(
                  notice.value.path,
                  MAX_NOTICE_PATH_CHARACTERS,
                ),
              }),
        },
      };
    case "deprecationNotice":
      return {
        type: "deprecationNotice",
        value: {
          summary: boundLeadingText(
            notice.value.summary,
            MAX_NOTICE_SUMMARY_CHARACTERS,
          ),
          details: boundOptionalLeadingText(
            notice.value.details,
            MAX_NOTICE_DETAILS_CHARACTERS,
          ),
        },
      };
    case "warning":
      return {
        type: "warning",
        message: boundLeadingText(
          notice.message,
          MAX_NOTICE_DETAILS_CHARACTERS,
        ),
      };
  }
}

function boundOptionalLeadingText(
  value: string | null,
  maximum: number,
): string | null {
  return value === null ? null : boundLeadingText(value, maximum);
}

function boundLeadingText(value: string, maximum: number): string {
  if (value.length <= maximum) {
    return value;
  }
  const omitted = value.length - maximum;
  return `${value.slice(0, maximum)}\n[${omitted} caracteres adicionais omitidos]`;
}

function boundPath(value: string, maximum: number): string {
  if (value.length <= maximum) {
    return value;
  }
  const retainedAtEachEnd = Math.floor(maximum / 2);
  const omitted = value.length - retainedAtEachEnd * 2;
  return `${value.slice(0, retainedAtEachEnd)}…[${omitted} caracteres omitidos]…${value.slice(-retainedAtEachEnd)}`;
}

function noticesEqual(left: AppNotice, right: AppNotice): boolean {
  if (left.type !== right.type) {
    return false;
  }
  switch (left.type) {
    case "configWarning":
      return (
        right.type === "configWarning"
        && configWarningsEqual(left.value, right.value)
      );
    case "deprecationNotice":
      return (
        right.type === "deprecationNotice"
        && left.value.summary === right.value.summary
        && left.value.details === right.value.details
      );
    case "warning":
      return right.type === "warning" && left.message === right.message;
  }
}

function configWarningsEqual(
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
