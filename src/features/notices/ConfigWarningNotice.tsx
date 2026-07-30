import { Show } from "solid-js";

import type { ConfigWarningNotification } from "../../shared/codex/types";
import {
  CloseIcon,
  SettingsIcon,
  ShieldAlertIcon,
} from "../../shared/components/Icons";
import type { CodexSession } from "../session/createCodexSession";

interface ConfigWarningNoticeProps {
  session: Pick<CodexSession, "configWarnings" | "dismissConfigWarning">;
  onOpenSettings: () => void;
}

export function ConfigWarningNotice(props: ConfigWarningNoticeProps) {
  const active = () => props.session.configWarnings()[0];
  const remainingCount = () => Math.max(0, props.session.configWarnings().length - 1);

  return (
    <Show when={active()}>
      {(warning) => (
        <section
          aria-labelledby="config-warning-title"
          aria-live="polite"
          class="config-warning-notice"
        >
          <ShieldAlertIcon size={18} />
          <div class="config-warning-copy">
            <div class="config-warning-heading">
              <strong id="config-warning-title">
                {warning().summary || "A configuração precisa da sua atenção"}
              </strong>
              <Show when={remainingCount() > 0}>
                <span>+{remainingCount()}</span>
              </Show>
            </div>
            <Show when={warning().details}>
              {(details) => <p>{details()}</p>}
            </Show>
            <Show when={formatLocation(warning())}>
              {(location) => <code title={location()}>{location()}</code>}
            </Show>
          </div>
          <div class="config-warning-actions">
            <button onClick={props.onOpenSettings} type="button">
              <SettingsIcon size={14} />
              Configurações
            </button>
            <button
              aria-label="Dispensar aviso de configuração"
              class="config-warning-dismiss"
              onClick={() => props.session.dismissConfigWarning(warning())}
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

function formatLocation(warning: ConfigWarningNotification): string | null {
  if (warning.path === undefined && warning.range === undefined) {
    return null;
  }
  if (warning.range === undefined) {
    return warning.path ?? null;
  }

  const start = formatPosition(warning.range.start);
  const end = formatPosition(warning.range.end);
  const range = start === end ? start : `${start}–${end}`;
  return warning.path === undefined ? `Linha ${range}` : `${warning.path}:${range}`;
}

function formatPosition(position: { line: number; column: number }): string {
  return `${position.line}:${position.column}`;
}
