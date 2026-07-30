import { For, Show } from "solid-js";

import {
  ChevronDownIcon,
  ChevronRightIcon,
  TerminalIcon,
} from "../../shared/components/Icons";
import type { ActivityEntry, ToolEntry } from "./timelineTypes";

interface ToolActivityProps {
  entry: ToolEntry;
  expanded: boolean;
  onToggle: () => void;
}

export function ToolActivity(props: ToolActivityProps) {
  const hasDetail = () =>
    props.entry.detail !== null ||
    props.entry.progress.length > 0 ||
    props.entry.provider !== null ||
    props.entry.readOnly !== null ||
    props.entry.durationMs !== null;
  return (
    <div class="activity-detail-row">
      <button
        aria-expanded={props.expanded}
        class="activity-item-button"
        disabled={!hasDetail()}
        onClick={props.onToggle}
        type="button"
      >
        <TerminalIcon size={13} />
        <span class="activity-item-label">{toolLabel(props.entry)}</span>
        <Show when={props.entry.provider !== null}>
          <span class="activity-item-detail">{props.entry.provider}</span>
        </Show>
        <Show when={hasDetail()}>
          <span class="activity-row-chevron">
            {props.expanded ? (
              <ChevronDownIcon size={12} />
            ) : (
              <ChevronRightIcon size={12} />
            )}
          </span>
        </Show>
      </button>
      <Show when={props.expanded && hasDetail()}>
        <div class="command-card tool-card">
          <div class="detail-card-title">Resultado</div>
          <Show when={props.entry.progress.length > 0}>
            <div class="tool-progress-list">
              <For each={props.entry.progress}>
                {(message) => <div>{message}</div>}
              </For>
            </div>
          </Show>
          <Show when={props.entry.detail !== null}>
            <pre>{props.entry.detail}</pre>
          </Show>
          <Show
            when={
              props.entry.readOnly !== null || props.entry.durationMs !== null
            }
          >
            <div class="tool-meta">
              <Show when={props.entry.readOnly !== null}>
                <span>
                  {props.entry.readOnly ? "Somente leitura" : "Pode alterar dados"}
                </span>
              </Show>
              <Show when={props.entry.durationMs !== null}>
                <span>{formatDuration(props.entry.durationMs ?? 0)}</span>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000
    ? `${durationMs} ms`
    : `${(durationMs / 1_000).toLocaleString("pt-BR", {
        maximumFractionDigits: 1,
      })} s`;
}

export function GenericActivity(props: { entry: ActivityEntry }) {
  return (
    <div class="activity-item-static">
      <TerminalIcon size={13} />
      <span class="activity-item-label">{props.entry.label}</span>
      <Show when={props.entry.detail !== null}>
        <span class="activity-item-detail">{props.entry.detail}</span>
      </Show>
    </div>
  );
}

export function ToolBadge() {
  return (
    <span aria-hidden="true" class="tool-badge">
      C
    </span>
  );
}

function toolLabel(entry: ToolEntry): string {
  if (entry.status === "failed") {
    return `${entry.name} falhou`;
  }
  return entry.name;
}
