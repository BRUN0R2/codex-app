import { For, Show } from "solid-js";

import {
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  EditIcon,
  GlobeIcon,
  ImageIcon,
  ImagesIcon,
  SparkIcon,
  TerminalIcon,
  UsersIcon,
} from "../../shared/components/Icons";
import { ActivityDetail } from "./ActivityDetail";
import { ImagePreview } from "./ImagePreview";
import { fileName } from "./timelinePresentation";
import type { TimelineBlock } from "./timelineGrouping";
import { ToolBadge } from "./ToolActivity";
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
  const viewedImages = () => props.block.entries.filter(isImageViewEntry);
  const otherEntries = () => props.block.entries.filter(isNotImageViewEntry);

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
            <ActivityGroupIcon entries={props.block.entries} />
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
              <ActivityDetail
                entry={entry}
                expandedDetail={props.expandedDetail}
                onToggleDetail={props.onToggleDetail}
              />
            )}
          </For>
        </div>
      </Show>
    </section>
  );
}

function ActivityGroupIcon(props: { entries: GroupableTimelineEntry[] }) {
  if (onlyType(props.entries, "imageView")) {
    return <ImagesIcon size={14} />;
  }
  if (props.entries.some((entry) => entry.type === "fileChange")) {
    return <EditIcon size={14} />;
  }
  if (onlyTypes(props.entries, ["agentTool", "subAgentActivity"])) {
    return <UsersIcon size={14} />;
  }
  if (onlyType(props.entries, "webSearch")) {
    return <GlobeIcon size={14} />;
  }
  if (onlyType(props.entries, "sleep")) {
    return <ClockIcon size={14} />;
  }
  if (onlyType(props.entries, "hookPrompt")) {
    return <SparkIcon size={14} />;
  }
  if (onlyType(props.entries, "imageGeneration")) {
    return <ImageIcon size={14} />;
  }
  if (onlyType(props.entries, "tool")) {
    return <ToolBadge />;
  }
  return <TerminalIcon size={14} />;
}

function onlyType(
  entries: GroupableTimelineEntry[],
  type: GroupableTimelineEntry["type"],
): boolean {
  return entries.length > 0 && entries.every((entry) => entry.type === type);
}

function onlyTypes(
  entries: GroupableTimelineEntry[],
  types: ReadonlyArray<GroupableTimelineEntry["type"]>,
): boolean {
  return entries.length > 0 && entries.every((entry) => types.includes(entry.type));
}

function isImageViewEntry(
  entry: GroupableTimelineEntry,
): entry is ImageViewEntry {
  return entry.type === "imageView";
}

function isNotImageViewEntry(
  entry: GroupableTimelineEntry,
): entry is Exclude<GroupableTimelineEntry, ImageViewEntry> {
  return entry.type !== "imageView";
}
