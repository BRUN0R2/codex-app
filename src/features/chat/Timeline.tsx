import {
  Index,
  Match,
  Show,
  Switch,
  createEffect,
  createMemo,
  createSignal,
} from "solid-js";

import { ActivityGroup, LiveActivity } from "./ActivityGroup";
import { MessageView, PlanView } from "./ConversationEntry";
import { buildTimelineBlocks, type TimelineBlock } from "./timelineGrouping";
import type {
  MessageEntry,
  PlanEntry,
  TimelineEntry,
} from "./timelineTypes";

interface TimelineProps {
  busy: boolean;
  entries: TimelineEntry[];
}

export function Timeline(props: TimelineProps) {
  const blocks = createMemo(() => buildTimelineBlocks(props.entries));
  const [groupExpansion, setGroupExpansion] = createSignal<
    ReadonlyMap<string, boolean>
  >(new Map());
  const [expandedDetail, setExpandedDetail] = createSignal<string | null>(null);
  let endMarker: HTMLDivElement | undefined;
  let timelineElement: HTMLDivElement | undefined;
  let followLatest = true;

  createEffect(() => {
    props.entries;
    props.busy;
    if (followLatest) {
      queueMicrotask(() => endMarker?.scrollIntoView({ block: "end" }));
    }
  });

  function groupExpanded(
    block: Extract<TimelineBlock, { type: "activityGroup" }>,
  ) {
    return (
      groupExpansion().get(block.id) ??
      (block.status === "inProgress" && block.entries.length > 0)
    );
  }

  function toggleGroup(id: string, expanded: boolean) {
    setGroupExpansion((current) => {
      const next = new Map(current);
      next.set(id, !expanded);
      return next;
    });
  }

  function toggleDetail(id: string) {
    setExpandedDetail((current) => (current === id ? null : id));
  }

  return (
    <div
      class="timeline"
      onScroll={() => {
        const element = timelineElement;
        if (element !== undefined) {
          followLatest =
            element.scrollHeight - element.scrollTop - element.clientHeight < 120;
        }
      }}
      ref={timelineElement}
    >
      <Show
        when={props.entries.length > 0}
        fallback={
          <div class="empty-state">
            <div class="empty-orbit" aria-hidden="true">
              <span>C</span>
            </div>
            <h2>O que vamos construir?</h2>
            <p>
              Descreva uma tarefa, anexe arquivos ou cole uma imagem diretamente
              no campo abaixo.
            </p>
          </div>
        }
      >
        <div aria-live="polite" class="timeline-content" role="log">
          <Index each={blocks()}>
            {(block) => (
              <Switch>
                <Match
                  when={activityGroupBlock(block())}
                >
                  {(group) => (
                    <ActivityGroup
                      block={group()}
                      expanded={groupExpanded(group())}
                      expandedDetail={expandedDetail()}
                      onToggle={() =>
                        toggleGroup(group().id, groupExpanded(group()))
                      }
                      onToggleDetail={toggleDetail}
                    />
                  )}
                </Match>
                <Match
                  when={liveActivityBlock(block())}
                >
                  {(live) => <LiveActivity entry={live().entry} />}
                </Match>
                <Match
                  when={messageEntry(block())}
                >
                  {(message) => <MessageView entry={message()} />}
                </Match>
                <Match
                  when={planEntry(block())}
                >
                  {(plan) => <PlanView entry={plan()} />}
                </Match>
              </Switch>
            )}
          </Index>
          <Show when={props.busy && !hasStreamingAssistant(props.entries)}>
            <div class="thinking-row">
              <span />
              <span />
              <span />
            </div>
          </Show>
          <div ref={endMarker} />
        </div>
      </Show>
    </div>
  );
}

function activityGroupBlock(
  block: TimelineBlock,
): Extract<TimelineBlock, { type: "activityGroup" }> | undefined {
  return block.type === "activityGroup" ? block : undefined;
}

function liveActivityBlock(
  block: TimelineBlock,
): Extract<TimelineBlock, { type: "liveActivity" }> | undefined {
  return block.type === "liveActivity" ? block : undefined;
}

function messageEntry(block: TimelineBlock): MessageEntry | undefined {
  return block.type === "entry" && block.entry.type === "message"
    ? block.entry
    : undefined;
}

function planEntry(block: TimelineBlock): PlanEntry | undefined {
  return block.type === "entry" && block.entry.type === "plan"
    ? block.entry
    : undefined;
}

function hasStreamingAssistant(entries: TimelineEntry[]): boolean {
  return entries.some(
    (entry) =>
      entry.type === "message" &&
      entry.role === "assistant" &&
      entry.status === "streaming",
  );
}
