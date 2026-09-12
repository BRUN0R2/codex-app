import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
  untrack,
} from "solid-js";

import type { FileChange, ThreadItem, VisibleThreadItem } from "../contracts/types";
import { useI18n } from "../i18n/context";
import { formatMessage } from "../i18n/messages";

import { projectName } from "../state/projects";
import type { VisibleThreadTurn } from "../state/visibleTurnSequence";
import { activityContentProjectionCache } from "./activityContentProjectionCache";
import { fileName, isFileReadTool, toolIconName, toolLabel } from "./activityLabels";
import {
  type ActivityListProjection,
  activityListEntryDisclosureKey,
  COLLAPSED_ACTIVITY_ITEM_ESTIMATE_PX,
  createActivityListProjection,
  estimateActivityListEntrySize,
} from "./activityListProjection";
import { scheduleCadencedActivityShimmer } from "./activityShimmer";
import {
  type AgentActivityItem,
  type AgentActivityKind,
  type AgentActivityRenderUnit,
  activeAgentActivity,
  agentActivityHeadlineLabel,
  type ImageViewItem,
  isTerminalReadTool,
  shouldRenderAgentActivityGroup,
  summarizeAgentActivity,
  webSearchActivityTitle,
} from "./agentActivityPresentation";
import { CodexGlyph } from "./CodexGlyph";
import { DiffView } from "./DiffView";
import { fileChangeLineStats } from "./fileChangeStats";
import { frontendFailureMessage, useFrontendFailureReporter } from "./frontendFailure";
import { Icon, type IconName } from "./Icon";
import { starterSuggestions } from "./starterSuggestions";
import { ThreadOutputView } from "./ThreadOutputView";
import { AgentMessage, CommentaryMessage, UserMessage } from "./TimelineMessages";
import type { TimelineDisclosureKey } from "./timelineDisclosure";
import {
  TimelineDisclosureContext,
  timelineDisclosureChildKey,
  useTimelineDisclosure,
  useTimelineDisclosureStorageKey,
} from "./timelineDisclosureContext";
import { timelineFileChangeIdentity, timelineItemRenderIdentity } from "./timelineIdentity";
import {
  commandHeadline,
  commandLiveOutputText,
  commandOutputText,
  commandPollActivityTitle,
  fileChangeActionLabel,
  fileChangeGroupTitle,
  fileReadActivityTitle,
  fileReadItemTitle,
  formatCompactElapsedSeconds,
  shouldShowCommandDurationSuffix,
  terminalReadActivityTitle,
  toolActivityTitle,
  toolOutputText,
  visibleCommandDurationMs,
} from "./timelinePresentation";
import {
  ACTIVITY_ITEM_VIRTUALIZATION_THRESHOLD,
  ACTIVITY_OPEN_DISCLOSURE_VIRTUALIZATION_THRESHOLD,
  bindControlledTimelineDisclosure,
  bindControlledTimelineDisclosureKey,
  DIFF_COPY_FEEDBACK_RESET_MILLISECONDS,
  IMAGE_OUTPUT_PRESENTATION,
  LIVE_OUTPUT_FOLLOW_EPSILON_PX,
} from "./timelineShared";
import { VirtualizedActivityList } from "./VirtualizedActivityList";

export function asImageViewGroup(
  unit: AgentActivityRenderUnit,
): Extract<AgentActivityRenderUnit, { readonly kind: "imageView" }> | null {
  return unit.kind === "imageView" ? unit : null;
}

export function asAgentActivityGroup(
  unit: AgentActivityRenderUnit,
): Extract<AgentActivityRenderUnit, { readonly kind: "activityGroup" }> | null {
  return unit.kind === "activityGroup" ? unit : null;
}

export function asAgentActivityItem(
  unit: AgentActivityRenderUnit,
): Extract<AgentActivityRenderUnit, { readonly kind: "item" }> | null {
  return unit.kind === "item" ? unit : null;
}

export function ImageViewGroup(props: {
  readonly disclosureKey: string;
  readonly items: readonly ImageViewItem[];
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().timeline;
  const disclosure = useTimelineDisclosure(() => props.disclosureKey);
  const label = () =>
    props.items.length === 1
      ? messages().viewedOneImage
      : formatMessage(messages().viewedImages, { count: props.items.length });

  return (
    <details class="activity-card image-view-group" open={disclosure.isOpen()}>
      <summary
        class="activity-summary"
        data-timeline-disclosure=""
        ref={(element) => bindControlledTimelineDisclosure(element, disclosure)}
      >
        <TimelineActivityIcon name="image" />
        <span class="activity-title">{label()}</span>
        <TimelineDisclosureIcon expanded={disclosure.isOpen()} />
      </summary>
      <Show when={disclosure.isOpen()}>
        <section aria-label={label()} class="image-view-grid">
          <For each={props.items}>
            {(item) => (
              <Show
                when={item.output}
                fallback={
                  <span class="tool-image-output-error">{messages().imageUnavailable}</span>
                }
              >
                {(output) => (
                  <ThreadOutputView
                    format={toolOutputText}
                    output={output()}
                    presentation={IMAGE_OUTPUT_PRESENTATION}
                  />
                )}
              </Show>
            )}
          </For>
        </section>
      </Show>
    </details>
  );
}

export function AgentActivityGroup(props: {
  readonly clock: number;
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly disclosureKey: string;
  readonly isCurrent: boolean;
  readonly items: readonly AgentActivityItem[];
  readonly reasoningHeading: string | null;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().timeline;
  const disclosure = useTimelineDisclosure(() => props.disclosureKey);
  const listProjection = createMemo(() => createActivityListProjection(props.items));
  const summaries = createMemo(() => summarizeAgentActivity(props.items, messages()));
  const activeActivity = createMemo(() => activeAgentActivity(props.items, messages()));
  const estimateStorageKeys = new Map<string, TimelineDisclosureKey>();
  let estimateStorageKeyPrefix: TimelineDisclosureKey | null = null;
  const iconKind = createMemo(() =>
    props.isCurrent ? (activeActivity()?.kind ?? summaries()[0]?.kind) : summaries()[0]?.kind,
  );
  const title = createMemo(() =>
    agentActivityHeadlineLabel(
      props.items,
      props.isCurrent,
      props.reasoningHeading,
      messages(),
      i18n.locale(),
    ),
  );
  const estimateListEntrySize = (entryKey: string, entryIndex: number): number => {
    const entry = listProjection().entryAt(entryIndex, entryKey);
    const prefix = disclosure.storageKey();
    if (estimateStorageKeyPrefix !== prefix) {
      estimateStorageKeys.clear();
      estimateStorageKeyPrefix = prefix;
    }
    let storageKey = estimateStorageKeys.get(entryKey);
    if (storageKey === undefined) {
      storageKey = timelineDisclosureChildKey(prefix, activityListEntryDisclosureKey(entry));
      estimateStorageKeys.set(entryKey, storageKey);
      if (estimateStorageKeys.size > 512) {
        const oldestKey = estimateStorageKeys.keys().next().value;
        if (oldestKey !== undefined) {
          estimateStorageKeys.delete(oldestKey);
        }
      }
    }
    return estimateActivityListEntrySize(
      entry,
      disclosure.descendantContext.store.read(storageKey),
      props.diffDisplay ?? "unified",
    );
  };
  const usesUniformCollapsedFileEstimates = createMemo(
    () =>
      disclosure.openDescendantCount() === 0 &&
      props.items.every((item) => item.type === "fileChange"),
  );
  const uniformListEntryEstimate = createMemo<number | undefined>(() => {
    if (!props.items.every((item) => item.type === "fileChange")) {
      return undefined;
    }
    const openCount = disclosure.openDescendantCount();
    if (openCount === 0) {
      return COLLAPSED_ACTIVITY_ITEM_ESTIMATE_PX;
    }
    const projection = listProjection();
    if (openCount !== projection.count || projection.count === 0) {
      return undefined;
    }
    const sampleCount = Math.min(9, projection.count);
    let sampledSize = 0;
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      const entryIndex =
        sampleCount === 1
          ? 0
          : Math.round((sampleIndex * (projection.count - 1)) / (sampleCount - 1));
      sampledSize += estimateActivityListEntrySize(
        projection.entryAt(entryIndex),
        true,
        props.diffDisplay ?? "unified",
      );
    }
    return Math.round(sampledSize / sampleCount);
  });

  return (
    <Show
      when={shouldRenderAgentActivityGroup(props.items, props.isCurrent)}
      fallback={
        <Show when={props.items[0]}>
          {(item) => (
            <TimelineItem clock={props.clock} diffDisplay={props.diffDisplay} item={item()} />
          )}
        </Show>
      }
    >
      <details class="activity-card agent-activity-group" open={disclosure.isOpen()}>
        <summary
          class="activity-summary agent-activity-summary"
          data-timeline-disclosure=""
          ref={(element) => bindControlledTimelineDisclosure(element, disclosure)}
        >
          <Show when={iconKind()}>
            {(kind) => <TimelineActivityIcon name={agentActivityIcon(kind())} />}
          </Show>
          <ActivityHeadline active={props.isCurrent} text={title()} />
          <TimelineDisclosureIcon expanded={disclosure.isOpen()} />
        </summary>
        <Show when={disclosure.isOpen()}>
          <TimelineDisclosureContext.Provider value={disclosure.descendantContext}>
            <div class="agent-activity-viewport">
              <VirtualizedActivityList
                contentRevision={disclosure.subtreeRevision()}
                estimateItemSize={
                  usesUniformCollapsedFileEstimates() ? undefined : estimateListEntrySize
                }
                estimateRevision={disclosure.openDescendantCount()}
                groupKey={disclosure.storageKey()}
                itemSource={listProjection()}
                renderItem={(projection, entryKey, entryIndex, materializeBody) => (
                  <ActivityListProjectionView
                    clock={props.clock}
                    diffDisplay={props.diffDisplay}
                    entryIndex={entryIndex}
                    entryKey={entryKey}
                    materializeBody={materializeBody}
                    projection={projection}
                  />
                )}
                renderUniformItem={(projection, entryKey, entryIndex) => (
                  <CollapsedActivityListProjectionView
                    entryIndex={entryIndex}
                    entryKey={entryKey}
                    projection={projection}
                  />
                )}
                reuseGroupForItem={(projection, _entryKey, entryIndex) =>
                  projection.reuseGroupAt(entryIndex)
                }
                uniformEstimate={uniformListEntryEstimate()}
                virtualize={
                  listProjection().count > ACTIVITY_ITEM_VIRTUALIZATION_THRESHOLD ||
                  disclosure.openDescendantCount() >
                    ACTIVITY_OPEN_DISCLOSURE_VIRTUALIZATION_THRESHOLD
                }
              />
            </div>
          </TimelineDisclosureContext.Provider>
        </Show>
      </details>
    </Show>
  );
}

export function ActivityListProjectionView(props: {
  readonly clock: number;
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly entryIndex: () => number;
  readonly entryKey: () => string;
  readonly materializeBody: () => boolean;
  readonly projection: () => ActivityListProjection;
}) {
  const kind = untrack(() => props.projection().kindAt(props.entryIndex()));
  const change = () => props.projection().fileChangeAt(props.entryIndex(), props.entryKey());
  const item = () => props.projection().itemAt(props.entryIndex(), props.entryKey());
  return kind === "fileChange" ? (
    <Change
      change={change()}
      diffDisplay={props.diffDisplay}
      disclosureKey={props.entryKey()}
      materializeBody={props.materializeBody}
    />
  ) : (
    <TimelineItem
      clock={props.clock}
      diffDisplay={props.diffDisplay}
      item={item()}
      materializeBody={props.materializeBody}
      variant="grouped"
    />
  );
}

export function CollapsedActivityListProjectionView(props: {
  readonly entryIndex: () => number;
  readonly entryKey: () => string;
  readonly projection: () => ActivityListProjection;
}) {
  const change = createMemo(() =>
    props.projection().fileChangeAt(props.entryIndex(), props.entryKey()),
  );
  return <CollapsedChange change={change()} disclosureKey={props.entryKey()} />;
}

export function agentActivityIcon(kind: AgentActivityKind | undefined): IconName {
  switch (kind) {
    case "fileChanges":
      return "edit";
    case "fileReads":
      return "read";
    case "exploration":
      return "file";
    case "commands":
    case "terminalRead":
      return "terminal";
    case "browser":
    case "webSearch":
      return "globe";
    default:
      return "sparkles";
  }
}

export function TimelineActivityIcon(props: { readonly name: IconName }) {
  return (
    <span aria-hidden="true" class="activity-icon">
      <Icon name={props.name} size={16} />
    </span>
  );
}

export function TimelineDisclosureIcon(props: {
  readonly class?: string | undefined;
  readonly expanded: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      class={props.class ?? "activity-chevron"}
      classList={{ "is-expanded": props.expanded }}
    >
      <Icon name="chevronRight" size={14} />
    </span>
  );
}

export function EmptyConversation(props: {
  readonly mode: "chat" | "work" | "codex";
  readonly onSelectSuggestion: (prompt: string) => void;
  readonly workspace: string | null;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().timeline;
  const suggestions = () => starterSuggestions(messages());
  return (
    <section aria-labelledby="empty-conversation-title" class="empty-conversation">
      <Show when={props.mode === "codex"}>
        <div class="empty-orb">
          <CodexGlyph />
        </div>
      </Show>
      <h2 id="empty-conversation-title">
        <Switch>
          <Match when={props.mode === "chat"}>{messages().ready}</Match>
          <Match when={props.mode === "work"}>{messages().workQuestion}</Match>
          <Match when={props.mode === "codex"}>
            <Show when={props.workspace} fallback={messages().todayQuestion}>
              {(workspace) =>
                formatMessage(messages().projectQuestion, { project: projectName(workspace()) })
              }
            </Show>
          </Match>
        </Switch>
      </h2>
      <Show when={props.mode === "codex" && props.workspace !== null}>
        <fieldset class="starter-suggestions">
          <legend class="visually-hidden">{messages().starterSuggestions}</legend>
          <For each={suggestions()}>
            {(suggestion) => (
              <button onClick={() => props.onSelectSuggestion(suggestion.prompt)} type="button">
                <Icon
                  color={suggestion.iconColor}
                  name={suggestion.icon}
                  size={22}
                  strokeWidth={2}
                />
                <span>{suggestion.label}</span>
              </button>
            )}
          </For>
        </fieldset>
      </Show>
    </section>
  );
}

export interface TimelineItemProps {
  readonly active?: boolean | undefined;
  readonly clock?: number | undefined;
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly item: VisibleThreadItem;
  readonly materializeBody?: (() => boolean) | undefined;
  readonly streaming?: boolean | undefined;
  readonly variant?: "default" | "grouped" | undefined;
}

export function TimelineItem(props: TimelineItemProps) {
  if (props.variant === "grouped") {
    return (
      <TimelineItemContent
        active={props.active}
        clock={props.clock}
        diffDisplay={props.diffDisplay}
        item={props.item}
        materializeBody={props.materializeBody}
        streaming={props.streaming}
        variant={props.variant}
      />
    );
  }
  return (
    <Show keyed when={timelineItemRenderIdentity(props.item)}>
      {(_identity) => (
        <TimelineItemContent
          active={props.active}
          clock={props.clock}
          diffDisplay={props.diffDisplay}
          item={props.item}
          materializeBody={props.materializeBody}
          streaming={props.streaming}
          variant={props.variant}
        />
      )}
    </Show>
  );
}

export function TimelineItemContent(props: TimelineItemProps) {
  switch (props.item.type) {
    case "userMessage":
      return <UserMessage item={props.item} />;
    case "agentMessage":
      return props.item.phase === "commentary" ? (
        <CommentaryMessage item={props.item} streaming={props.streaming === true} />
      ) : (
        <AgentMessage item={props.item} streaming={props.streaming === true} />
      );
    case "contextCompaction":
      return <ContextCompaction active={props.active} item={props.item} />;
    case "reasoning":
      return null;
    case "plan":
      return null;
    case "commandExecution":
      return (
        <CommandItem
          clock={props.clock ?? Date.now()}
          item={props.item}
          materializeBody={props.materializeBody}
          variant={props.variant}
        />
      );
    case "fileChange":
      return (
        <FileChangeItem
          diffDisplay={props.diffDisplay}
          item={props.item}
          materializeBody={props.materializeBody}
          variant={props.variant}
        />
      );
    case "toolExecution":
      return (
        <ToolItem
          item={props.item}
          materializeBody={props.materializeBody}
          variant={props.variant}
        />
      );
  }
}

export function ContextCompaction(props: {
  readonly active?: boolean | undefined;
  readonly item: Extract<ThreadItem, { type: "contextCompaction" }>;
}) {
  const i18n = useI18n();
  return (
    <section class="context-compaction-row" id={props.item.id}>
      <TimelineActivityIcon name="layers" />
      <ActivityHeadline
        active={props.active === true}
        class="activity-title compaction-text"
        text={i18n.messages().timeline.compactingContext}
      />
    </section>
  );
}

export function ActivityHeadline(props: {
  readonly active?: boolean | undefined;
  readonly class?: string;
  readonly shimmer?: boolean | undefined;
  readonly text: string;
}) {
  const [shimmerActive, setShimmerActive] = createSignal(false);
  const shimmerEnabled = () => props.active === true && props.shimmer !== false;
  let stopShimmer = () => {};

  createEffect(() => {
    stopShimmer();
    stopShimmer = () => {};
    if (
      !shimmerEnabled() ||
      (typeof window !== "undefined" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches)
    ) {
      return;
    }
    stopShimmer = scheduleCadencedActivityShimmer(setShimmerActive);
  });
  onCleanup(() => stopShimmer());

  return (
    <span
      class={props.class ?? "activity-title"}
      classList={{
        "is-running": props.active === true,
        "is-shimmer-active": shimmerActive(),
      }}
    >
      <span class="activity-title-base">{props.text}</span>
      <Show when={shimmerEnabled()}>
        <span aria-hidden="true" class="activity-title-sweep">
          <span class="activity-title-highlight">{props.text}</span>
        </span>
      </Show>
    </span>
  );
}

export function CommandItem(props: {
  readonly clock: number;
  readonly item: Extract<ThreadItem, { type: "commandExecution" }>;
  readonly materializeBody?: (() => boolean) | undefined;
  readonly variant?: "default" | "grouped" | undefined;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().timeline;
  let outputScrollElement: HTMLDivElement | undefined;
  let followLiveOutput = true;
  let knownOutputScrollLeft = 0;
  let knownOutputScrollTop = 0;
  let activeItemId = props.item.id;
  const disclosure = useTimelineDisclosure(() => `command:${props.item.id}`);
  const output = () => props.item.aggregatedOutput;
  const liveOutput = () => commandLiveOutputText(props.item.liveOutput, messages());
  const duration = () => commandDurationLabel(props.item, props.clock);
  const title = () =>
    commandHeadline(
      props.item.command,
      props.item.status,
      props.variant === "grouped" ? false : disclosure.isOpen(),
      duration(),
      messages(),
    );

  createEffect(() => {
    const itemId = props.item.id;
    if (itemId === activeItemId) {
      return;
    }
    activeItemId = itemId;
    followLiveOutput = true;
    if (
      outputScrollElement !== undefined &&
      (knownOutputScrollTop !== 0 || knownOutputScrollLeft !== 0)
    ) {
      outputScrollElement.scrollTop = 0;
      outputScrollElement.scrollLeft = 0;
    }
    knownOutputScrollTop = 0;
    knownOutputScrollLeft = 0;
  });

  createEffect(() => {
    const currentLiveOutput = liveOutput();
    if (
      currentLiveOutput === null ||
      output() !== null ||
      props.item.status !== "inProgress" ||
      !disclosure.isOpen() ||
      !followLiveOutput
    ) {
      return;
    }
    queueMicrotask(() => {
      if (outputScrollElement !== undefined && followLiveOutput) {
        outputScrollElement.scrollTop = outputScrollElement.scrollHeight;
      }
    });
  });

  function updateLiveOutputFollow(): void {
    if (outputScrollElement === undefined) {
      return;
    }
    knownOutputScrollTop = outputScrollElement.scrollTop;
    knownOutputScrollLeft = outputScrollElement.scrollLeft;
    followLiveOutput =
      outputScrollElement.scrollHeight - outputScrollElement.clientHeight - knownOutputScrollTop <=
      LIVE_OUTPUT_FOLLOW_EPSILON_PX;
  }

  return (
    <details
      class="activity-card command-activity-card"
      classList={{ "grouped-activity-item": props.variant === "grouped" }}
      open={disclosure.isOpen()}
    >
      <summary
        class="activity-summary"
        data-timeline-disclosure=""
        ref={(element) => bindControlledTimelineDisclosure(element, disclosure)}
      >
        <TimelineActivityIcon name="terminal" />
        <ActivityHeadline
          active={props.item.status === "inProgress"}
          shimmer={props.variant !== "grouped"}
          text={title()}
        />
        <Show when={shouldShowCommandDurationSuffix(props.item.status) && duration()}>
          {(visibleDuration) => <span class="activity-elapsed">· {visibleDuration()}</span>}
        </Show>
        <TimelineDisclosureIcon expanded={disclosure.isOpen()} />
      </summary>
      <Show when={disclosure.isOpen() && (props.materializeBody?.() ?? true)}>
        <div class="command-card-inner">
          <div class="command-card-header">{messages().shell}</div>
          <div
            class="command-card-scroll"
            data-timeline-scroll-region=""
            onScroll={updateLiveOutputFollow}
            ref={outputScrollElement}
          >
            <div class="command-card-prompt">
              <span class="prompt-symbol">$</span> {props.item.command}
            </div>
            <Show
              when={output()}
              fallback={
                <Show when={liveOutput()}>
                  {(visibleOutput) => (
                    <pre class="command-live-output">
                      <code>{visibleOutput()}</code>
                    </pre>
                  )}
                </Show>
              }
            >
              {(visibleOutput) => (
                <ThreadOutputView format={commandOutputText} output={visibleOutput()} />
              )}
            </Show>
          </div>
          <Show when={props.item.status === "failed" || props.item.status === "declined"}>
            <div class="command-card-footer">
              <span class="status-failed-text">
                <Icon name="close" size={12} />
                {props.item.status === "declined" ? messages().declined : messages().failed}
              </span>
            </div>
          </Show>
        </div>
      </Show>
    </details>
  );
}

export function commandDurationLabel(
  item: Extract<ThreadItem, { type: "commandExecution" }>,
  clock: number,
): string | null {
  const duration = visibleCommandDurationMs(item.status, item.startedAt, item.durationMs, clock);
  return duration === null ? null : formatCompactElapsedSeconds(Math.floor(duration / 1_000));
}

export function ToolItem(props: {
  readonly item: Extract<ThreadItem, { type: "toolExecution" }>;
  readonly materializeBody?: (() => boolean) | undefined;
  readonly variant?: "default" | "grouped" | undefined;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().timeline;
  const disclosure = useTimelineDisclosure(() => `tool:${props.item.id}`);
  const description = () => props.item.description || toolLabel(props.item.name, messages());
  const isWebSearch = () => props.item.name === "web_search" || props.item.name === "web_fetch";
  const isCommandPoll = () => props.item.name === "poll_command";
  const isFileRead = () => isFileReadTool(props.item.name);
  const isTerminalRead = () => isTerminalReadTool(props.item.name);
  const output = () => props.item.output;
  const hasDetails = () =>
    output() !== null || props.item.status === "failed" || props.item.status === "declined";
  const fileReadTitle = () => {
    const base = fileReadActivityTitle(props.item.status, messages());
    return props.item.outputPresentation.type === "sourceFile"
      ? fileReadItemTitle(
          props.item.status,
          fileName(props.item.outputPresentation.path),
          messages(),
        )
      : base;
  };
  const title = () =>
    isCommandPoll()
      ? commandPollActivityTitle(props.item.status, messages())
      : isTerminalRead()
        ? terminalReadActivityTitle(props.item.status, messages())
        : isFileRead()
          ? fileReadTitle()
          : isWebSearch()
            ? webSearchActivityTitle(description(), props.item.status, messages())
            : toolActivityTitle(description(), props.item.status, disclosure.isOpen(), messages());

  createEffect(() => {
    if (!disclosure.isOpen()) {
      return;
    }
    const item = props.item;
    const currentOutput = item.output;
    if (currentOutput === null || item.outputPresentation.type !== "sourceFile") {
      return;
    }
    const text = toolOutputText(currentOutput.preview);
    if (text !== null) {
      activityContentProjectionCache.sourceProjection(
        currentOutput,
        text,
        item.outputPresentation.path,
      );
    }
  });

  return (
    <Show
      when={hasDetails()}
      fallback={
        <div
          class="activity-card activity-summary tool-activity-card tool-activity-row"
          classList={{ "grouped-activity-item": props.variant === "grouped" }}
        >
          <ToolActivityHeadline
            item={props.item}
            shimmer={props.variant !== "grouped"}
            title={title()}
          />
        </div>
      }
    >
      <details
        class="activity-card tool-activity-card"
        classList={{ "grouped-activity-item": props.variant === "grouped" }}
        open={disclosure.isOpen()}
      >
        <summary
          class="activity-summary"
          data-timeline-disclosure=""
          ref={(element) => bindControlledTimelineDisclosure(element, disclosure)}
        >
          <ToolActivityHeadline
            item={props.item}
            shimmer={props.variant !== "grouped"}
            title={title()}
          />
          <TimelineDisclosureIcon expanded={disclosure.isOpen()} />
        </summary>
        <Show when={disclosure.isOpen() && (props.materializeBody?.() ?? true)}>
          <div class="command-card-inner">
            <div class="command-card-header">{toolLabel(props.item.name, messages())}</div>
            <Show when={output()}>
              {(visibleOutput) => (
                <div class="command-card-scroll" data-timeline-scroll-region="">
                  <ThreadOutputView
                    format={toolOutputText}
                    output={visibleOutput()}
                    presentation={props.item.outputPresentation}
                  />
                </div>
              )}
            </Show>
            <Show when={props.item.status === "failed" || props.item.status === "declined"}>
              <div class="command-card-footer">
                <span class="status-failed-text">
                  <Icon name="close" size={12} />
                  {props.item.status === "declined"
                    ? messages().toolDeclinedFooter
                    : messages().failed}
                </span>
              </div>
            </Show>
          </div>
        </Show>
      </details>
    </Show>
  );
}

export function ToolActivityHeadline(props: {
  readonly item: Extract<ThreadItem, { type: "toolExecution" }>;
  readonly shimmer: boolean;
  readonly title: string;
}) {
  return (
    <>
      <TimelineActivityIcon name={toolIconName(props.item.name)} />
      <ActivityHeadline
        active={props.item.status === "inProgress"}
        shimmer={props.shimmer}
        text={props.title}
      />
    </>
  );
}

export function FileChangeItem(props: {
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly item: Extract<ThreadItem, { type: "fileChange" }>;
  readonly materializeBody?: (() => boolean) | undefined;
  readonly variant?: "default" | "grouped" | undefined;
}) {
  const singleChange = () => (props.item.changes.length === 1 ? props.item.changes[0] : undefined);

  return (
    <Show
      when={singleChange()}
      fallback={
        <FileChangeGroup
          diffDisplay={props.diffDisplay}
          item={props.item}
          materializeBody={props.materializeBody}
          variant={props.variant}
        />
      }
    >
      {(change) => (
        <Change
          change={change()}
          diffDisplay={props.diffDisplay}
          disclosureKey={`change:${props.item.id}:${timelineFileChangeIdentity(change(), 0)}`}
          materializeBody={props.materializeBody}
        />
      )}
    </Show>
  );
}

export function FileChangeGroup(props: {
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly item: Extract<ThreadItem, { type: "fileChange" }>;
  readonly materializeBody?: (() => boolean) | undefined;
  readonly variant?: "default" | "grouped" | undefined;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().timeline;
  const disclosure = useTimelineDisclosure(() => `file-change:${props.item.id}`);
  const title = () => fileChangeGroupTitle(props.item.changes.length, messages());
  const changeEntries = createMemo(() => createTimelineFileChangeEntries(props.item.changes));
  const changeIdentities = createMemo(() => changeEntries().map((entry) => entry.identity));
  const changesByIdentity = createMemo(
    () => new Map(changeEntries().map((entry) => [entry.identity, entry.change] as const)),
  );
  const changeList = () => (
    <div class="file-change-list">
      <For each={changeIdentities()}>
        {(changeIdentity) => (
          <Change
            change={readTimelineValue(changesByIdentity(), changeIdentity, "file change")}
            diffDisplay={props.diffDisplay}
            disclosureKey={`change:${props.item.id}:${changeIdentity}`}
            materializeBody={props.materializeBody}
          />
        )}
      </For>
    </div>
  );

  return (
    <details class="activity-card file-change-card" open={disclosure.isOpen()}>
      <summary
        class="activity-summary"
        data-timeline-disclosure=""
        ref={(element) => bindControlledTimelineDisclosure(element, disclosure)}
      >
        <TimelineActivityIcon name="edit" />
        <ActivityHeadline
          active={props.item.status === "inProgress"}
          shimmer={props.variant !== "grouped"}
          text={title()}
        />
        <TimelineDisclosureIcon expanded={disclosure.isOpen()} />
      </summary>
      <Show when={disclosure.isOpen() && (props.materializeBody?.() ?? true)}>
        <TimelineDisclosureContext.Provider value={disclosure.descendantContext}>
          {changeList()}
        </TimelineDisclosureContext.Provider>
      </Show>
    </details>
  );
}

export function Change(props: {
  readonly change: FileChange;
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly disclosureKey: string;
  readonly materializeBody?: (() => boolean) | undefined;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().timeline;
  const disclosure = useTimelineDisclosure(() => props.disclosureKey);
  const kind = createMemo(() => props.change.kind.type);
  const path = createMemo(() => props.change.path);
  const stats = createMemo(() => fileChangeLineStats(props.change));
  const additions = createMemo(() => stats().additions);
  const deletions = createMemo(() => stats().deletions);
  const canMaterializeBody = () => props.materializeBody?.() ?? true;
  const bodyChange = createMemo(() =>
    disclosure.isOpen() && canMaterializeBody() ? props.change : null,
  );

  createEffect(() => {
    if (!disclosure.isOpen()) {
      return;
    }
    const currentChange = props.change;
    activityContentProjectionCache.diffDocument(currentChange);
  });

  return (
    <details class="diff-block file-change-diff" data-kind={kind()} open={disclosure.isOpen()}>
      <summary
        data-timeline-disclosure=""
        ref={(element) => bindControlledTimelineDisclosure(element, disclosure)}
      >
        <TimelineActivityIcon name="edit" />
        <span class="file-change-action">{fileChangeActionLabel(kind(), messages())}</span>
        <Show when={!disclosure.isOpen()}>
          <span class="diff-file-identity">
            <code title={path()}>{fileName(path())}</code>
          </span>
          <Show when={kind() !== "update"}>
            <span class={`change-kind kind-${kind()}`}>
              {kind() === "add" ? messages().newChange : messages().deletedChange}
            </span>
          </Show>
          <Show when={additions() > 0}>
            <span
              class="diff-stat additions"
              title={formatMessage(messages().linesAdded, { count: additions() })}
            >
              +{additions()}
            </span>
          </Show>
          <Show when={deletions() > 0}>
            <span
              class="diff-stat deletions"
              title={formatMessage(messages().linesRemoved, { count: deletions() })}
            >
              -{deletions()}
            </span>
          </Show>
        </Show>
        <TimelineDisclosureIcon class="diff-file-chevron" expanded={disclosure.isOpen()} />
      </summary>
      <Show when={bodyChange()}>
        {(bodyChange) => (
          <div class="diff-panel">
            <DiffPanelHeader change={bodyChange()} />
            <Show
              when={bodyChange().diff.trim().length > 0}
              fallback={<div class="diff-empty-state">{messages().noTextDiff}</div>}
            >
              <ExpandedChangeDiff change={bodyChange()} mode={props.diffDisplay ?? "unified"} />
            </Show>
          </div>
        )}
      </Show>
    </details>
  );
}

export function CollapsedChange(props: {
  readonly change: FileChange;
  readonly disclosureKey: string;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().timeline;
  let detailsElement: HTMLDetailsElement | undefined;
  let actionElement: HTMLSpanElement | undefined;
  let fileElement: HTMLElement | undefined;
  let kindElement: HTMLSpanElement | undefined;
  let additionsElement: HTMLSpanElement | undefined;
  let deletionsElement: HTMLSpanElement | undefined;
  const storageKey = useTimelineDisclosureStorageKey(() => props.disclosureKey);
  const initialChange = props.change;
  const initialKind = initialChange.kind.type;
  const initialPath = initialChange.path;
  const initialStats = fileChangeLineStats(initialChange);
  let previousKind = initialKind;
  let previousPath = initialPath;
  let previousAdditions = initialStats.additions;
  let previousDeletions = initialStats.deletions;

  createEffect(() => {
    const change = props.change;
    const kind = change.kind.type;
    const path = change.path;
    const stats = fileChangeLineStats(change);
    if (
      detailsElement === undefined ||
      actionElement === undefined ||
      fileElement === undefined ||
      kindElement === undefined ||
      additionsElement === undefined ||
      deletionsElement === undefined
    ) {
      return;
    }
    if (kind !== previousKind) {
      detailsElement.setAttribute("data-kind", kind);
      actionElement.textContent = fileChangeActionLabel(kind, messages());
      kindElement.className = `change-kind kind-${kind}`;
      kindElement.hidden = kind === "update";
      kindElement.textContent = kind === "add" ? messages().newChange : messages().deletedChange;
      previousKind = kind;
    }
    if (path !== previousPath) {
      fileElement.title = path;
      fileElement.textContent = fileName(path);
      previousPath = path;
    }
    if (stats.additions !== previousAdditions) {
      additionsElement.hidden = stats.additions === 0;
      additionsElement.title = formatMessage(messages().linesAdded, { count: stats.additions });
      additionsElement.textContent = `+${stats.additions}`;
      previousAdditions = stats.additions;
    }
    if (stats.deletions !== previousDeletions) {
      deletionsElement.hidden = stats.deletions === 0;
      deletionsElement.title = formatMessage(messages().linesRemoved, { count: stats.deletions });
      deletionsElement.textContent = `-${stats.deletions}`;
      previousDeletions = stats.deletions;
    }
  });

  return (
    <details class="diff-block file-change-diff" data-kind={initialKind} ref={detailsElement}>
      <summary
        data-timeline-disclosure=""
        ref={(element) => bindControlledTimelineDisclosureKey(element, storageKey)}
      >
        <TimelineActivityIcon name="edit" />
        <span class="file-change-action" ref={actionElement}>
          {fileChangeActionLabel(initialKind, messages())}
        </span>
        <span class="diff-file-identity">
          <code ref={fileElement} title={initialPath}>
            {fileName(initialPath)}
          </code>
        </span>
        <span
          class={`change-kind kind-${initialKind}`}
          hidden={initialKind === "update"}
          ref={kindElement}
        >
          {initialKind === "add" ? messages().newChange : messages().deletedChange}
        </span>
        <span
          class="diff-stat additions"
          hidden={initialStats.additions === 0}
          ref={additionsElement}
          title={formatMessage(messages().linesAdded, { count: initialStats.additions })}
        >
          +{initialStats.additions}
        </span>
        <span
          class="diff-stat deletions"
          hidden={initialStats.deletions === 0}
          ref={deletionsElement}
          title={formatMessage(messages().linesRemoved, { count: initialStats.deletions })}
        >
          -{initialStats.deletions}
        </span>
        <TimelineDisclosureIcon class="diff-file-chevron" expanded={false} />
      </summary>
    </details>
  );
}

export function DiffPanelHeader(props: { readonly change: FileChange }) {
  const i18n = useI18n();
  const messages = () => i18n.messages().timeline;
  const reportFailure = useFrontendFailureReporter();
  const [copyState, setCopyState] = createSignal<"copied" | "failed" | "idle">("idle");
  const stats = createMemo(() => fileChangeLineStats(props.change));
  let resetTimer: number | undefined;

  onCleanup(() => window.clearTimeout(resetTimer));

  async function copyDiff(): Promise<void> {
    window.clearTimeout(resetTimer);
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(props.change.diff);
      setCopyState("copied");
    } catch (reason) {
      reportFailure(frontendFailureMessage("Failed to copy the edit", reason));
      setCopyState("failed");
    }
    resetTimer = window.setTimeout(
      () => setCopyState("idle"),
      DIFF_COPY_FEEDBACK_RESET_MILLISECONDS,
    );
  }

  const copyLabel = () => {
    switch (copyState()) {
      case "copied":
        return messages().editCopied;
      case "failed":
        return messages().editCopyFailed;
      case "idle":
        return messages().copyEdit;
    }
  };

  return (
    <div class="diff-panel-header">
      <span class="diff-file-identity">
        <code title={props.change.path}>{fileName(props.change.path)}</code>
      </span>
      <Show when={stats().additions > 0}>
        <span class="diff-stat additions">+{stats().additions}</span>
      </Show>
      <Show when={stats().deletions > 0}>
        <span class="diff-stat deletions">-{stats().deletions}</span>
      </Show>
      <button
        aria-label={copyLabel()}
        aria-live="polite"
        class="diff-panel-copy"
        onClick={() => void copyDiff()}
        title={copyLabel()}
        type="button"
      >
        <Icon name={copyState() === "copied" ? "check" : "copy"} size={13} />
      </button>
    </div>
  );
}

export function ExpandedChangeDiff(props: {
  readonly change: FileChange;
  readonly mode: "split" | "unified";
}) {
  const document = createMemo(() => activityContentProjectionCache.diffDocument(props.change));
  return (
    <DiffView
      document={document()}
      mode={props.mode}
      path={props.change.path}
      viewportSizing="intrinsic"
    />
  );
}

export function createTimelineFileChangeEntries(
  changes: readonly FileChange[],
): readonly { readonly change: FileChange; readonly identity: string }[] {
  const occurrencesByPath = new Map<string, number>();
  return changes.map((change) => {
    const occurrence = occurrencesByPath.get(change.path) ?? 0;
    occurrencesByPath.set(change.path, occurrence + 1);
    return {
      change,
      identity: timelineFileChangeIdentity(change, occurrence),
    };
  });
}

export function readTimelineValue<T>(
  values: ReadonlyMap<string, T>,
  identity: string,
  description: string,
): T {
  const value = values.get(identity);
  if (value === undefined) {
    throw new Error(`${description} ${JSON.stringify(identity)} is unavailable.`);
  }
  return value;
}

export function readVirtualTurn(
  turnsById: ReadonlyMap<string, VisibleThreadTurn>,
  turnId: string,
): VisibleThreadTurn {
  const turn = turnsById.get(turnId);
  if (turn === undefined) {
    throw new Error(`Virtual turn ${turnId} is unavailable in the current window.`);
  }
  return turn;
}
