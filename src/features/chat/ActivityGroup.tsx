import { For, Match, Show, Switch } from "solid-js";

import {
  ChevronDownIcon,
  ChevronRightIcon,
  EditIcon,
  ImagesIcon,
  TerminalIcon,
} from "../../shared/components/Icons";
import { CommandActivity } from "./CommandActivity";
import { FileChangeActivity } from "./FileChangeActivity";
import { ImagePreview } from "./ImagePreview";
import { fileName } from "./timelinePresentation";
import type { TimelineBlock } from "./timelineGrouping";
import { GenericActivity, ToolActivity, ToolBadge } from "./ToolActivity";
import type {
  GroupableTimelineEntry,
  ImageViewEntry,
} from "./timelineTypes";

interface ActivityGroupProps {
  block: Extract<TimelineBlock, { type: "activityGroup" }>;
  expanded: boolean;
  expandedDetail: string | null;
  onToggle: () => void;
  onToggleDetail: (id: string) => void;
}

export function ActivityGroup(props: ActivityGroupProps) {
  const editsFiles = () =>
    props.block.entries.some((entry) => entry.type === "fileChange");
  const viewedImages = () => props.block.entries.filter(isImageViewEntry);
  const otherEntries = () =>
    props.block.entries.filter((entry) => entry.type !== "imageView");
  const onlyUsesTools = () =>
    props.block.entries.length > 0 &&
    props.block.entries.every((entry) => entry.type === "tool");

  return (
    <section
      class={`activity-group header-${props.block.header.kind} status-${props.block.status.toLowerCase()}`}
    >
      <button
        aria-expanded={props.expanded}
        class="activity-group-header"
        onClick={props.onToggle}
        type="button"
      >
        <Show when={props.block.header.kind === "activity"}>
          <span class="activity-group-icon">
            {viewedImages().length === props.block.entries.length ? (
              <ImagesIcon size={14} />
            ) : editsFiles() ? (
              <EditIcon size={14} />
            ) : onlyUsesTools() ? (
              <ToolBadge />
            ) : (
              <TerminalIcon size={14} />
            )}
          </span>
        </Show>
        <span class="activity-group-label">{props.block.header.label}</span>
        <span class="activity-group-chevron">
          {props.expanded ? (
            <ChevronDownIcon size={13} />
          ) : (
            <ChevronRightIcon size={13} />
          )}
        </span>
      </button>

      <Show when={props.expanded}>
        <div class="activity-group-content">
          <Show when={viewedImages().length > 0}>
            <div class="viewed-image-grid">
              <For each={viewedImages()}>
                {(entry) => (
                  <ImagePreview
                    name={fileName(entry.path) || "Imagem visualizada"}
                    path={entry.path}
                  />
                )}
              </For>
            </div>
          </Show>
          <For each={otherEntries()}>
            {(entry) => (
              <Switch>
                <Match when={entry.status === "inProgress" ? entry : undefined}>
                  {(live) => <LiveActivity entry={live()} />}
                </Match>
                <Match
                  when={
                    entry.type === "command" && entry.status !== "inProgress"
                      ? entry
                      : undefined
                  }
                >
                  {(command) => (
                    <CommandActivity
                      entry={command()}
                      expanded={props.expandedDetail === command().id}
                      onToggle={() => props.onToggleDetail(command().id)}
                    />
                  )}
                </Match>
                <Match
                  when={
                    entry.type === "fileChange" && entry.status !== "inProgress"
                      ? entry
                      : undefined
                  }
                >
                  {(fileChange) => (
                    <FileChangeActivity
                      entry={fileChange()}
                      expandedDetail={props.expandedDetail}
                      onToggleDetail={props.onToggleDetail}
                    />
                  )}
                </Match>
                <Match
                  when={
                    entry.type === "tool" && entry.status !== "inProgress"
                      ? entry
                      : undefined
                  }
                >
                  {(tool) => (
                    <ToolActivity
                      entry={tool()}
                      expanded={props.expandedDetail === tool().id}
                      onToggle={() => props.onToggleDetail(tool().id)}
                    />
                  )}
                </Match>
                <Match
                  when={
                    entry.type === "activity" && entry.status !== "inProgress"
                      ? entry
                      : undefined
                  }
                >
                  {(activity) => <GenericActivity entry={activity()} />}
                </Match>
              </Switch>
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}

interface LiveActivityProps {
  entry: GroupableTimelineEntry;
}

export function LiveActivity(props: LiveActivityProps) {
  const label = () => {
    switch (props.entry.type) {
      case "command":
        return `Executando ${props.entry.command}`;
      case "fileChange":
        return "Editando arquivos";
      case "imageView":
        return "Visualizando imagem";
      case "tool":
        return `Usando ${props.entry.name}`;
      case "activity":
        return props.entry.label;
    }
  };
  return (
    <div class="live-activity" title={label()}>
      {props.entry.type === "fileChange" ? (
        <EditIcon size={13} />
      ) : props.entry.type === "imageView" ? (
        <ImagesIcon size={13} />
      ) : props.entry.type === "tool" ? (
        <ToolBadge />
      ) : (
        <TerminalIcon size={13} />
      )}
      <span class="live-activity-label">{label()}</span>
    </div>
  );
}

function isImageViewEntry(
  entry: GroupableTimelineEntry,
): entry is ImageViewEntry {
  return entry.type === "imageView";
}
