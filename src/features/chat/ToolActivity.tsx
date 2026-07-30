import { Show } from "solid-js";

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
  return (
    <div class="activity-detail-row">
      <button
        aria-expanded={props.expanded}
        class="activity-item-button"
        disabled={props.entry.detail === null}
        onClick={props.onToggle}
        type="button"
      >
        <TerminalIcon size={13} />
        <span class="activity-item-label">{toolLabel(props.entry)}</span>
        <Show when={props.entry.detail !== null}>
          <span class="activity-row-chevron">
            {props.expanded ? (
              <ChevronDownIcon size={12} />
            ) : (
              <ChevronRightIcon size={12} />
            )}
          </span>
        </Show>
      </button>
      <Show when={props.expanded && props.entry.detail !== null}>
        <div class="command-card tool-card">
          <div class="detail-card-title">Resultado</div>
          <pre>{props.entry.detail}</pre>
        </div>
      </Show>
    </div>
  );
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
  return entry.kind === "collaboration"
    ? `Agente: ${entry.name}`
    : entry.name;
}
