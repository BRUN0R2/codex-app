import { Show } from "solid-js";

import type { ConfigWarningNotification } from "../../shared/codex/types";
import {
  CloseIcon,
  SettingsIcon,
  WarningIcon,
} from "../../shared/components/Icons";
import type { CodexSession } from "../session/createCodexSession";
import type { AppNotice } from "./createAppNoticeCenter";

interface AppNoticeCardProps {
  session: Pick<
    CodexSession,
    "appNotices" | "appNoticesOmitted" | "dismissAppNotice"
  >;
  onOpenSettings: () => void;
}

export function AppNoticeCard(props: AppNoticeCardProps) {
  const active = () => props.session.appNotices()[0];
  const remainingCount = () => Math.max(0, props.session.appNotices().length - 1);

  return (
    <Show when={active()}>
      {(notice) => (
        <section
          aria-labelledby="app-notice-title"
          aria-live="polite"
          class={`app-notice app-notice-${notice().type}`}
        >
          <WarningIcon size={18} />
          <div class="app-notice-copy">
            <div class="app-notice-heading">
              <strong id="app-notice-title">{noticeTitle(notice())}</strong>
              <Show when={remainingCount() > 0}>
                <span>+{remainingCount()}</span>
              </Show>
            </div>
            <Show when={noticeDetails(notice())}>
              {(details) => <p>{details()}</p>}
            </Show>
            <Show when={props.session.appNoticesOmitted() > 0}>
              <p class="app-notice-omitted">
                {props.session.appNoticesOmitted()} aviso(s) anterior(es) foram
                omitidos pelo limite local.
              </p>
            </Show>
            <Show when={noticeLocation(notice())}>
              {(location) => <code title={location()}>{location()}</code>}
            </Show>
          </div>
          <div class="app-notice-actions">
            <Show when={notice().type === "configWarning"}>
              <button onClick={props.onOpenSettings} type="button">
                <SettingsIcon size={14} />
                Configurações
              </button>
            </Show>
            <button
              aria-label="Dispensar aviso"
              class="app-notice-dismiss"
              onClick={() => props.session.dismissAppNotice(notice())}
              title="Dispensar"
              type="button"
            >
              <CloseIcon size={15} />
            </button>
          </div>
        </section>
      )}
    </Show>
  );
}

function noticeTitle(notice: AppNotice): string {
  switch (notice.type) {
    case "configWarning":
      return notice.value.summary || "A configuração precisa da sua atenção";
    case "deprecationNotice":
      return notice.value.summary || "Uma configuração está obsoleta";
    case "warning":
      return "O Codex encontrou um problema";
  }
}

function noticeDetails(notice: AppNotice): string | null {
  switch (notice.type) {
    case "configWarning":
    case "deprecationNotice":
      return notice.value.details;
    case "warning":
      return notice.message;
  }
}

function noticeLocation(notice: AppNotice): string | null {
  return notice.type === "configWarning"
    ? formatConfigLocation(notice.value)
    : null;
}

function formatConfigLocation(warning: ConfigWarningNotification): string | null {
  if (warning.path === undefined && warning.range === undefined) {
    return null;
  }
  if (warning.range === undefined) {
    return warning.path ?? null;
  }

  const start = formatPosition(warning.range.start);
  const end = formatPosition(warning.range.end);
  const range = start === end ? start : `${start}–${end}`;
  return warning.path === undefined
    ? `Linha ${range}`
    : `${warning.path}:${range}`;
}

function formatPosition(position: { line: number; column: number }): string {
  return `${position.line}:${position.column}`;
}
