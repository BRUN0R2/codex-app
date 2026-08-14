import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
  useContext,
} from "solid-js";

import type { FileChange, ThreadItem, UserContent, VisibleThreadItem } from "../contracts/types";
import type { AppController } from "../state/createAppController";
import { projectName } from "../state/projects";
import type { VisibleThreadTurn } from "../state/visibleTurnSequence";
import { fileName, toolIconName, toolLabel } from "./activityLabels";
import {
  type AgentActivityItem,
  type AgentActivityKind,
  type AgentActivityRenderUnit,
  activeAgentActivity,
  agentActivitySummaryLabel,
  shouldRenderAgentActivityGroup,
  splitAgentActivityUnits,
  summarizeAgentActivity,
  webSearchActivityTitle,
} from "./agentActivityPresentation";
import { CodexGlyph } from "./CodexGlyph";
import { presentAssistantText } from "./contentReferenceMarkers";
import { Icon, type IconName } from "./Icon";
import { ImagePreview } from "./ImagePreview";
import { extractToolImageSource } from "./imageSource";
import { Markdown } from "./Markdown";
import { SplitDiffView, summarizeDiff, UnifiedDiffView } from "./SplitDiffView";
import { createTimelineDisclosureStore, type TimelineDisclosureStore } from "./timelineDisclosure";
import {
  commandActivityTitle,
  commandOutputText,
  fileChangeActivityTitle,
  reasoningTitle,
  thinkingPresentation,
  toolActivityTitle,
  turnDurationLabel,
} from "./timelinePresentation";
import {
  calculateTimelineScrollbar,
  findTimelineAnchorIndex,
  hasRecentTimelineUserScrollIntent,
  isTimelineNearEnd,
  resolveTimelineFollowing,
  revealExpandedDisclosureScrollTop,
  type ScrollbarMetrics,
} from "./timelineScroll";
import { presentTurnFailure } from "./turnFailure";
import { type UserMessageEntry, UserMessageNavigator } from "./UserMessageNavigator";
import { VariableSizeVirtualizer } from "./variableSizeVirtualizer";

interface StarterSuggestion {
  readonly icon: IconName;
  readonly label: string;
  readonly prompt: string;
  readonly tone: "blue" | "green" | "orange" | "violet";
}

const STARTER_SUGGESTIONS: readonly StarterSuggestion[] = [
  {
    icon: "telescope",
    label: "Explore e entenda código",
    prompt:
      "Explore este projeto e explique sua arquitetura, os fluxos principais e os riscos técnicos mais importantes.",
    tone: "blue",
  },
  {
    icon: "hammer",
    label: "Crie um novo recurso, aplicativo ou ferramenta",
    prompt:
      "Implemente um novo recurso neste projeto. Primeiro identifique a melhor integração arquitetural e então faça a alteração completa com validação.",
    tone: "violet",
  },
  {
    icon: "syncCheck",
    label: "Revisar código e sugerir mudanças",
    prompt:
      "Revise as alterações atuais do projeto, priorize bugs, riscos e regressões e proponha correções objetivas.",
    tone: "green",
  },
  {
    icon: "bug",
    label: "Corrigir problemas e falhas",
    prompt:
      "Investigue os problemas atuais do projeto, encontre a causa raiz e implemente uma correção completa e verificável.",
    tone: "orange",
  },
];

const USER_MESSAGE_COLLAPSED_LINES = 20;
const TIMELINE_ESTIMATED_TURN_HEIGHT = 498;
const TIMELINE_VIRTUAL_OVERSCAN_PX = 900;
const TIMELINE_HISTORY_LOAD_THRESHOLD_PX = 640;

interface TimelineUserMessageEntry extends UserMessageEntry {
  readonly turnIndex: number;
}

interface TimelineDisclosureBinding {
  readonly clear: (keys: readonly string[], prefixes?: readonly string[]) => void;
  readonly isOpen: () => boolean;
  readonly setOpen: (open: boolean) => void;
  readonly toggle: () => void;
}

const TimelineDisclosureContext = createContext<TimelineDisclosureStore>();

function useTimelineDisclosure(
  key: () => string,
  initialOpen: () => boolean = () => false,
): TimelineDisclosureBinding {
  const disclosures = useContext(TimelineDisclosureContext);
  if (disclosures === undefined) {
    throw new Error("O estado visual da timeline não foi inicializado.");
  }

  let activeKey = key();
  createEffect(() => {
    const nextKey = key();
    if (nextKey !== activeKey) {
      disclosures.clear([activeKey]);
      activeKey = nextKey;
    }
  });
  onCleanup(() => disclosures.clear([activeKey]));

  const isOpen = () => disclosures.read(key(), initialOpen());
  const setOpen = (open: boolean) => disclosures.write(key(), open);

  return {
    clear: disclosures.clear,
    isOpen,
    setOpen,
    toggle: () => setOpen(!isOpen()),
  };
}

function disclosurePhase(status: AgentActivityItem["status"]): "running" | "settled" {
  return status === "inProgress" ? "running" : "settled";
}

function handleDetailsToggle(
  event: ToggleEvent & { readonly currentTarget: HTMLDetailsElement },
  disclosure: TimelineDisclosureBinding,
): void {
  const details = event.currentTarget;
  disclosure.setOpen(details.open);
  if (!details.open) {
    return;
  }
  requestAnimationFrame(() => revealExpandedDetails(details));
}

function revealExpandedDetails(details: HTMLDetailsElement): void {
  if (!details.isConnected || !details.open) {
    return;
  }
  const viewport = details.closest<HTMLElement>(".agent-activity-viewport");
  const summary = details.querySelector<HTMLElement>(":scope > summary");
  if (viewport === null || summary === null) {
    return;
  }
  const viewportBounds = viewport.getBoundingClientRect();
  const detailsBounds = details.getBoundingClientRect();
  const targetScrollTop = revealExpandedDisclosureScrollTop({
    clientHeight: viewport.clientHeight,
    detailsBottom: detailsBounds.bottom,
    detailsTop: detailsBounds.top,
    scrollHeight: viewport.scrollHeight,
    scrollTop: viewport.scrollTop,
    summaryBottom: summary.getBoundingClientRect().bottom,
    viewportTop: viewportBounds.top,
  });
  if (targetScrollTop > viewport.scrollTop) {
    viewport.scrollTop = targetScrollTop;
  }
}

export function Timeline(props: {
  readonly controller: AppController;
  readonly onSelectSuggestion: (prompt: string) => void;
}) {
  let scrollElement: HTMLDivElement | undefined;
  let contentElement: HTMLDivElement | undefined;
  let virtualListElement: HTMLDivElement | undefined;
  let scrollbarTrackElement: HTMLDivElement | undefined;
  let scrollbarThumbElement: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let animationFrame: number | undefined;
  let historyRevealFrame: number | undefined;
  let lastUserScrollIntentAt = Number.NEGATIVE_INFINITY;
  let observedActiveTurnId: string | null | undefined;
  let observedThreadId: string | null | undefined;
  let dragState:
    | { readonly pointerId: number; readonly startScrollTop: number; readonly startY: number }
    | undefined;
  const [followingLatest, setFollowingLatest] = createSignal(true);
  const [showScrollToEnd, setShowScrollToEnd] = createSignal(false);
  const [activeUserMessageIndex, setActiveUserMessageIndex] = createSignal(0);
  const [clock, setClock] = createSignal(Date.now());
  const virtualizer = new VariableSizeVirtualizer(TIMELINE_ESTIMATED_TURN_HEIGHT);
  const [virtualRevision, setVirtualRevision] = createSignal(0);
  const [virtualViewport, setVirtualViewport] = createSignal({ offset: 0, size: 1 });
  const [scrollbar, setScrollbar] = createSignal<ScrollbarMetrics>({
    maximumScroll: 0,
    scrollable: false,
    thumbHeight: 0,
    thumbTop: 0,
  });
  const disclosures = createTimelineDisclosureStore();
  const virtualRange = createMemo(() => {
    virtualRevision();
    const viewport = virtualViewport();
    return virtualizer.range(viewport.offset, viewport.size, TIMELINE_VIRTUAL_OVERSCAN_PX);
  });
  const virtualTurns = createMemo(() => {
    const range = virtualRange();
    return props.controller.turns().slice(range.start, range.end);
  });
  const virtualTotalSize = createMemo(() => {
    virtualRevision();
    return virtualizer.totalSize();
  });
  const userMessages = createMemo<readonly TimelineUserMessageEntry[]>(() =>
    props.controller.persistedTurns().flatMap((turn, turnIndex) => {
      const response = [...turn.items].reverse().find((item) => item.type === "agentMessage");
      const detail =
        response?.type === "agentMessage"
          ? blockPreview(presentAssistantText(response.text), 320)
          : null;
      return turn.items.flatMap((item) => {
        if (item.type !== "userMessage") {
          return [];
        }
        const title = inlinePreview(userMessageCopyText(item.content), 180);
        return [
          {
            id: item.id,
            title,
            detail,
            label: detail === null ? title : `${title}. ${detail.replace(/\s+/gu, " ")}`,
            turnIndex,
          },
        ];
      });
    }),
  );

  function measureActiveUserMessage(): void {
    const messages = userMessages();
    if (scrollElement === undefined || virtualListElement === undefined || messages.length === 0) {
      setActiveUserMessageIndex(0);
      return;
    }
    virtualRevision();
    const viewportTop = Math.max(0, scrollElement.scrollTop - virtualListElement.offsetTop + 112);
    setActiveUserMessageIndex(
      findTimelineAnchorIndex(
        messages.length,
        (index) => virtualizer.offsetOf(messages[index]?.turnIndex ?? Number.MAX_SAFE_INTEGER),
        viewportTop,
      ),
    );
  }

  async function revealOlderTurns(): Promise<void> {
    const threadId = props.controller.currentThread()?.id ?? null;
    if (
      scrollElement === undefined ||
      threadId === null ||
      !props.controller.hasOlderHistory() ||
      props.controller.historyLoading()
    ) {
      return;
    }
    const previousScrollHeight = scrollElement.scrollHeight;
    const previousScrollTop = scrollElement.scrollTop;
    setFollowingLatest(false);
    const loaded = await props.controller.loadOlderHistory();
    if (!loaded || props.controller.currentThread()?.id !== threadId) {
      return;
    }
    if (historyRevealFrame !== undefined) {
      cancelAnimationFrame(historyRevealFrame);
    }
    historyRevealFrame = requestAnimationFrame(() => {
      historyRevealFrame = undefined;
      if (scrollElement === undefined || props.controller.currentThread()?.id !== threadId) {
        return;
      }
      scrollElement.scrollTop =
        previousScrollTop + Math.max(0, scrollElement.scrollHeight - previousScrollHeight);
      measureScroll(false);
    });
  }

  function updateVirtualViewport(): void {
    if (scrollElement === undefined || virtualListElement === undefined) {
      return;
    }
    setVirtualViewport({
      offset: Math.max(0, scrollElement.scrollTop - virtualListElement.offsetTop),
      size: Math.max(1, scrollElement.clientHeight),
    });
  }

  function virtualOffset(index: number): number {
    virtualRevision();
    return virtualizer.offsetOf(index);
  }

  function virtualTurnKey(turnId: string): string {
    return `${props.controller.currentThread()?.id ?? ""}\u0000${turnId}`;
  }

  function measureVirtualTurn(key: string, size: number): void {
    const change = virtualizer.measure(key, size);
    if (change === null) {
      return;
    }
    const previousBottom = virtualizer.offsetOf(change.index + 1) - change.delta;
    if (
      scrollElement !== undefined &&
      !followingLatest() &&
      previousBottom <= virtualViewport().offset
    ) {
      scrollElement.scrollTop += change.delta;
    }
    setVirtualRevision((revision) => revision + 1);
    synchronizeScroll();
  }

  function measureScroll(userInitiated: boolean): void {
    if (scrollElement === undefined) {
      return;
    }
    updateVirtualViewport();
    const trackHeight = scrollbarTrackElement?.clientHeight ?? 0;
    setScrollbar(
      calculateTimelineScrollbar({
        clientHeight: scrollElement.clientHeight,
        scrollHeight: scrollElement.scrollHeight,
        scrollTop: scrollElement.scrollTop,
        trackHeight,
      }),
    );
    const isNearEnd = isTimelineNearEnd({
      clientHeight: scrollElement.clientHeight,
      scrollHeight: scrollElement.scrollHeight,
      scrollTop: scrollElement.scrollTop,
    });
    setShowScrollToEnd(!isNearEnd);
    setFollowingLatest((current) =>
      resolveTimelineFollowing({
        followingLatest: current,
        nearEnd: isNearEnd,
        userInitiated,
      }),
    );
    measureActiveUserMessage();
    if (
      userInitiated &&
      scrollElement.scrollTop <= TIMELINE_HISTORY_LOAD_THRESHOLD_PX &&
      props.controller.hasOlderHistory() &&
      !props.controller.historyLoading()
    ) {
      void revealOlderTurns();
    }
  }

  function markUserScrollIntent(): void {
    lastUserScrollIntentAt = performance.now();
  }

  function handleTimelineKeyDown(event: KeyboardEvent): void {
    if (event.target !== scrollElement) {
      return;
    }
    switch (event.key) {
      case " ":
      case "ArrowDown":
      case "ArrowUp":
      case "End":
      case "Home":
      case "PageDown":
      case "PageUp":
        markUserScrollIntent();
        return;
    }
  }

  function handleTimelinePointerDown(event: PointerEvent): void {
    if (event.pointerType === "touch" || event.button === 1) {
      markUserScrollIntent();
    }
  }

  function handleTimelineClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-timeline-disclosure]")) {
      setFollowingLatest(false);
    }
  }

  function synchronizeScroll(): void {
    if (animationFrame !== undefined) {
      cancelAnimationFrame(animationFrame);
    }
    animationFrame = requestAnimationFrame(() => {
      animationFrame = undefined;
      if (scrollElement === undefined) {
        return;
      }
      if (followingLatest()) {
        scrollElement.scrollTop = scrollElement.scrollHeight;
      }
      measureScroll(false);
    });
  }

  function scrollToEnd(behavior: ScrollBehavior = "auto"): void {
    if (scrollElement === undefined) {
      return;
    }
    setFollowingLatest(true);
    scrollElement.scrollTo({ behavior, top: scrollElement.scrollHeight });
    if (behavior === "auto") {
      measureScroll(false);
    }
  }

  function scrollToUserMessage(message: UserMessageEntry): void {
    if (scrollElement === undefined || virtualListElement === undefined) {
      return;
    }
    const target = userMessages().find((entry) => entry.id === message.id);
    if (target === undefined) {
      return;
    }
    setFollowingLatest(false);
    scrollElement.scrollTo({
      behavior: "smooth",
      top: Math.max(0, virtualListElement.offsetTop + virtualizer.offsetOf(target.turnIndex) - 32),
    });
  }

  function setScrollTopFromThumb(thumbTop: number, userInitiated: boolean): void {
    if (scrollElement === undefined || scrollbarTrackElement === undefined) {
      return;
    }
    const metrics = scrollbar();
    const maximumThumbTop = Math.max(0, scrollbarTrackElement.clientHeight - metrics.thumbHeight);
    scrollElement.scrollTop =
      maximumThumbTop === 0
        ? 0
        : (Math.min(maximumThumbTop, Math.max(0, thumbTop)) / maximumThumbTop) *
          metrics.maximumScroll;
    measureScroll(userInitiated);
  }

  function handleScrollbarTrackPointerDown(event: PointerEvent): void {
    if (
      event.target === scrollbarThumbElement ||
      scrollbarTrackElement === undefined ||
      !scrollbar().scrollable
    ) {
      return;
    }
    event.preventDefault();
    const track = scrollbarTrackElement.getBoundingClientRect();
    setScrollTopFromThumb(event.clientY - track.top - scrollbar().thumbHeight / 2, true);
  }

  function handleScrollbarThumbPointerDown(event: PointerEvent): void {
    if (scrollElement === undefined || scrollbarThumbElement === undefined) {
      return;
    }
    event.preventDefault();
    dragState = {
      pointerId: event.pointerId,
      startScrollTop: scrollElement.scrollTop,
      startY: event.clientY,
    };
    scrollbarThumbElement.setPointerCapture(event.pointerId);
  }

  function handleScrollbarThumbPointerMove(event: PointerEvent): void {
    if (
      dragState === undefined ||
      dragState.pointerId !== event.pointerId ||
      scrollbarTrackElement === undefined
    ) {
      return;
    }
    const metrics = scrollbar();
    const maximumThumbTop = Math.max(0, scrollbarTrackElement.clientHeight - metrics.thumbHeight);
    const scrollDelta =
      maximumThumbTop === 0
        ? 0
        : ((event.clientY - dragState.startY) / maximumThumbTop) * metrics.maximumScroll;
    const targetScrollTop = dragState.startScrollTop + scrollDelta;
    const targetThumbTop =
      metrics.maximumScroll === 0 ? 0 : (targetScrollTop / metrics.maximumScroll) * maximumThumbTop;
    setScrollTopFromThumb(targetThumbTop, true);
  }

  function handleScrollbarThumbPointerUp(event: PointerEvent): void {
    if (dragState?.pointerId !== event.pointerId || scrollbarThumbElement === undefined) {
      return;
    }
    scrollbarThumbElement.releasePointerCapture(event.pointerId);
    dragState = undefined;
  }

  function handleScrollbarKeyDown(event: KeyboardEvent): void {
    if (scrollElement === undefined) {
      return;
    }
    const page = Math.max(120, scrollElement.clientHeight * 0.8);
    switch (event.key) {
      case "ArrowDown":
        scrollElement.scrollBy({ top: 64 });
        break;
      case "ArrowUp":
        scrollElement.scrollBy({ top: -64 });
        break;
      case "End":
        scrollToEnd();
        break;
      case "Home":
        scrollElement.scrollTop = 0;
        break;
      case "PageDown":
        scrollElement.scrollBy({ top: page });
        break;
      case "PageUp":
        scrollElement.scrollBy({ top: -page });
        break;
      default:
        return;
    }
    markUserScrollIntent();
    event.preventDefault();
    measureScroll(true);
  }

  function scrollTimelineBy(delta: number): void {
    if (scrollElement === undefined) {
      return;
    }
    markUserScrollIntent();
    scrollElement.scrollBy({ top: delta });
    measureScroll(true);
  }

  createEffect(() => {
    const threadId = props.controller.currentThread()?.id ?? "";
    const keys = props.controller.persistedTurns().map((turn) => `${threadId}\u0000${turn.id}`);
    if (virtualizer.setKeys(keys)) {
      setVirtualRevision((revision) => revision + 1);
      queueMicrotask(updateVirtualViewport);
    }
  });

  onMount(() => {
    if (scrollElement === undefined || contentElement === undefined) {
      return;
    }
    const handleScroll = () =>
      measureScroll(hasRecentTimelineUserScrollIntent(lastUserScrollIntentAt, performance.now()));
    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    resizeObserver = new ResizeObserver(synchronizeScroll);
    resizeObserver.observe(scrollElement);
    resizeObserver.observe(contentElement);
    if (scrollbarTrackElement !== undefined) {
      resizeObserver.observe(scrollbarTrackElement);
    }
    synchronizeScroll();
    const clockInterval = window.setInterval(() => setClock(Date.now()), 1_000);
    onCleanup(() => window.clearInterval(clockInterval));
    onCleanup(() => scrollElement?.removeEventListener("scroll", handleScroll));
  });

  onCleanup(() => {
    resizeObserver?.disconnect();
    if (animationFrame !== undefined) {
      cancelAnimationFrame(animationFrame);
    }
    if (historyRevealFrame !== undefined) {
      cancelAnimationFrame(historyRevealFrame);
    }
  });

  createEffect(() => {
    props.controller.turns();
    const threadId = props.controller.currentThread()?.id ?? null;
    const activeTurnId = props.controller.activeTurnId();
    const threadChanged = observedThreadId !== threadId;
    const turnStarted = activeTurnId !== null && observedActiveTurnId !== activeTurnId;
    observedThreadId = threadId;
    observedActiveTurnId = activeTurnId;
    if (threadChanged || turnStarted) {
      setFollowingLatest(true);
    }
    synchronizeScroll();
  });

  return (
    <TimelineDisclosureContext.Provider value={disclosures}>
      <div class="timeline-frame">
        <UserMessageNavigator
          activeIndex={activeUserMessageIndex()}
          messages={userMessages()}
          onSelect={scrollToUserMessage}
        />
        <section
          aria-label="Conversa"
          class="timeline"
          id="conversation-timeline"
          onClick={handleTimelineClick}
          onKeyDown={handleTimelineKeyDown}
          onPointerDown={handleTimelinePointerDown}
          onWheel={markUserScrollIntent}
          ref={scrollElement}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: the official desktop keeps the scroll viewport keyboard-focusable for Home, End, PageUp, and PageDown.
          tabIndex={0}
        >
          <div class="timeline-inner" ref={contentElement}>
            <Show
              keyed
              when={props.controller.currentThread()?.id}
              fallback={
                <EmptyConversation
                  mode={props.controller.conversationMode()}
                  onSelectSuggestion={props.onSelectSuggestion}
                  workspace={props.controller.workspace()}
                />
              }
            >
              {(_threadId) => (
                <Show
                  when={props.controller.turns().length > 0}
                  fallback={
                    <EmptyConversation
                      mode={props.controller.conversationMode()}
                      onSelectSuggestion={props.onSelectSuggestion}
                      workspace={props.controller.workspace()}
                    />
                  }
                >
                  <Show when={props.controller.hasOlderHistory()}>
                    <button
                      class="timeline-history-button"
                      disabled={props.controller.historyLoading()}
                      onClick={() => void revealOlderTurns()}
                      type="button"
                    >
                      {props.controller.historyLoading()
                        ? "Carregando histórico…"
                        : "Carregar turnos anteriores"}
                    </button>
                  </Show>
                  <div
                    class="timeline-virtual-list"
                    ref={virtualListElement}
                    style={{ height: `${virtualTotalSize()}px` }}
                  >
                    <Index each={virtualTurns()}>
                      {(turn, relativeIndex) => (
                        <VirtualConversationTurn
                          clock={clock()}
                          diffDisplay={props.controller.config()?.config.desktop.diffDisplay}
                          measurementKey={virtualTurnKey(turn().id)}
                          onMeasure={measureVirtualTurn}
                          top={virtualOffset(virtualRange().start + relativeIndex)}
                          turn={turn()}
                        />
                      )}
                    </Index>
                  </div>
                </Show>
              )}
            </Show>
          </div>
        </section>
        <div
          aria-hidden={!scrollbar().scrollable}
          class="timeline-scrollbar"
          classList={{ "is-hidden": !scrollbar().scrollable }}
        >
          <button
            aria-controls="conversation-timeline"
            aria-label="Rolar conversa para cima"
            class="timeline-scrollbar-arrow up"
            disabled={!scrollbar().scrollable || scrollbar().thumbTop <= 0.5}
            onClick={() => scrollTimelineBy(-64)}
            title="Rolar para cima"
            type="button"
          >
            <span aria-hidden="true" class="timeline-scrollbar-arrow-glyph" />
          </button>
          <div
            aria-controls="conversation-timeline"
            aria-label="Posição na conversa"
            aria-orientation="vertical"
            aria-valuemax={Math.round(scrollbar().maximumScroll)}
            aria-valuemin={0}
            aria-valuenow={Math.round(scrollElement?.scrollTop ?? 0)}
            class="timeline-scrollbar-track"
            onKeyDown={handleScrollbarKeyDown}
            onPointerDown={handleScrollbarTrackPointerDown}
            ref={scrollbarTrackElement}
            role="scrollbar"
            tabIndex={scrollbar().scrollable ? 0 : -1}
          >
            <div
              class="timeline-scrollbar-thumb"
              onPointerDown={handleScrollbarThumbPointerDown}
              onPointerMove={handleScrollbarThumbPointerMove}
              onPointerUp={handleScrollbarThumbPointerUp}
              ref={scrollbarThumbElement}
              style={{
                height: `${scrollbar().thumbHeight}px`,
                transform: `translateY(${scrollbar().thumbTop}px)`,
              }}
            />
          </div>
          <button
            aria-controls="conversation-timeline"
            aria-label="Rolar conversa para baixo"
            class="timeline-scrollbar-arrow down"
            disabled={
              !scrollbar().scrollable ||
              scrollbar().thumbTop + scrollbar().thumbHeight >=
                (scrollbarTrackElement?.clientHeight ?? 0) - 0.5
            }
            onClick={() => scrollTimelineBy(64)}
            title="Rolar para baixo"
            type="button"
          >
            <span aria-hidden="true" class="timeline-scrollbar-arrow-glyph" />
          </button>
        </div>
        <Show when={showScrollToEnd()}>
          <button
            aria-label="Ir para o fim da conversa"
            class="scroll-to-end-button"
            onClick={() => scrollToEnd("smooth")}
            title="Ir para o fim da conversa"
            type="button"
          >
            <Icon name="chevronDown" size={16} />
          </button>
        </Show>
      </div>
    </TimelineDisclosureContext.Provider>
  );
}

function VirtualConversationTurn(props: {
  readonly clock: number;
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly measurementKey: string;
  readonly onMeasure: (key: string, size: number) => void;
  readonly top: number;
  readonly turn: VisibleThreadTurn;
}) {
  let element: HTMLDivElement | undefined;
  let observer: ResizeObserver | undefined;
  let measurementFrame: number | undefined;

  function measure(): void {
    if (element !== undefined) {
      props.onMeasure(props.measurementKey, element.getBoundingClientRect().height);
    }
  }

  function scheduleMeasurement(): void {
    if (measurementFrame !== undefined) {
      return;
    }
    measurementFrame = requestAnimationFrame(() => {
      measurementFrame = undefined;
      measure();
    });
  }

  onMount(() => {
    observer = new ResizeObserver(scheduleMeasurement);
    if (element !== undefined) {
      observer.observe(element);
      scheduleMeasurement();
    }
  });
  createEffect(() => {
    props.measurementKey;
    scheduleMeasurement();
  });
  onCleanup(() => {
    observer?.disconnect();
    if (measurementFrame !== undefined) {
      cancelAnimationFrame(measurementFrame);
    }
  });

  return (
    <div
      class="timeline-virtual-item"
      ref={element}
      style={{ transform: `translate3d(0, ${props.top}px, 0)` }}
    >
      <ConversationTurn clock={props.clock} diffDisplay={props.diffDisplay} turn={props.turn} />
    </div>
  );
}

function ConversationTurn(props: {
  readonly clock: number;
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly turn: VisibleThreadTurn;
}) {
  const disclosure = useTimelineDisclosure(
    () => `turn:${props.turn.id}`,
    () => props.turn.status === "inProgress",
  );
  const failure = () => (props.turn.error === null ? null : presentTurnFailure(props.turn.error));

  const userMessages = createMemo(() =>
    props.turn.items.filter((item) => item.type === "userMessage"),
  );

  const nonUserItems = createMemo(() =>
    props.turn.items.filter((item) => item.type !== "userMessage" && item.type !== "plan"),
  );

  const finalAgentMessageIndex = createMemo(() => {
    const items = nonUserItems();
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item?.type === "agentMessage" && item.phase !== "commentary") {
        return i;
      }
    }
    return -1;
  });

  const workItems = createMemo(() => {
    const items = nonUserItems();
    const finalIdx = finalAgentMessageIndex();
    if (finalIdx === -1) {
      return items;
    }
    return items.slice(0, finalIdx);
  });

  const finalAgentMessage = createMemo(() => {
    const items = nonUserItems();
    const finalIdx = finalAgentMessageIndex();
    if (finalIdx === -1) {
      return null;
    }
    const item = items[finalIdx];
    return item ?? null;
  });

  const workUnits = createMemo(() => splitAgentActivityUnits(workItems()));
  const latestReasoningHeading = createMemo(() => {
    const items = workItems();
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (
        item?.type === "reasoning" &&
        [...item.summary, ...item.content].some((part) => part.trim().length > 0)
      ) {
        return reasoningTitle(item.summary, item.content);
      }
    }
    return null;
  });
  const activeThinkingPresentation = createMemo(() => {
    const latestUnit = workUnits().at(-1);
    return thinkingPresentation(
      props.turn.status,
      finalAgentMessage() !== null,
      latestUnit !== undefined && workUnitOwnsActiveHeadline(latestUnit),
    );
  });

  function turnLabel(): string {
    const end =
      props.turn.status === "inProgress"
        ? Math.floor(props.clock / 1_000)
        : Math.max(props.turn.createdAt, props.turn.updatedAt);
    const duration = formatElapsedSeconds(Math.max(0, end - props.turn.createdAt));
    return turnDurationLabel(props.turn.status, duration);
  }

  return (
    <section class="conversation-turn" data-status={props.turn.status}>
      <Index each={userMessages()}>
        {(item) => <TimelineItem diffDisplay={props.diffDisplay} item={item()} />}
      </Index>

      <Show when={workItems().length > 0 || props.turn.status === "inProgress"}>
        <div class="turn-header-wrapper">
          <Show
            when={props.turn.status === "inProgress"}
            fallback={
              <button
                aria-expanded={disclosure.isOpen()}
                aria-label={`${disclosure.isOpen() ? "Ocultar" : "Mostrar"} trabalho do agente`}
                class="turn-header-button"
                data-timeline-disclosure=""
                onClick={disclosure.toggle}
                type="button"
              >
                <span class="turn-duration-label">{turnLabel()}</span>
                <Icon name={disclosure.isOpen() ? "chevronDown" : "chevronRight"} size={12} />
              </button>
            }
          >
            <div aria-atomic="true" aria-live="polite" class="turn-active-status" role="status">
              <span class="turn-duration-label">{turnLabel()}</span>
            </div>
          </Show>
          <div class="turn-header-line" />
        </div>

        <Show when={props.turn.status === "inProgress" || disclosure.isOpen()}>
          <Show when={workItems().length > 0 || activeThinkingPresentation() === "standalone"}>
            <div class="turn-body">
              <Index each={workUnits()}>
                {(unit, index) => (
                  <WorkTimelineUnit
                    diffDisplay={props.diffDisplay}
                    isCurrent={
                      index === workUnits().length - 1 &&
                      activeThinkingPresentation() === "activity"
                    }
                    reasoningHeading={latestReasoningHeading()}
                    unit={unit()}
                  />
                )}
              </Index>
              <Show
                when={
                  activeThinkingPresentation() === "standalone"
                    ? (latestReasoningHeading() ?? "Pensando")
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
        </Show>
      </Show>

      <Show when={finalAgentMessage()}>
        {(msg) => (
          <TimelineItem
            active={props.turn.status === "inProgress"}
            diffDisplay={props.diffDisplay}
            item={msg()}
          />
        )}
      </Show>

      <Show when={failure()}>
        {(presentation) => (
          <section class="turn-failure" role="alert">
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

function WorkTimelineUnit(props: {
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly isCurrent: boolean;
  readonly reasoningHeading: string | null;
  readonly unit: AgentActivityRenderUnit;
}) {
  return (
    <Show
      when={props.unit.kind === "activityGroup" ? props.unit : null}
      fallback={
        <Show when={props.unit.kind === "item" ? props.unit.item : null}>
          {(item) => (
            <TimelineItem active={props.isCurrent} diffDisplay={props.diffDisplay} item={item()} />
          )}
        </Show>
      }
    >
      {(group) => {
        return (
          <AgentActivityGroup
            diffDisplay={props.diffDisplay}
            disclosureKey={group().key}
            isCurrent={props.isCurrent}
            items={group().items}
            reasoningHeading={props.reasoningHeading}
          />
        );
      }}
    </Show>
  );
}

function workUnitOwnsActiveHeadline(unit: AgentActivityRenderUnit): boolean {
  if (unit.kind === "activityGroup") {
    return true;
  }
  const item = unit.item;
  if (item.type === "contextCompaction") {
    return true;
  }
  return (
    (item.type === "commandExecution" ||
      item.type === "fileChange" ||
      item.type === "toolExecution") &&
    item.status === "inProgress"
  );
}

function AgentActivityGroup(props: {
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly disclosureKey: string;
  readonly isCurrent: boolean;
  readonly items: readonly AgentActivityItem[];
  readonly reasoningHeading: string | null;
}) {
  const disclosure = useTimelineDisclosure(() => props.disclosureKey);
  const summaries = createMemo(() => summarizeAgentActivity(props.items));
  const activeActivity = createMemo(() => activeAgentActivity(props.items));
  const title = createMemo(() => {
    if (!props.isCurrent) {
      return agentActivitySummaryLabel(props.items);
    }
    return activeActivity()?.label ?? props.reasoningHeading ?? "Pensando";
  });
  const iconKind = createMemo(() =>
    props.isCurrent ? activeActivity()?.kind : summaries()[0]?.kind,
  );

  return (
    <Show
      when={shouldRenderAgentActivityGroup(props.items, props.isCurrent, disclosure.isOpen())}
      fallback={
        <Show when={props.items[0]}>
          {(item) => <TimelineItem diffDisplay={props.diffDisplay} item={item()} />}
        </Show>
      }
    >
      <details
        class="activity-card agent-activity-group"
        onToggle={(event) => handleDetailsToggle(event, disclosure)}
        open={disclosure.isOpen()}
      >
        <summary class="activity-summary agent-activity-summary" data-timeline-disclosure="">
          <Show when={iconKind()}>
            {(kind) => (
              <span class="activity-icon">
                <Icon name={agentActivityIcon(kind())} size={13} />
              </span>
            )}
          </Show>
          <ActivityHeadline active={props.isCurrent} text={title()} />
          <span class="activity-chevron">
            <Icon name={disclosure.isOpen() ? "chevronDown" : "chevronRight"} size={12} />
          </span>
        </summary>
        <Show when={disclosure.isOpen()}>
          <div class="agent-activity-viewport">
            <div class="agent-activity-list">
              <Index each={props.items}>
                {(item) => (
                  <TimelineItem diffDisplay={props.diffDisplay} item={item()} variant="grouped" />
                )}
              </Index>
            </div>
          </div>
        </Show>
      </details>
    </Show>
  );
}

function agentActivityIcon(kind: AgentActivityKind | undefined): IconName {
  switch (kind) {
    case "fileChanges":
      return "edit";
    case "exploration":
      return "file";
    case "commands":
      return "terminal";
    case "webSearch":
      return "globe";
    default:
      return "sparkles";
  }
}

function EmptyConversation(props: {
  readonly mode: "chat" | "work" | "codex";
  readonly onSelectSuggestion: (prompt: string) => void;
  readonly workspace: string | null;
}) {
  return (
    <section aria-labelledby="empty-conversation-title" class="empty-conversation">
      <Show when={props.mode === "codex"}>
        <div class="empty-orb">
          <CodexGlyph />
        </div>
      </Show>
      <h2 id="empty-conversation-title">
        <Switch>
          <Match when={props.mode === "chat"}>Pronto quando você quiser.</Match>
          <Match when={props.mode === "work"}>No que devemos trabalhar?</Match>
          <Match when={props.mode === "codex"}>
            <Show when={props.workspace} fallback="Em que vamos trabalhar hoje?">
              {(workspace) => (
                <>
                  Em que devemos trabalhar em <span>{projectName(workspace())}</span>?
                </>
              )}
            </Show>
          </Match>
        </Switch>
      </h2>
      <Show when={props.mode === "codex" && props.workspace !== null}>
        <fieldset class="starter-suggestions">
          <legend class="visually-hidden">Sugestões para começar</legend>
          <For each={STARTER_SUGGESTIONS}>
            {(suggestion) => (
              <button
                data-tone={suggestion.tone}
                onClick={() => props.onSelectSuggestion(suggestion.prompt)}
                type="button"
              >
                <Icon name={suggestion.icon} size={22} strokeWidth={2} />
                <span>{suggestion.label}</span>
              </button>
            )}
          </For>
        </fieldset>
      </Show>
    </section>
  );
}

function TimelineItem(props: {
  readonly active?: boolean | undefined;
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly item: VisibleThreadItem;
  readonly variant?: "default" | "grouped" | undefined;
}) {
  switch (props.item.type) {
    case "userMessage":
      return <UserMessage item={props.item} />;
    case "agentMessage":
      return props.item.phase === "commentary" ? (
        <CommentaryMessage item={props.item} streaming={props.active === true} />
      ) : (
        <AgentMessage item={props.item} streaming={props.active === true} />
      );
    case "contextCompaction":
      return <ContextCompaction active={props.active} item={props.item} />;
    case "reasoning":
      return null;
    case "plan":
      return null;
    case "commandExecution":
      return <CommandItem item={props.item} variant={props.variant} />;
    case "fileChange":
      return (
        <FileChangeItem diffDisplay={props.diffDisplay} item={props.item} variant={props.variant} />
      );
    case "toolExecution":
      return <ToolItem item={props.item} variant={props.variant} />;
  }
}

function ContextCompaction(props: {
  readonly active?: boolean | undefined;
  readonly item: Extract<ThreadItem, { type: "contextCompaction" }>;
}) {
  return (
    <section class="context-compaction-row" id={props.item.id}>
      <span class="activity-icon">
        <Icon name="layers" size={13} />
      </span>
      <ActivityHeadline
        active={props.active === true}
        class="activity-title compaction-text"
        text="Compactando contexto"
      />
    </section>
  );
}

function UserMessage(props: { readonly item: Extract<ThreadItem, { type: "userMessage" }> }) {
  let bubble: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let measurementFrame: number | undefined;
  const disclosure = useTimelineDisclosure(() => `user-message:${props.item.id}`);
  const [collapsible, setCollapsible] = createSignal(false);
  const imageContent = createMemo(() =>
    props.item.content.filter(
      (content): content is Extract<UserContent, { type: "localImage" }> =>
        content.type === "localImage",
    ),
  );
  const bubbleContent = createMemo(() =>
    props.item.content.filter((content) => content.type !== "localImage"),
  );

  function measure(): void {
    if (bubble === undefined || disclosure.isOpen()) {
      return;
    }
    setCollapsible(bubble.scrollHeight > bubble.clientHeight + 1);
  }

  function scheduleMeasurement(): void {
    if (measurementFrame !== undefined) {
      return;
    }
    measurementFrame = requestAnimationFrame(() => {
      measurementFrame = undefined;
      measure();
    });
  }

  onMount(() => {
    resizeObserver = new ResizeObserver(scheduleMeasurement);
    if (bubble !== undefined) {
      resizeObserver.observe(bubble);
    }
    scheduleMeasurement();
  });
  onCleanup(() => {
    resizeObserver?.disconnect();
    if (measurementFrame !== undefined) {
      cancelAnimationFrame(measurementFrame);
    }
  });

  return (
    <article class="message-row user-message-row" id={userMessageAnchor(props.item.id)}>
      <div class="message-content">
        <span class="visually-hidden">Você disse:</span>
        <Show when={imageContent().length > 0}>
          <div class="message-image-grid user-message-images">
            <For each={imageContent()}>
              {(content) => (
                <ImagePreview
                  alt={imageContentName(content.path)}
                  class="message-image-preview"
                  name={imageContentName(content.path)}
                  source={content.path}
                />
              )}
            </For>
          </div>
        </Show>
        <Show when={bubbleContent().length > 0}>
          <div
            class="user-message-bubble"
            classList={{
              clamped: !disclosure.isOpen(),
              collapsed: collapsible() && !disclosure.isOpen(),
            }}
            ref={bubble}
            style={{ "--collapsed-lines": USER_MESSAGE_COLLAPSED_LINES }}
          >
            <For each={bubbleContent()}>{(content) => <UserContentPart content={content} />}</For>
          </div>
        </Show>
        <Show when={collapsible()}>
          <button
            aria-expanded={disclosure.isOpen()}
            class="user-message-expand"
            data-timeline-disclosure=""
            onClick={disclosure.toggle}
            type="button"
          >
            {disclosure.isOpen() ? "Mostrar menos" : "Mostrar mais"}
          </button>
        </Show>
        <div class="message-actions user-message-actions">
          <CopyMessageButton text={userMessageCopyText(props.item.content)} />
        </div>
      </div>
    </article>
  );
}

function UserContentPart(props: { readonly content: UserContent }) {
  switch (props.content.type) {
    case "text":
      return <p class="message-text">{props.content.text}</p>;
    case "localImage":
      return null;
    case "mention":
      return (
        <div class="attachment-line">
          <Icon name="file" size={15} /> {props.content.name}
        </div>
      );
  }
}

function CommentaryMessage(props: {
  readonly item: Extract<ThreadItem, { type: "agentMessage" }>;
  readonly streaming: boolean;
}) {
  const disclosure = useTimelineDisclosure(() => `commentary:${props.item.id}`);
  const content = () => presentAssistantText(props.item.text).trim();
  const title = () => reasoningTitle([], [content()]);
  const hasDetails = () => content().includes("\n") || content() !== title();

  return (
    <Show when={content()}>
      {(visibleContent) => (
        <Show
          when={hasDetails()}
          fallback={
            <section class="activity-card commentary-card">
              <p class="commentary-message-text">{visibleContent()}</p>
            </section>
          }
        >
          <details
            class="activity-card commentary-card"
            onToggle={(event) => disclosure.setOpen(event.currentTarget.open)}
            open={disclosure.isOpen()}
          >
            <summary class="activity-summary" data-timeline-disclosure="">
              <ActivityHeadline text={title()} />
              <span class="activity-chevron">
                <Icon name={disclosure.isOpen() ? "chevronDown" : "chevronRight"} size={12} />
              </span>
            </summary>
            <div class="commentary-content">
              <Markdown streaming={props.streaming} text={props.item.text} />
            </div>
          </details>
        </Show>
      )}
    </Show>
  );
}

function AgentMessage(props: {
  readonly item: Extract<ThreadItem, { type: "agentMessage" }>;
  readonly streaming: boolean;
}) {
  const content = () => presentAssistantText(props.item.text);
  const visibleContent = () => content().trim().length > 0;
  return (
    <Show when={visibleContent()}>
      <article class="message-row agent-message-row">
        <div class="message-content">
          <span class="visually-hidden">Codex disse:</span>
          <Markdown
            class="agent-message-markdown"
            streaming={props.streaming}
            text={props.item.text}
          />
          <div class="message-actions">
            <CopyMessageButton text={content()} />
          </div>
        </div>
      </article>
    </Show>
  );
}

function CopyMessageButton(props: { readonly text: string }) {
  const [state, setState] = createSignal<"copied" | "failed" | "idle">("idle");
  let resetTimer: number | undefined;

  onCleanup(() => window.clearTimeout(resetTimer));

  async function copy(): Promise<void> {
    window.clearTimeout(resetTimer);
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(props.text);
      setState("copied");
    } catch {
      setState("failed");
    }
    resetTimer = window.setTimeout(() => setState("idle"), 2_000);
  }

  const label = () => {
    switch (state()) {
      case "copied":
        return "Copiado";
      case "failed":
        return "Falha ao copiar";
      case "idle":
        return "Copiar";
    }
  };

  return (
    <button
      aria-label={label()}
      aria-live="polite"
      class="message-copy-button"
      disabled={props.text.length === 0}
      onClick={() => void copy()}
      title={label()}
      type="button"
    >
      <Icon name={state() === "copied" ? "check" : "copy"} size={14} />
      <span class="visually-hidden">{label()}</span>
    </button>
  );
}

function ActivityHeadline(props: {
  readonly active?: boolean | undefined;
  readonly class?: string;
  readonly text: string;
}) {
  return (
    <span
      class={props.class ?? "activity-title"}
      classList={{ "is-running": props.active === true }}
    >
      <span class="activity-title-base">{props.text}</span>
      <Show when={props.active === true}>
        <span aria-hidden="true" class="activity-title-sweep">
          <span class="activity-title-highlight">{props.text}</span>
        </span>
      </Show>
    </span>
  );
}

function CommandItem(props: {
  readonly item: Extract<ThreadItem, { type: "commandExecution" }>;
  readonly variant?: "default" | "grouped" | undefined;
}) {
  const disclosure = useTimelineDisclosure(
    () => `command:${props.item.id}:${disclosurePhase(props.item.status)}`,
  );
  const title = () =>
    commandActivityTitle(
      props.item.command,
      props.item.status,
      props.variant === "grouped" ? false : disclosure.isOpen(),
    );
  const output = () => commandOutputText(props.item.aggregatedOutput);

  return (
    <details
      class="activity-card command-activity-card"
      classList={{ "grouped-activity-item": props.variant === "grouped" }}
      onToggle={(event) => handleDetailsToggle(event, disclosure)}
      open={disclosure.isOpen()}
    >
      <summary class="activity-summary" data-timeline-disclosure="">
        <span class="activity-icon">
          <Icon name="terminal" size={13} />
        </span>
        <ActivityHeadline active={props.item.status === "inProgress"} text={title()} />
        <span class="activity-chevron">
          <Icon name={disclosure.isOpen() ? "chevronDown" : "chevronRight"} size={12} />
        </span>
      </summary>
      <Show when={disclosure.isOpen()}>
        <div class="command-card-inner">
          <div class="command-card-header">Shell</div>
          <div class="command-card-scroll">
            <div class="command-card-prompt">
              <span class="prompt-symbol">$</span> {props.item.command}
            </div>
            <Show when={output()}>
              {(visibleOutput) => <pre class="command-card-output">{visibleOutput()}</pre>}
            </Show>
          </div>
          <Show when={props.item.status === "failed" || props.item.status === "declined"}>
            <div class="command-card-footer">
              <span class="status-failed-text">
                <Icon name="close" size={12} />
                {props.item.status === "declined" ? "Recusado" : "Falhou"}
              </span>
            </div>
          </Show>
        </div>
      </Show>
    </details>
  );
}

function ToolItem(props: {
  readonly item: Extract<ThreadItem, { type: "toolExecution" }>;
  readonly variant?: "default" | "grouped" | undefined;
}) {
  const disclosure = useTimelineDisclosure(
    () => `tool:${props.item.id}:${disclosurePhase(props.item.status)}`,
  );
  const description = () => props.item.description || toolLabel(props.item.name);
  const imageSource = () => extractToolImageSource(props.item.name, props.item.output);
  const isWebSearch = () => props.item.name === "web_search" || props.item.name === "web_fetch";
  const hasDetails = () =>
    imageSource() !== null ||
    (props.item.output !== null && props.item.output.length > 0) ||
    props.item.status === "failed" ||
    props.item.status === "declined";
  const title = () =>
    isWebSearch()
      ? webSearchActivityTitle(description(), props.item.status)
      : imageSource() === null
        ? toolActivityTitle(description(), props.item.status, disclosure.isOpen())
        : description();

  const headline = () => (
    <>
      <span class="activity-icon">
        <Icon name={toolIconName(props.item.name)} size={13} />
      </span>
      <ActivityHeadline active={props.item.status === "inProgress"} text={title()} />
    </>
  );

  return (
    <Show
      when={hasDetails()}
      fallback={
        <div
          class="activity-card activity-summary tool-activity-card tool-activity-row"
          classList={{ "grouped-activity-item": props.variant === "grouped" }}
        >
          {headline()}
        </div>
      }
    >
      <details
        class="activity-card tool-activity-card"
        classList={{
          "grouped-activity-item": props.variant === "grouped",
          "image-tool-activity": imageSource() !== null,
        }}
        onToggle={(event) => handleDetailsToggle(event, disclosure)}
        open={disclosure.isOpen()}
      >
        <summary class="activity-summary" data-timeline-disclosure="">
          {headline()}
          <span class="activity-chevron">
            <Icon name={disclosure.isOpen() ? "chevronDown" : "chevronRight"} size={12} />
          </span>
        </summary>
        <Show when={disclosure.isOpen()}>
          <div class="command-card-inner">
            <Show when={imageSource() === null}>
              <div class="command-card-header">{toolLabel(props.item.name)}</div>
            </Show>
            <Show
              when={imageSource()}
              fallback={
                <Show when={props.item.output !== null && props.item.output.length > 0}>
                  <div class="command-card-scroll">
                    <pre class="command-card-output">{props.item.output}</pre>
                  </div>
                </Show>
              }
            >
              {(source) => (
                <div class="tool-image-result">
                  <ImagePreview
                    alt={description()}
                    class="tool-image-preview"
                    name={description()}
                    source={source()}
                  />
                </div>
              )}
            </Show>
            <Show when={props.item.status === "failed" || props.item.status === "declined"}>
              <div class="command-card-footer">
                <span class="status-failed-text">
                  <Icon name="close" size={12} />
                  {props.item.status === "declined" ? "Recusada" : "Falhou"}
                </span>
              </div>
            </Show>
          </div>
        </Show>
      </details>
    </Show>
  );
}

function FileChangeItem(props: {
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly item: Extract<ThreadItem, { type: "fileChange" }>;
  readonly variant?: "default" | "grouped" | undefined;
}) {
  const disclosure = useTimelineDisclosure(
    () => `file-change:${props.item.id}:${disclosurePhase(props.item.status)}`,
  );
  const title = () => fileChangeActivityTitle(props.item.changes);

  return (
    <Show
      when={props.variant === "grouped" && props.item.changes.length === 1}
      fallback={
        <details
          class="activity-card file-change-card"
          classList={{ "grouped-activity-item": props.variant === "grouped" }}
          onToggle={(event) => handleDetailsToggle(event, disclosure)}
          open={disclosure.isOpen()}
        >
          <summary class="activity-summary" data-timeline-disclosure="">
            <span class="activity-icon">
              <Icon name="edit" size={13} />
            </span>
            <ActivityHeadline active={props.item.status === "inProgress"} text={title()} />
            <span class="activity-chevron">
              <Icon name={disclosure.isOpen() ? "chevronDown" : "chevronRight"} size={12} />
            </span>
          </summary>
          <Show when={disclosure.isOpen()}>
            <div class="file-change-list">
              <Index each={props.item.changes}>
                {(change, index) => (
                  <Change
                    change={change()}
                    diffDisplay={props.diffDisplay}
                    disclosureKey={`change:${props.item.id}:${index}`}
                    status={props.item.status}
                    variant={props.variant}
                  />
                )}
              </Index>
            </div>
          </Show>
        </details>
      }
    >
      <Change
        change={props.item.changes[0] as FileChange}
        diffDisplay={props.diffDisplay}
        disclosureKey={`change:${props.item.id}:0`}
        status={props.item.status}
        variant="grouped"
      />
    </Show>
  );
}

function Change(props: {
  readonly change: FileChange;
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly disclosureKey: string;
  readonly status: Extract<ThreadItem, { type: "fileChange" }>["status"];
  readonly variant?: "default" | "grouped" | undefined;
}) {
  const disclosure = useTimelineDisclosure(
    () => `${props.disclosureKey}:${disclosurePhase(props.status)}`,
  );
  const stats = createMemo(() => summarizeDiff(props.change.diff));
  const [copyState, setCopyState] = createSignal<"copied" | "failed" | "idle">("idle");
  let resetTimer: number | undefined;

  onCleanup(() => window.clearTimeout(resetTimer));

  async function copyDiff(event: MouseEvent): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    window.clearTimeout(resetTimer);
    try {
      if (navigator.clipboard === undefined) {
        throw new Error("Clipboard API unavailable");
      }
      await navigator.clipboard.writeText(props.change.diff);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    resetTimer = window.setTimeout(() => setCopyState("idle"), 2_000);
  }

  const copyLabel = () => {
    switch (copyState()) {
      case "copied":
        return "Diff copiado";
      case "failed":
        return "Falha ao copiar o diff";
      case "idle":
        return "Copiar diff";
    }
  };

  return (
    <details
      class="diff-block"
      classList={{ "grouped-diff-block": props.variant === "grouped" }}
      data-kind={props.change.kind.type}
      onToggle={(event) => handleDetailsToggle(event, disclosure)}
      open={disclosure.isOpen()}
    >
      <summary data-timeline-disclosure="">
        <Show when={props.variant === "grouped"}>
          <span class="activity-icon">
            <Icon name="edit" size={13} />
          </span>
          <span class="grouped-change-action">{groupedChangeAction(props.change)}</span>
        </Show>
        <span class="diff-file-identity">
          <code title={props.change.path}>{fileName(props.change.path)}</code>
          <Show when={props.variant !== "grouped" && props.change.kind.type !== "update"}>
            <span class={`change-kind kind-${props.change.kind.type}`}>
              {props.change.kind.type === "add" ? "NOVO" : "EXCLUÍDO"}
            </span>
          </Show>
        </span>
        <span class="diff-stat additions" title={`${stats().additions} linhas adicionadas`}>
          +{stats().additions}
        </span>
        <span class="diff-stat deletions" title={`${stats().deletions} linhas removidas`}>
          −{stats().deletions}
        </span>
        <span class="diff-file-actions">
          <span aria-hidden="true" class="diff-file-chevron">
            <Icon name={disclosure.isOpen() ? "chevronDown" : "chevronRight"} size={12} />
          </span>
          <button
            aria-label={copyLabel()}
            class="diff-copy-button"
            onClick={(event) => void copyDiff(event)}
            title={copyLabel()}
            type="button"
          >
            <Icon name={copyState() === "copied" ? "check" : "copy"} size={13} />
          </button>
        </span>
      </summary>
      <Show when={disclosure.isOpen()}>
        <Show
          when={props.change.diff.trim().length > 0}
          fallback={<div class="diff-empty-state">Nenhuma diferença textual disponível.</div>}
        >
          <Show
            when={props.diffDisplay === "split"}
            fallback={<UnifiedDiffView diff={props.change.diff} path={props.change.path} />}
          >
            <SplitDiffView diff={props.change.diff} path={props.change.path} />
          </Show>
        </Show>
      </Show>
    </details>
  );
}

function groupedChangeAction(change: FileChange): string {
  switch (change.kind.type) {
    case "add":
      return "Criado";
    case "delete":
      return "Excluído";
    case "update":
      return "Edição";
  }
}

function userMessageCopyText(content: readonly UserContent[]): string {
  return content.map(userContentPartCopyText).join("\n");
}

function inlinePreview(text: string, maximumLength: number): string {
  const normalized = text.replace(/\s+/gu, " ").trim() || "Mensagem sem texto";
  return normalized.length <= maximumLength
    ? normalized
    : `${normalized.slice(0, maximumLength - 1)}…`;
}

function blockPreview(text: string, maximumLength: number): string {
  const normalized = text
    .replace(/\r\n?/gu, "\n")
    .replace(/[^\S\r\n]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return normalized.length <= maximumLength
    ? normalized
    : `${normalized.slice(0, maximumLength - 1)}…`;
}

function userMessageAnchor(id: string): string {
  return `user-message-${id}`;
}

function userContentPartCopyText(part: UserContent): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "localImage":
      return `Imagem: ${imageContentName(part.path)}`;
    case "mention":
      return part.name;
  }
}

function imageContentName(path: string): string {
  const name = fileName(path);
  return name.length <= 160 ? name : "Imagem anexada";
}

function formatElapsedSeconds(seconds: number): string {
  if (seconds < 1) {
    return "0 s";
  }
  if (seconds < 60) {
    return `${seconds} s`;
  }
  if (seconds < 3_600) {
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder === 0 ? `${minutes} min` : `${minutes} min ${remainder} s`;
  }
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}
