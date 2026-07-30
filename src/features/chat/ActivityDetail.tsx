import { Match, Switch } from "solid-js";

import { AgentToolActivity, SubAgentActivity } from "./AgentActivity";
import { CommandActivity } from "./CommandActivity";
import { FileChangeActivity } from "./FileChangeActivity";
import { LiveActivity } from "./LiveActivity";
import {
  HookPromptActivity,
  ImageGenerationActivity,
  SleepActivity,
  WebSearchActivity,
} from "./ProtocolActivity";
import { GenericActivity, ToolActivity } from "./ToolActivity";
import type { GroupableTimelineEntry } from "./timelineTypes";

interface ActivityDetailProps {
  entry: Exclude<GroupableTimelineEntry, { type: "imageView" }>;
  expandedDetail: string | null;
  onToggleDetail: (id: string) => void;
}

export function ActivityDetail(props: ActivityDetailProps) {
  return (
    <Switch>
      <Match when={props.entry.status === "inProgress" ? props.entry : undefined}>
        {(entry) => <LiveActivity entry={entry()} />}
      </Match>
      <Match when={completedEntry(props.entry, "command")}>
        {(entry) => (
          <CommandActivity
            entry={entry()}
            expanded={props.expandedDetail === entry().id}
            onToggle={() => props.onToggleDetail(entry().id)}
          />
        )}
      </Match>
      <Match when={completedEntry(props.entry, "fileChange")}>
        {(entry) => (
          <FileChangeActivity
            entry={entry()}
            expandedDetail={props.expandedDetail}
            onToggleDetail={props.onToggleDetail}
          />
        )}
      </Match>
      <Match when={completedEntry(props.entry, "tool")}>
        {(entry) => (
          <ToolActivity
            entry={entry()}
            expanded={props.expandedDetail === entry().id}
            onToggle={() => props.onToggleDetail(entry().id)}
          />
        )}
      </Match>
      <Match when={completedEntry(props.entry, "agentTool")}>
        {(entry) => (
          <AgentToolActivity
            entry={entry()}
            expanded={props.expandedDetail === entry().id}
            onToggle={() => props.onToggleDetail(entry().id)}
          />
        )}
      </Match>
      <Match when={completedEntry(props.entry, "subAgentActivity")}>
        {(entry) => <SubAgentActivity entry={entry()} />}
      </Match>
      <Match when={completedEntry(props.entry, "webSearch")}>
        {(entry) => (
          <WebSearchActivity
            entry={entry()}
            expanded={props.expandedDetail === entry().id}
            onToggle={() => props.onToggleDetail(entry().id)}
          />
        )}
      </Match>
      <Match when={completedEntry(props.entry, "sleep")}>
        {(entry) => <SleepActivity entry={entry()} />}
      </Match>
      <Match when={completedEntry(props.entry, "hookPrompt")}>
        {(entry) => (
          <HookPromptActivity
            entry={entry()}
            expanded={props.expandedDetail === entry().id}
            onToggle={() => props.onToggleDetail(entry().id)}
          />
        )}
      </Match>
      <Match when={completedEntry(props.entry, "imageGeneration")}>
        {(entry) => (
          <ImageGenerationActivity
            entry={entry()}
            expanded={props.expandedDetail === entry().id}
            onToggle={() => props.onToggleDetail(entry().id)}
          />
        )}
      </Match>
      <Match when={completedEntry(props.entry, "activity")}>
        {(entry) => <GenericActivity entry={entry()} />}
      </Match>
    </Switch>
  );
}

type ActivityType = Exclude<GroupableTimelineEntry["type"], "imageView">;

function completedEntry<T extends ActivityType>(
  entry: ActivityDetailProps["entry"],
  type: T,
): Extract<GroupableTimelineEntry, { type: T }> | undefined {
  return entry.type === type && entry.status !== "inProgress"
    ? (entry as Extract<GroupableTimelineEntry, { type: T }>)
    : undefined;
}
