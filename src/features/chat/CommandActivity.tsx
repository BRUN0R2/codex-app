import { Show } from "solid-js";

import {
  ChevronDownIcon,
  ChevronRightIcon,
  TerminalIcon,
} from "../../shared/components/Icons";
import type { CommandEntry } from "./timelineTypes";

interface CommandActivityProps {
  entry: CommandEntry;
  expanded: boolean;
  onToggle: () => void;
}

export function CommandActivity(props: CommandActivityProps) {
  const label = () =>
    props.entry.status === "inProgress"
      ? `Executando ${props.entry.command}`
      : props.entry.status === "failed"
        ? `Comando falhou: ${props.entry.command}`
        : `Comando executado: ${props.entry.command}`;
  return (
    <div class="activity-detail-row">
      <button
        aria-expanded={props.expanded}
        class="activity-item-button"
        onClick={props.onToggle}
        title={label()}
        type="button"
      >
        <TerminalIcon size={13} />
        <span class="activity-item-label">{label()}</span>
        <span class="activity-row-chevron">
          {props.expanded ? (
            <ChevronDownIcon size={12} />
          ) : (
            <ChevronRightIcon size={12} />
          )}
        </span>
      </button>
      <Show when={props.expanded}>
        <div class="command-card">
          <div class="detail-card-title">Shell</div>
          <pre>
            <span class="command-prompt">$ {props.entry.command}</span>
            <Show when={props.entry.outputOmittedCharacters > 0}>
              {`\n\n[${props.entry.outputOmittedCharacters} caracteres anteriores omitidos para limitar o uso de memória]`}
            </Show>
            <Show when={props.entry.output.length > 0}>
              {`\n\n${props.entry.output}`}
            </Show>
          </pre>
          <div class={`command-result status-${props.entry.status.toLowerCase()}`}>
            {commandResult(props.entry)}
          </div>
        </div>
      </Show>
    </div>
  );
}

function commandResult(entry: CommandEntry): string {
  if (entry.status === "completed") {
    return entry.exitCode === null || entry.exitCode === 0
      ? "✓ Sucesso"
      : `Código de saída ${entry.exitCode}`;
  }
  if (entry.status === "failed") {
    return entry.exitCode === null ? "Falhou" : `Falhou (${entry.exitCode})`;
  }
  if (entry.status === "declined") {
    return "Recusado";
  }
  return "Em andamento";
}
