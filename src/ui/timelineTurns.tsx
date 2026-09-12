import {
  createEffect,
  createMemo,
  ErrorBoundary,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";

import { useI18n } from "../i18n/context";

import type { VisibleThreadTurn } from "../state/visibleTurnSequence";
import {
  AgentActivityProjectionStore,
  type AgentActivityRenderUnit,
  agentActivityRenderUnitIdentity,
  canAgentActivityOwnHeadline,
} from "./agentActivityPresentation";
import { observeElementResize, readResizeObserverBorderBoxHeight } from "./elementResize";
import { useFrontendFailureReporter } from "./frontendFailure";
import { Icon } from "./Icon";
import { TimelineTurnRenderFailure } from "./RenderFailure";
import {
  type TimelineDisclosureBinding,
  TimelineDisclosureContext,
  useTimelineDisclosure,
} from "./timelineDisclosureContext";
import {
  ActivityHeadline,
  AgentActivityGroup,
  asAgentActivityGroup,
  asAgentActivityItem,
  asImageViewGroup,
  ImageViewGroup,
  readTimelineValue,
  TimelineItem,
} from "./timelineItems";
import {
  formatElapsedSeconds,
  reasoningTitle,
  thinkingPresentation,
  turnDurationLabel,
} from "./timelinePresentation";
import { presentTurnFailure } from "./turnFailure";
import {
  asTurnMessageBlock,
  asTurnWorkBlock,
  type TurnPresentationBlock,
  TurnPresentationStore,
  type TurnWorkItem,
} from "./turnPresentation";

export function VirtualConversationTurn(props: {
  readonly clock: number;
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly isItemStreaming: (itemId: string) => boolean;
  readonly measurementKey: string;
  readonly onMeasure: (key: string, size: number) => void;
  readonly top: number;
  readonly turn: () => VisibleThreadTurn;
  readonly turnId: string;
}) {
  let element: HTMLDivElement | undefined;
  let releaseResizeObservation: (() => void) | undefined;
  const reportFailure = useFrontendFailureReporter();
  const turn = createMemo(props.turn);

  function measure(entry?: ResizeObserverEntry): void {
    if (element !== undefined) {
      props.onMeasure(
        props.measurementKey,
        entry === undefined
          ? element.getBoundingClientRect().height
          : (readResizeObserverBorderBoxHeight(entry) ?? element.getBoundingClientRect().height),
      );
    }
  }

  onMount(() => {
    if (element !== undefined) {
      releaseResizeObservation = observeElementResize(element, measure);
      measure();
    }
  });
  createEffect(() => {
    props.measurementKey;
    measure();
  });
  onCleanup(() => {
    releaseResizeObservation?.();
  });

  return (
    <div
      class="timeline-virtual-item"
      data-virtual-turn-id={props.turnId}
      ref={element}
      style={{ top: `${Math.round(props.top)}px` }}
    >
      <ErrorBoundary
        fallback={(error, reset) => (
          <TimelineTurnRenderFailure
            error={error}
            onReport={reportFailure}
            onReset={reset}
            turnId={props.turnId}
          />
        )}
      >
        <ConversationTurn
          clock={props.clock}
          diffDisplay={props.diffDisplay}
          isItemStreaming={props.isItemStreaming}
          turn={turn()}
        />
      </ErrorBoundary>
    </div>
  );
}

export function ConversationTurn(props: {
  readonly clock: number;
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly isItemStreaming: (itemId: string) => boolean;
  readonly turn: VisibleThreadTurn;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().timeline;
  const disclosure = useTimelineDisclosure(
    () => `turn:${props.turn.id}`,
    () => props.turn.status === "inProgress",
  );
  const failure = () =>
    props.turn.error === null
      ? null
      : presentTurnFailure(props.turn.error, messages(), i18n.locale());
  const presentationStore = new TurnPresentationStore();
  const presentation = createMemo(() => presentationStore.project(props.turn.items));
  const presentationBlockKeys = createMemo(() => presentation().blocks.map((block) => block.key));
  const presentationBlocksByKey = createMemo(
    () => new Map(presentation().blocks.map((block) => [block.key, block] as const)),
  );
  const activeWorkBlockIndex = createMemo(() => {
    const current = presentation();
    return current.lastWorkBlockIndex === current.blocks.length - 1
      ? current.lastWorkBlockIndex
      : null;
  });
  const activeWorkOwnsHeadline = createMemo(() => {
    const index = activeWorkBlockIndex();
    const block = index === null ? undefined : presentation().blocks[index];
    return block?.kind === "work" && canAgentActivityOwnHeadline(block.items);
  });
  const latestReasoningHeading = createMemo(() => {
    const items = props.turn.items;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (item?.type === "reasoning") {
        const title = reasoningTitle(
          item.summary,
          props.isItemStreaming(item.id) ? "streaming" : "completed",
        );
        if (title !== null) {
          return title;
        }
      }
    }
    return null;
  });
  const activeThinkingPresentation = createMemo(() => {
    const current = presentation();
    return thinkingPresentation(
      props.turn.status,
      current.trailingAgentMessageBlockIndex === current.blocks.length - 1,
      activeWorkOwnsHeadline(),
    );
  });
  const needsTrailingThinking = createMemo(
    () =>
      props.turn.status === "inProgress" &&
      activeWorkBlockIndex() === null &&
      presentation().trailingAgentMessageBlockIndex === null,
  );

  function turnLabel(): string {
    const end =
      props.turn.status === "inProgress"
        ? Math.floor(props.clock / 1_000)
        : Math.max(props.turn.createdAt, props.turn.updatedAt);
    const duration = formatElapsedSeconds(Math.max(0, end - props.turn.createdAt));
    return turnDurationLabel(props.turn.status, duration, messages());
  }

  return (
    <section class="conversation-turn" data-status={props.turn.status}>
      <For each={presentationBlockKeys()}>
        {(blockKey, index) => (
          <TurnPresentationBlockView
            activeThinkingPresentation={
              activeWorkBlockIndex() === index() ? activeThinkingPresentation() : "none"
            }
            block={() =>
              readTimelineValue(presentationBlocksByKey(), blockKey, "projected turn block")
            }
            blockIndex={index()}
            clock={props.clock}
            diffDisplay={props.diffDisplay}
            disclosure={disclosure}
            firstWorkBlockIndex={presentation().firstWorkBlockIndex}
            isItemStreaming={props.isItemStreaming}
            reasoningHeading={latestReasoningHeading()}
            status={props.turn.status}
            trailingAgentMessageBlockIndex={presentation().trailingAgentMessageBlockIndex}
            turnLabel={turnLabel()}
          />
        )}
      </For>

      <Show when={needsTrailingThinking()}>
        <Show when={presentation().firstWorkBlockIndex === null}>
          <TurnHeader disclosure={disclosure} label={turnLabel()} status={props.turn.status} />
        </Show>
        <TimelineDisclosureContext.Provider value={disclosure.descendantContext}>
          <TurnWorkBlock
            activeThinkingPresentation="standalone"
            clock={props.clock}
            diffDisplay={props.diffDisplay}
            isItemStreaming={props.isItemStreaming}
            items={[]}
            reasoningHeading={latestReasoningHeading()}
          />
        </TimelineDisclosureContext.Provider>
      </Show>

      <Show when={failure()}>
        {(presentation) => (
          <section
            class="turn-failure"
            data-tone={presentation().tone}
            role={presentation().tone === "warning" ? "status" : "alert"}
          >
            <strong>{presentation().title}</strong>
            <p>{presentation().detail}</p>
            <Show when={presentation().technical}>
              {(technical) => <small>{technical()}</small>}
            </Show>
          </section>
        )}
      </Show>
    </section>
  );
}

export function TurnPresentationBlockView(props: {
  readonly activeThinkingPresentation: "activity" | "none" | "standalone";
  readonly block: () => TurnPresentationBlock;
  readonly blockIndex: number;
  readonly clock: number;
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly disclosure: TimelineDisclosureBinding;
  readonly firstWorkBlockIndex: number | null;
  readonly isItemStreaming: (itemId: string) => boolean;
  readonly reasoningHeading: string | null;
  readonly status: VisibleThreadTurn["status"];
  readonly trailingAgentMessageBlockIndex: number | null;
  readonly turnLabel: string;
}) {
  const block = createMemo(props.block);

  return (
    <Switch>
      <Match when={asTurnMessageBlock(block())}>
        {(messageBlock) => (
          <TimelineItem
            active={
              props.status === "inProgress" &&
              props.trailingAgentMessageBlockIndex === props.blockIndex
            }
            clock={props.clock}
            diffDisplay={props.diffDisplay}
            item={messageBlock().item}
            streaming={
              messageBlock().item.type === "agentMessage" &&
              props.isItemStreaming(messageBlock().item.id)
            }
          />
        )}
      </Match>
      <Match when={asTurnWorkBlock(block())}>
        {(workBlock) => (
          <>
            <Show when={props.firstWorkBlockIndex === props.blockIndex}>
              <TurnHeader
                disclosure={props.disclosure}
                label={props.turnLabel}
                status={props.status}
              />
            </Show>
            <Show when={props.status === "inProgress" || props.disclosure.isOpen()}>
              <TimelineDisclosureContext.Provider value={props.disclosure.descendantContext}>
                <TurnWorkBlock
                  activeThinkingPresentation={props.activeThinkingPresentation}
                  clock={props.clock}
                  diffDisplay={props.diffDisplay}
                  isItemStreaming={props.isItemStreaming}
                  items={workBlock().items}
                  reasoningHeading={props.reasoningHeading}
                />
              </TimelineDisclosureContext.Provider>
            </Show>
          </>
        )}
      </Match>
    </Switch>
  );
}

export function TurnHeader(props: {
  readonly disclosure: TimelineDisclosureBinding;
  readonly label: string;
  readonly status: VisibleThreadTurn["status"];
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().timeline;
  return (
    <div class="turn-header-wrapper">
      <Show
        when={props.status === "inProgress"}
        fallback={
          <button
            aria-expanded={props.disclosure.isOpen()}
            aria-label={
              props.disclosure.isOpen() ? messages().hideAgentWork : messages().showAgentWork
            }
            class="turn-header-button"
            data-timeline-disclosure=""
            onClick={props.disclosure.toggle}
            type="button"
          >
            <span class="turn-duration-label">{props.label}</span>
            <Icon name={props.disclosure.isOpen() ? "chevronDown" : "chevronRight"} size={12} />
          </button>
        }
      >
        <div aria-atomic="true" aria-live="polite" class="turn-active-status" role="status">
          <span class="turn-duration-label">{props.label}</span>
        </div>
      </Show>
      <div class="turn-header-line" />
    </div>
  );
}

export function TurnWorkBlock(props: {
  readonly activeThinkingPresentation: "activity" | "none" | "standalone";
  readonly clock: number;
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly isItemStreaming: (itemId: string) => boolean;
  readonly items: readonly TurnWorkItem[];
  readonly reasoningHeading: string | null;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().timeline;
  const projectionStore = new AgentActivityProjectionStore();
  const workUnits = createMemo(() => projectionStore.project(props.items));
  const workUnitIdentities = createMemo(() => workUnits().map(agentActivityRenderUnitIdentity));
  const workUnitsByIdentity = createMemo(
    () =>
      new Map(workUnits().map((unit) => [agentActivityRenderUnitIdentity(unit), unit] as const)),
  );

  return (
    <Show when={workUnits().length > 0 || props.activeThinkingPresentation === "standalone"}>
      <div class="turn-body">
        <For each={workUnitIdentities()}>
          {(unitIdentity, index) => (
            <WorkTimelineUnit
              clock={props.clock}
              diffDisplay={props.diffDisplay}
              isItemStreaming={props.isItemStreaming}
              isCurrent={
                index() === workUnits().length - 1 &&
                props.activeThinkingPresentation === "activity"
              }
              reasoningHeading={props.reasoningHeading}
              unit={() =>
                readTimelineValue(workUnitsByIdentity(), unitIdentity, "agent activity unit")
              }
            />
          )}
        </For>
        <Show
          when={
            props.activeThinkingPresentation === "standalone"
              ? (props.reasoningHeading ?? messages().thinking)
              : null
          }
        >
          {(heading) => (
            <section class="thinking-activity-status" role="status">
              <ActivityHeadline active text={heading()} />
            </section>
          )}
        </Show>
      </div>
    </Show>
  );
}

export function WorkTimelineUnit(props: {
  readonly clock: number;
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly isCurrent: boolean;
  readonly isItemStreaming: (itemId: string) => boolean;
  readonly reasoningHeading: string | null;
  readonly unit: () => AgentActivityRenderUnit;
}) {
  const unit = createMemo(props.unit);

  return (
    <Switch>
      <Match when={asAgentActivityGroup(unit())}>
        {(group) => (
          <AgentActivityGroup
            clock={props.clock}
            diffDisplay={props.diffDisplay}
            disclosureKey={group().key}
            isCurrent={props.isCurrent}
            items={group().items}
            reasoningHeading={props.reasoningHeading}
          />
        )}
      </Match>
      <Match when={asImageViewGroup(unit())}>
        {(group) => <ImageViewGroup disclosureKey={group().key} items={group().items} />}
      </Match>
      <Match when={asAgentActivityItem(unit())}>
        {(itemUnit) => (
          <TimelineItem
            active={props.isCurrent}
            clock={props.clock}
            diffDisplay={props.diffDisplay}
            item={itemUnit().item}
            streaming={
              itemUnit().item.type === "agentMessage" && props.isItemStreaming(itemUnit().item.id)
            }
          />
        )}
      </Match>
    </Switch>
  );
}
