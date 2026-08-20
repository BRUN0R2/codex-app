import {
  createEffect,
  createMemo,
  createSignal,
  ErrorBoundary,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from "solid-js";

import type { FileChange, ThreadItem, VisibleThreadItem } from "../contracts/types";
import type { AppController } from "../state/appController";

type TimelineController = Pick<
  AppController,
  | "activeTurnId"
  | "config"
  | "conversationMode"
  | "currentThread"
  | "hasOlderHistory"
  | "historyLoading"
  | "isItemStreaming"
  | "loadOlderHistory"
  | "persistedTurns"
  | "reportError"
  | "turns"
  | "workspace"
>;

import { projectName } from "../state/projects";
import type { VisibleThreadTurn } from "../state/visibleTurnSequence";
import { fileName, toolIconName, toolLabel } from "./activityLabels";
import {
  type AgentActivityItem,
  type AgentActivityKind,
  AgentActivityProjectionStore,
  type AgentActivityRenderUnit,
  activeAgentActivity,
  agentActivityRenderUnitIdentity,
  agentActivitySummaryLabel,
  shouldRenderAgentActivityGroup,
  summarizeAgentActivity,
  webSearchActivityTitle,
} from "./agentActivityPresentation";
import { CodexGlyph } from "./CodexGlyph";
import { presentAssistantText } from "./contentReferenceMarkers";
import { DiffView } from "./DiffView";
import { createDiffDocument, summarizeDiff } from "./diffDocument";
import { observeElementResize } from "./elementResize";
import { FrontendFailureContext, useFrontendFailureReporter } from "./frontendFailure";
import { Icon, type IconName } from "./Icon";
import { TimelineTurnRenderFailure } from "./RenderFailure";
import { ThreadOutputView } from "./ThreadOutputView";
import {
  AgentMessage,
  blockPreview,
  CommentaryMessage,
  inlinePreview,
  UserMessage,
  userMessageCopyText,
} from "./TimelineMessages";
import { createTimelineDisclosureStore } from "./timelineDisclosure";
import {
  handleTimelineDetailsToggle,
  type TimelineDisclosureBinding,
  TimelineDisclosureContext,
  type TimelineDisclosureContextValue,
  timelineDisclosureNamespacePrefix,
  useTimelineDisclosure,
} from "./timelineDisclosureContext";
import {
  timelineFileChangeIdentity,
  timelineItemIdentity,
  timelineItemRenderIdentity,
} from "./timelineIdentity";
import {
  commandActivityTitle,
  commandOutputText,
  fileChangeActivityTitle,
  reasoningTitle,
  thinkingPresentation,
  toolActivityTitle,
  toolOutputText,
  turnDurationLabel,
} from "./timelinePresentation";
import {
  calculateTimelineScrollbar,
  findTimelineAnchorIndex,
  hasRecentTimelineUserScrollIntent,
  isTimelineNearEnd,
  resolveTimelineFollowing,
  resolveTimelineRestorationTop,
  type ScrollbarMetrics,
  shouldSynchronizeTimelineToEnd,
} from "./timelineScroll";
import { TimelineThreadSessionStore } from "./timelineSession";
import { presentTurnFailure } from "./turnFailure";
import {
  asTurnMessageBlock,
  asTurnWorkBlock,
  type TurnPresentationBlock,
  TurnPresentationStore,
  type TurnWorkItem,
} from "./turnPresentation";
import { type UserMessageEntry, UserMessageNavigator } from "./UserMessageNavigator";
import { VariableSizeVirtualizer } from "./variableSizeVirtualizer";

interface StarterSuggestion {
  readonly icon: IconName;
  readonly label: string;
  readonly prompt: string;
}

const STARTER_SUGGESTIONS: readonly StarterSuggestion[] = [
  {
    icon: "telescope",
    label: "Explore e entenda código",
    prompt:
      "Explore este projeto e explique sua arquitetura, os fluxos principais e os riscos técnicos mais importantes.",
  },
  {
    icon: "hammer",
    label: "Crie um novo recurso, aplicativo ou ferramenta",
    prompt:
      "Implemente um novo recurso neste projeto. Primeiro identifique a melhor integração arquitetural e então faça a alteração completa com validação.",
  },
  {
    icon: "syncCheck",
    label: "Revisar código e sugerir mudanças",
    prompt:
      "Revise as alterações atuais do projeto, priorize bugs, riscos e regressões e proponha correções objetivas.",
  },
  {
    icon: "bug",
    label: "Corrigir problemas e falhas",
    prompt:
      "Investigue os problemas atuais do projeto, encontre a causa raiz e implemente uma correção completa e verificável.",
  },
];

const TIMELINE_ESTIMATED_TURN_HEIGHT = 498;
const TIMELINE_VIRTUAL_OVERSCAN_PX = 900;
const TIMELINE_HISTORY_LOAD_THRESHOLD_PX = 640;
const TIMELINE_SESSION_CACHE_CAPACITY: number = 16;

interface TimelineUserMessageEntry extends UserMessageEntry {
  readonly turnIndex: number;
}

export function Timeline(props: {
  readonly controller: TimelineController;
  readonly onSelectSuggestion: (prompt: string) => void;
}) {
  let scrollElement: HTMLDivElement | undefined;
  let contentElement: HTMLDivElement | undefined;
  let virtualListElement: HTMLDivElement | undefined;
  let scrollbarTrackElement: HTMLDivElement | undefined;
  let scrollbarThumbElement: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let animationFrame: number | undefined;
  let pendingLayoutSynchronization = false;
  let pendingUserScrollMeasurement = false;
  let historyRevealFrame: number | undefined;
  let timelineRestorationFrame: number | undefined;
  let virtualMeasurementFrame: number | undefined;
  let lastUserScrollIntentAt = Number.NEGATIVE_INFINITY;
  let smoothScrollTarget: number | null = null;
  let activeTimelineThreadId: string | null = null;
  let timelineTransitionRevision = 0;
  let observedActiveTurnId: string | null | undefined;
  let observedThreadId: string | null | undefined;
  let dragState:
    | { readonly pointerId: number; readonly startScrollTop: number; readonly startY: number }
    | undefined;
  const [followingLatest, setFollowingLatest] = createSignal(true);
  const [showScrollToEnd, setShowScrollToEnd] = createSignal(false);
  const [activeUserMessageIndex, setActiveUserMessageIndex] = createSignal(0);
  const [clock, setClock] = createSignal(Date.now());
  const timelineSessions = new TimelineThreadSessionStore(
    () => new VariableSizeVirtualizer(TIMELINE_ESTIMATED_TURN_HEIGHT),
    TIMELINE_SESSION_CACHE_CAPACITY,
  );
  let virtualizer = new VariableSizeVirtualizer(TIMELINE_ESTIMATED_TURN_HEIGHT);
  const [virtualRevision, setVirtualRevision] = createSignal(0);
  const [virtualViewport, setVirtualViewport] = createSignal({ offset: 0, size: 1 });
  const [scrollbar, setScrollbar] = createSignal<ScrollbarMetrics>({
    maximumScroll: 0,
    scrollable: false,
    thumbHeight: 0,
    thumbTop: 0,
  });
  const disclosures = createTimelineDisclosureStore();
  const disclosureContext: TimelineDisclosureContextValue = {
    keyPrefix: () => timelineDisclosureNamespacePrefix(props.controller.currentThread()?.id ?? ""),
    store: disclosures,
  };
  const reportFrontendFailure = (reason: unknown) => props.controller.reportError(reason);
  const pendingVirtualMeasurements = new Map<string, number>();
  const virtualRange = createMemo(() => {
    virtualRevision();
    const viewport = virtualViewport();
    return virtualizer.range(viewport.offset, viewport.size, TIMELINE_VIRTUAL_OVERSCAN_PX);
  });
  const virtualTurns = createMemo(() => {
    const range = virtualRange();
    return props.controller.turns().slice(range.start, range.end);
  });
  const virtualTurnIds = createMemo(() => virtualTurns().map((turn) => turn.id));
  const virtualTurnsById = createMemo(
    () => new Map(virtualTurns().map((turn) => [turn.id, turn] as const)),
  );
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
    setActiveTimelineFollowing(false);
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
      scrollTimelineTo(
        previousScrollTop + Math.max(0, scrollElement.scrollHeight - previousScrollHeight),
      );
      scheduleTimelineFrame(false, false);
    });
  }

  function updateVirtualViewport(): void {
    if (scrollElement === undefined || virtualListElement === undefined) {
      return;
    }
    const nextViewport = {
      offset: Math.max(0, scrollElement.scrollTop - virtualListElement.offsetTop),
      size: Math.max(1, scrollElement.clientHeight),
    };
    setVirtualViewport((current) => {
      return current.offset === nextViewport.offset && current.size === nextViewport.size
        ? current
        : nextViewport;
    });
  }

  function scrollTimelineTo(top: number, behavior: ScrollBehavior = "auto"): void {
    if (scrollElement === undefined) {
      return;
    }
    const maximumScroll = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    const target = Math.min(maximumScroll, Math.max(0, top));
    if (behavior === "auto") {
      // Direct assignments have no animation lifecycle to consume. Keeping a target here
      // makes a later real user scroll look programmatic and re-enables auto-follow.
      smoothScrollTarget = null;
      scrollElement.scrollTop = target;
      return;
    }
    if (Math.abs(scrollElement.scrollTop - target) <= 1) {
      smoothScrollTarget = null;
      return;
    }
    smoothScrollTarget = target;
    scrollElement.scrollTo({ behavior, top: target });
  }

  function consumeSmoothScroll(): boolean {
    if (scrollElement === undefined || smoothScrollTarget === null) {
      return false;
    }
    if (Math.abs(scrollElement.scrollTop - smoothScrollTarget) <= 1) {
      smoothScrollTarget = null;
    }
    return true;
  }

  function saveActiveTimelineViewport(nextFollowingLatest = followingLatest()): void {
    if (activeTimelineThreadId === null || scrollElement === undefined) {
      return;
    }
    timelineSessions.save(activeTimelineThreadId, {
      followingLatest: nextFollowingLatest,
      scrollTop: Math.max(0, scrollElement.scrollTop),
    });
  }

  function setActiveTimelineFollowing(nextFollowingLatest: boolean): void {
    setFollowingLatest(nextFollowingLatest);
    saveActiveTimelineViewport(nextFollowingLatest);
  }

  function cancelPendingTimelineWork(): number {
    timelineTransitionRevision += 1;
    if (animationFrame !== undefined) {
      cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
    }
    if (historyRevealFrame !== undefined) {
      cancelAnimationFrame(historyRevealFrame);
      historyRevealFrame = undefined;
    }
    if (timelineRestorationFrame !== undefined) {
      cancelAnimationFrame(timelineRestorationFrame);
      timelineRestorationFrame = undefined;
    }
    if (virtualMeasurementFrame !== undefined) {
      cancelAnimationFrame(virtualMeasurementFrame);
      virtualMeasurementFrame = undefined;
    }
    pendingLayoutSynchronization = false;
    pendingUserScrollMeasurement = false;
    pendingVirtualMeasurements.clear();
    smoothScrollTarget = null;
    lastUserScrollIntentAt = Number.NEGATIVE_INFINITY;
    if (
      dragState !== undefined &&
      scrollbarThumbElement?.hasPointerCapture(dragState.pointerId) === true
    ) {
      scrollbarThumbElement.releasePointerCapture(dragState.pointerId);
    }
    dragState = undefined;
    return timelineTransitionRevision;
  }

  function activateTimelineThread(
    threadId: string | null,
    persistedTurns: readonly VisibleThreadTurn[],
  ): void {
    saveActiveTimelineViewport();
    const transitionRevision = cancelPendingTimelineWork();
    activeTimelineThreadId = threadId;
    setActiveUserMessageIndex(0);
    setShowScrollToEnd(false);
    setScrollbar({
      maximumScroll: 0,
      scrollable: false,
      thumbHeight: 0,
      thumbTop: 0,
    });

    const viewportSize = Math.max(1, scrollElement?.clientHeight ?? 1);
    const session =
      threadId === null ? null : timelineSessions.activate(threadId, persistedTurns).session;
    virtualizer =
      session?.virtualizer ?? new VariableSizeVirtualizer(TIMELINE_ESTIMATED_TURN_HEIGHT);
    const following = session?.followingLatest ?? true;
    const savedScrollTop = session?.scrollTop ?? 0;
    const initialMaximumScroll = Math.max(0, virtualizer.totalSize() - viewportSize);
    const initialScrollTop = resolveTimelineRestorationTop({
      followingLatest: following,
      maximumScroll: initialMaximumScroll,
      savedScrollTop,
    });
    setFollowingLatest(following);
    setVirtualViewport({ offset: initialScrollTop, size: viewportSize });
    setVirtualRevision((revision) => revision + 1);

    timelineRestorationFrame = requestAnimationFrame(() => {
      timelineRestorationFrame = undefined;
      if (
        timelineTransitionRevision !== transitionRevision ||
        (props.controller.currentThread()?.id ?? null) !== threadId ||
        scrollElement === undefined
      ) {
        return;
      }
      const maximumScroll = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
      scrollTimelineTo(
        resolveTimelineRestorationTop({
          followingLatest: following,
          maximumScroll,
          savedScrollTop,
        }),
      );
      pendingLayoutSynchronization = false;
      pendingUserScrollMeasurement = false;
      measureScroll(false);
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
    pendingVirtualMeasurements.set(key, size);
    if (virtualMeasurementFrame !== undefined) {
      return;
    }
    virtualMeasurementFrame = requestAnimationFrame(() => {
      virtualMeasurementFrame = undefined;
      const measurements = [...pendingVirtualMeasurements].map(
        ([measurementKey, measuredSize]) => ({
          key: measurementKey,
          size: measuredSize,
        }),
      );
      pendingVirtualMeasurements.clear();
      const batch = virtualizer.measureBatch(measurements, virtualViewport().offset);
      if (!batch.changed) {
        return;
      }
      if (scrollElement !== undefined && !followingLatest() && batch.anchorDelta !== 0) {
        scrollTimelineTo(scrollElement.scrollTop + batch.anchorDelta);
      }
      setVirtualRevision((revision) => revision + 1);
      synchronizeScroll();
    });
  }

  function measureScroll(userInitiated: boolean): void {
    if (scrollElement === undefined) {
      return;
    }
    updateVirtualViewport();
    const trackHeight = scrollbarTrackElement?.clientHeight ?? 0;
    const nextScrollbar = calculateTimelineScrollbar({
      clientHeight: scrollElement.clientHeight,
      scrollHeight: scrollElement.scrollHeight,
      scrollTop: scrollElement.scrollTop,
      trackHeight,
    });
    setScrollbar((current) =>
      sameScrollbarMetrics(current, nextScrollbar) ? current : nextScrollbar,
    );
    const isNearEnd = isTimelineNearEnd({
      clientHeight: scrollElement.clientHeight,
      scrollHeight: scrollElement.scrollHeight,
      scrollTop: scrollElement.scrollTop,
    });
    setShowScrollToEnd(!isNearEnd);
    const nextFollowingLatest = resolveTimelineFollowing({
      followingLatest: followingLatest(),
      nearEnd: isNearEnd,
      userInitiated,
    });
    setActiveTimelineFollowing(nextFollowingLatest);
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
    smoothScrollTarget = null;
    lastUserScrollIntentAt = performance.now();
  }

  function targetsNestedScrollableContent(target: EventTarget | null): boolean {
    if (!(target instanceof Element) || scrollElement === undefined) {
      return false;
    }
    for (
      let element: Element | null = target;
      element !== null && element !== scrollElement;
      element = element.parentElement
    ) {
      const style = window.getComputedStyle(element);
      const vertical =
        element.scrollHeight > element.clientHeight + 1 &&
        (style.overflowY === "auto" || style.overflowY === "scroll");
      const horizontal =
        element.scrollWidth > element.clientWidth + 1 &&
        (style.overflowX === "auto" || style.overflowX === "scroll");
      if (vertical || horizontal) {
        return true;
      }
    }
    return false;
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
    if (
      !event.isPrimary ||
      (event.pointerType === "mouse" && event.button !== 0 && event.button !== 1)
    ) {
      return;
    }
    markUserScrollIntent();
    if (targetsNestedScrollableContent(event.target)) {
      setActiveTimelineFollowing(false);
    }
  }

  function handleTimelineWheel(event: WheelEvent): void {
    markUserScrollIntent();
    if (targetsNestedScrollableContent(event.target)) {
      setActiveTimelineFollowing(false);
    }
  }

  function handleTimelineFocusIn(event: FocusEvent): void {
    if (targetsNestedScrollableContent(event.target)) {
      setActiveTimelineFollowing(false);
    }
  }

  function handleTimelineClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-timeline-disclosure]")) {
      setActiveTimelineFollowing(false);
    }
  }

  function scheduleTimelineFrame(userInitiated: boolean, synchronizeLayout: boolean): void {
    pendingUserScrollMeasurement ||= userInitiated;
    pendingLayoutSynchronization ||= synchronizeLayout;
    if (timelineRestorationFrame !== undefined || animationFrame !== undefined) {
      return;
    }
    animationFrame = requestAnimationFrame(() => {
      animationFrame = undefined;
      const shouldSynchronizeLayout = pendingLayoutSynchronization;
      const shouldMeasureAsUserScroll = pendingUserScrollMeasurement;
      pendingLayoutSynchronization = false;
      pendingUserScrollMeasurement = false;
      if (scrollElement === undefined) {
        return;
      }
      if (
        shouldSynchronizeTimelineToEnd({
          followingLatest: followingLatest(),
          layoutRequested: shouldSynchronizeLayout,
          recentUserIntent: hasRecentTimelineUserScrollIntent(
            lastUserScrollIntentAt,
            performance.now(),
          ),
        })
      ) {
        scrollTimelineTo(scrollElement.scrollHeight);
      }
      measureScroll(shouldMeasureAsUserScroll);
    });
  }

  function synchronizeScroll(): void {
    scheduleTimelineFrame(false, true);
  }

  function scrollToEnd(behavior: ScrollBehavior = "auto"): void {
    if (scrollElement === undefined) {
      return;
    }
    setActiveTimelineFollowing(true);
    scrollTimelineTo(scrollElement.scrollHeight, behavior);
    if (behavior === "auto") {
      scheduleTimelineFrame(false, false);
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
    setActiveTimelineFollowing(false);
    scrollTimelineTo(
      Math.max(0, virtualListElement.offsetTop + virtualizer.offsetOf(target.turnIndex) - 32),
      "smooth",
    );
  }

  function setScrollTopFromThumb(thumbTop: number, userInitiated: boolean): void {
    if (scrollElement === undefined || scrollbarTrackElement === undefined) {
      return;
    }
    smoothScrollTarget = null;
    const metrics = scrollbar();
    const maximumThumbTop = Math.max(0, scrollbarTrackElement.clientHeight - metrics.thumbHeight);
    scrollElement.scrollTop =
      maximumThumbTop === 0
        ? 0
        : (Math.min(maximumThumbTop, Math.max(0, thumbTop)) / maximumThumbTop) *
          metrics.maximumScroll;
    scheduleTimelineFrame(userInitiated, false);
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
    scheduleTimelineFrame(true, false);
  }

  function scrollTimelineBy(delta: number): void {
    if (scrollElement === undefined) {
      return;
    }
    markUserScrollIntent();
    scrollElement.scrollBy({ top: delta });
    scheduleTimelineFrame(true, false);
  }

  createEffect(() => {
    const threadId = props.controller.currentThread()?.id ?? null;
    const persistedTurns = props.controller.persistedTurns();
    if (activeTimelineThreadId !== threadId) {
      activateTimelineThread(threadId, persistedTurns);
      return;
    }
    if (threadId !== null && timelineSessions.activate(threadId, persistedTurns).keysChanged) {
      setVirtualRevision((revision) => revision + 1);
      scheduleTimelineFrame(false, false);
    }
  });

  onMount(() => {
    if (scrollElement === undefined || contentElement === undefined) {
      return;
    }
    const handleScroll = () =>
      scheduleTimelineFrame(
        !consumeSmoothScroll() &&
          hasRecentTimelineUserScrollIntent(lastUserScrollIntentAt, performance.now()),
        false,
      );
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
    saveActiveTimelineViewport();
    resizeObserver?.disconnect();
    if (animationFrame !== undefined) {
      cancelAnimationFrame(animationFrame);
    }
    if (historyRevealFrame !== undefined) {
      cancelAnimationFrame(historyRevealFrame);
    }
    if (timelineRestorationFrame !== undefined) {
      cancelAnimationFrame(timelineRestorationFrame);
    }
    if (virtualMeasurementFrame !== undefined) {
      cancelAnimationFrame(virtualMeasurementFrame);
    }
    pendingVirtualMeasurements.clear();
  });

  createEffect(() => {
    props.controller.turns();
    const threadId = props.controller.currentThread()?.id ?? null;
    const activeTurnId = props.controller.activeTurnId();
    const turnStarted =
      observedThreadId === threadId &&
      activeTurnId !== null &&
      observedActiveTurnId !== activeTurnId;
    observedThreadId = threadId;
    observedActiveTurnId = activeTurnId;
    if (turnStarted) {
      setActiveTimelineFollowing(true);
    }
    synchronizeScroll();
  });

  return (
    <FrontendFailureContext.Provider value={reportFrontendFailure}>
      <TimelineDisclosureContext.Provider value={disclosureContext}>
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
            onFocusIn={handleTimelineFocusIn}
            onKeyDown={handleTimelineKeyDown}
            onPointerDown={handleTimelinePointerDown}
            onWheel={handleTimelineWheel}
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
                      <For each={virtualTurnIds()}>
                        {(turnId, relativeIndex) => (
                          <VirtualConversationTurn
                            clock={clock()}
                            diffDisplay={props.controller.config()?.config.desktop.diffDisplay}
                            isItemStreaming={props.controller.isItemStreaming}
                            measurementKey={virtualTurnKey(turnId)}
                            onMeasure={measureVirtualTurn}
                            top={virtualOffset(virtualRange().start + relativeIndex())}
                            turn={() => readVirtualTurn(virtualTurnsById(), turnId)}
                            turnId={turnId}
                          />
                        )}
                      </For>
                    </div>
                  </Show>
                )}
              </Show>
            </div>
          </section>
          <div
            aria-hidden={!scrollbar().scrollable}
            class="surface-scrollbar"
            classList={{ "is-hidden": !scrollbar().scrollable }}
          >
            <button
              aria-controls="conversation-timeline"
              aria-label="Rolar conversa para cima"
              class="surface-scrollbar-arrow up"
              disabled={!scrollbar().scrollable || scrollbar().thumbTop <= 0.5}
              onClick={() => scrollTimelineBy(-64)}
              title="Rolar para cima"
              type="button"
            >
              <span aria-hidden="true" class="surface-scrollbar-arrow-glyph" />
            </button>
            <div
              aria-controls="conversation-timeline"
              aria-label="Posição na conversa"
              aria-orientation="vertical"
              aria-valuemax={Math.round(scrollbar().maximumScroll)}
              aria-valuemin={0}
              aria-valuenow={Math.round(scrollElement?.scrollTop ?? 0)}
              class="surface-scrollbar-track"
              onKeyDown={handleScrollbarKeyDown}
              onPointerDown={handleScrollbarTrackPointerDown}
              ref={scrollbarTrackElement}
              role="scrollbar"
              tabIndex={scrollbar().scrollable ? 0 : -1}
            >
              <div
                class="surface-scrollbar-thumb"
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
              class="surface-scrollbar-arrow down"
              disabled={
                !scrollbar().scrollable ||
                scrollbar().thumbTop + scrollbar().thumbHeight >=
                  (scrollbarTrackElement?.clientHeight ?? 0) - 0.5
              }
              onClick={() => scrollTimelineBy(64)}
              title="Rolar para baixo"
              type="button"
            >
              <span aria-hidden="true" class="surface-scrollbar-arrow-glyph" />
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
    </FrontendFailureContext.Provider>
  );
}

function VirtualConversationTurn(props: {
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
  let measurementFrame: number | undefined;
  const reportFailure = useFrontendFailureReporter();
  const turn = createMemo(props.turn);

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
    if (element !== undefined) {
      releaseResizeObservation = observeElementResize(element, scheduleMeasurement);
      scheduleMeasurement();
    }
  });
  createEffect(() => {
    props.measurementKey;
    scheduleMeasurement();
  });
  onCleanup(() => {
    releaseResizeObservation?.();
    if (measurementFrame !== undefined) {
      cancelAnimationFrame(measurementFrame);
    }
  });

  return (
    <div class="timeline-virtual-item" ref={element} style={{ top: `${Math.round(props.top)}px` }}>
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

function ConversationTurn(props: {
  readonly clock: number;
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly isItemStreaming: (itemId: string) => boolean;
  readonly turn: VisibleThreadTurn;
}) {
  const disclosure = useTimelineDisclosure(
    () => `turn:${props.turn.id}`,
    () => props.turn.status === "inProgress",
  );
  const failure = () => (props.turn.error === null ? null : presentTurnFailure(props.turn.error));
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
    return block?.kind === "work" && block.items.some((item) => item.type !== "reasoning");
  });
  const latestReasoningHeading = createMemo(() => {
    const items = props.turn.items;
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
    return turnDurationLabel(props.turn.status, duration);
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
              readTimelineValue(presentationBlocksByKey(), blockKey, "bloco projetado do turno")
            }
            blockIndex={index()}
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
            diffDisplay={props.diffDisplay}
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

function TurnPresentationBlockView(props: {
  readonly activeThinkingPresentation: "activity" | "none" | "standalone";
  readonly block: () => TurnPresentationBlock;
  readonly blockIndex: number;
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
                  diffDisplay={props.diffDisplay}
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

function TurnHeader(props: {
  readonly disclosure: TimelineDisclosureBinding;
  readonly label: string;
  readonly status: VisibleThreadTurn["status"];
}) {
  return (
    <div class="turn-header-wrapper">
      <Show
        when={props.status === "inProgress"}
        fallback={
          <button
            aria-expanded={props.disclosure.isOpen()}
            aria-label={`${props.disclosure.isOpen() ? "Ocultar" : "Mostrar"} trabalho do agente`}
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

function TurnWorkBlock(props: {
  readonly activeThinkingPresentation: "activity" | "none" | "standalone";
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly items: readonly TurnWorkItem[];
  readonly reasoningHeading: string | null;
}) {
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
              diffDisplay={props.diffDisplay}
              isCurrent={
                index() === workUnits().length - 1 &&
                props.activeThinkingPresentation === "activity"
              }
              reasoningHeading={props.reasoningHeading}
              unit={() =>
                readTimelineValue(
                  workUnitsByIdentity(),
                  unitIdentity,
                  "unidade de atividade do agente",
                )
              }
            />
          )}
        </For>
        <Show
          when={
            props.activeThinkingPresentation === "standalone"
              ? (props.reasoningHeading ?? "Pensando")
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

function WorkTimelineUnit(props: {
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly isCurrent: boolean;
  readonly reasoningHeading: string | null;
  readonly unit: () => AgentActivityRenderUnit;
}) {
  const unit = createMemo(props.unit);

  return (
    <Switch>
      <Match when={asAgentActivityGroup(unit())}>
        {(group) => (
          <AgentActivityGroup
            diffDisplay={props.diffDisplay}
            disclosureKey={group().key}
            isCurrent={props.isCurrent}
            items={group().items}
            reasoningHeading={props.reasoningHeading}
          />
        )}
      </Match>
      <Match when={asAgentActivityItem(unit())}>
        {(itemUnit) => (
          <TimelineItem
            active={props.isCurrent}
            diffDisplay={props.diffDisplay}
            item={itemUnit().item}
          />
        )}
      </Match>
    </Switch>
  );
}

function asAgentActivityGroup(
  unit: AgentActivityRenderUnit,
): Extract<AgentActivityRenderUnit, { readonly kind: "activityGroup" }> | null {
  return unit.kind === "activityGroup" ? unit : null;
}

function asAgentActivityItem(
  unit: AgentActivityRenderUnit,
): Extract<AgentActivityRenderUnit, { readonly kind: "item" }> | null {
  return unit.kind === "item" ? unit : null;
}

function AgentActivityGroup(props: {
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly disclosureKey: string;
  readonly isCurrent: boolean;
  readonly items: readonly AgentActivityItem[];
  readonly reasoningHeading: string | null;
}) {
  const disclosure = useTimelineDisclosure(() => props.disclosureKey);
  const itemIdentities = createMemo(() => props.items.map(timelineItemIdentity));
  const itemsByIdentity = createMemo(() =>
    indexTimelineValues(props.items, timelineItemIdentity, "itens do grupo de atividade"),
  );
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
        onToggle={(event) => handleTimelineDetailsToggle(event, disclosure)}
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
          <TimelineDisclosureContext.Provider value={disclosure.descendantContext}>
            <div class="agent-activity-viewport">
              <div class="agent-activity-list">
                <For each={itemIdentities()}>
                  {(itemIdentity) => (
                    <TimelineItem
                      diffDisplay={props.diffDisplay}
                      item={readTimelineValue(
                        itemsByIdentity(),
                        itemIdentity,
                        "item do grupo de atividade",
                      )}
                      variant="grouped"
                    />
                  )}
                </For>
              </div>
            </div>
          </TimelineDisclosureContext.Provider>
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
              <button onClick={() => props.onSelectSuggestion(suggestion.prompt)} type="button">
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

interface TimelineItemProps {
  readonly active?: boolean | undefined;
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly item: VisibleThreadItem;
  readonly streaming?: boolean | undefined;
  readonly variant?: "default" | "grouped" | undefined;
}

function TimelineItem(props: TimelineItemProps) {
  return (
    <Show keyed when={timelineItemRenderIdentity(props.item)}>
      {(_identity) => (
        <TimelineItemContent
          active={props.active}
          diffDisplay={props.diffDisplay}
          item={props.item}
          streaming={props.streaming}
          variant={props.variant}
        />
      )}
    </Show>
  );
}

function TimelineItemContent(props: TimelineItemProps) {
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
      {props.text}
    </span>
  );
}

function CommandItem(props: {
  readonly item: Extract<ThreadItem, { type: "commandExecution" }>;
  readonly variant?: "default" | "grouped" | undefined;
}) {
  const disclosure = useTimelineDisclosure(() => `command:${props.item.id}`);
  const title = () =>
    commandActivityTitle(
      props.item.command,
      props.item.status,
      props.variant === "grouped" ? false : disclosure.isOpen(),
    );
  const output = () => props.item.aggregatedOutput;

  return (
    <details
      class="activity-card command-activity-card"
      classList={{ "grouped-activity-item": props.variant === "grouped" }}
      onToggle={(event) => handleTimelineDetailsToggle(event, disclosure)}
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
              {(visibleOutput) => (
                <ThreadOutputView format={commandOutputText} output={visibleOutput()} />
              )}
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
  const disclosure = useTimelineDisclosure(() => `tool:${props.item.id}`);
  const description = () => props.item.description || toolLabel(props.item.name);
  const isWebSearch = () => props.item.name === "web_search" || props.item.name === "web_fetch";
  const output = () => props.item.output;
  const hasDetails = () =>
    output() !== null || props.item.status === "failed" || props.item.status === "declined";
  const title = () =>
    isWebSearch()
      ? webSearchActivityTitle(description(), props.item.status)
      : toolActivityTitle(description(), props.item.status, disclosure.isOpen());

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
        classList={{ "grouped-activity-item": props.variant === "grouped" }}
        onToggle={(event) => handleTimelineDetailsToggle(event, disclosure)}
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
            <div class="command-card-header">{toolLabel(props.item.name)}</div>
            <Show when={output()}>
              {(visibleOutput) => (
                <div class="command-card-scroll">
                  <ThreadOutputView format={toolOutputText} output={visibleOutput()} />
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
  const disclosure = useTimelineDisclosure(() => `file-change:${props.item.id}`);
  const title = () => fileChangeActivityTitle(props.item.changes);
  const changeEntries = createMemo(() => createTimelineFileChangeEntries(props.item.changes));
  const changeIdentities = createMemo(() => changeEntries().map((entry) => entry.identity));
  const changesByIdentity = createMemo(
    () => new Map(changeEntries().map((entry) => [entry.identity, entry.change] as const)),
  );

  return (
    <Show
      when={props.variant === "grouped" && props.item.changes.length === 1}
      fallback={
        <details
          class="activity-card file-change-card"
          classList={{ "grouped-activity-item": props.variant === "grouped" }}
          onToggle={(event) => handleTimelineDetailsToggle(event, disclosure)}
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
            <TimelineDisclosureContext.Provider value={disclosure.descendantContext}>
              <div class="file-change-list">
                <For each={changeIdentities()}>
                  {(changeIdentity) => (
                    <Change
                      change={readTimelineValue(
                        changesByIdentity(),
                        changeIdentity,
                        "alteração de arquivo",
                      )}
                      diffDisplay={props.diffDisplay}
                      disclosureKey={`change:${props.item.id}:${changeIdentity}`}
                      variant={props.variant}
                    />
                  )}
                </For>
              </div>
            </TimelineDisclosureContext.Provider>
          </Show>
        </details>
      }
    >
      <Change
        change={props.item.changes[0] as FileChange}
        diffDisplay={props.diffDisplay}
        disclosureKey={`change:${props.item.id}:${timelineFileChangeIdentity(
          props.item.changes[0] as FileChange,
          0,
        )}`}
        variant="grouped"
      />
    </Show>
  );
}

function Change(props: {
  readonly change: FileChange;
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly disclosureKey: string;
  readonly variant?: "default" | "grouped" | undefined;
}) {
  const disclosure = useTimelineDisclosure(() => props.disclosureKey);
  const diff = createMemo(() => props.change.diff);
  const kind = createMemo(() => props.change.kind.type);
  const path = createMemo(() => props.change.path);
  const stats = createMemo(() => summarizeDiff(diff()));

  return (
    <details
      class="diff-block"
      classList={{ "grouped-diff-block": props.variant === "grouped" }}
      data-kind={kind()}
      onToggle={(event) => handleTimelineDetailsToggle(event, disclosure)}
      open={disclosure.isOpen()}
    >
      <summary data-timeline-disclosure="">
        <Show when={props.variant === "grouped"}>
          <span class="activity-icon">
            <Icon name="edit" size={13} />
          </span>
          <span class="grouped-change-action">{groupedChangeAction(kind())}</span>
        </Show>
        <span class="diff-file-identity">
          <code title={path()}>{fileName(path())}</code>
          <Show when={props.variant !== "grouped" && kind() !== "update"}>
            <span class={`change-kind kind-${kind()}`}>
              {kind() === "add" ? "NOVO" : "EXCLUÍDO"}
            </span>
          </Show>
        </span>
        <span class="diff-stat additions" title={`${stats().additions} linhas adicionadas`}>
          +{stats().additions}
        </span>
        <span class="diff-stat deletions" title={`${stats().deletions} linhas removidas`}>
          −{stats().deletions}
        </span>
        <span aria-hidden="true" class="diff-file-chevron">
          <Icon name={disclosure.isOpen() ? "chevronDown" : "chevronRight"} size={12} />
        </span>
      </summary>
      <Show when={disclosure.isOpen()}>
        <Show
          when={diff().trim().length > 0}
          fallback={<div class="diff-empty-state">Nenhuma diferença textual disponível.</div>}
        >
          <ExpandedChangeDiff diff={diff()} mode={props.diffDisplay ?? "unified"} path={path()} />
        </Show>
      </Show>
    </details>
  );
}

function ExpandedChangeDiff(props: {
  readonly diff: string;
  readonly mode: "split" | "unified";
  readonly path: string;
}) {
  const document = createMemo(() => createDiffDocument(props.diff));
  return <DiffView document={document()} mode={props.mode} path={props.path} />;
}

function groupedChangeAction(kind: FileChange["kind"]["type"]): string {
  switch (kind) {
    case "add":
      return "Criado";
    case "delete":
      return "Excluído";
    case "update":
      return "Edição";
  }
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

function sameScrollbarMetrics(left: ScrollbarMetrics, right: ScrollbarMetrics): boolean {
  return (
    left.maximumScroll === right.maximumScroll &&
    left.scrollable === right.scrollable &&
    left.thumbHeight === right.thumbHeight &&
    left.thumbTop === right.thumbTop
  );
}

function createTimelineFileChangeEntries(
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

function indexTimelineValues<T>(
  values: readonly T[],
  identity: (value: T) => string,
  description: string,
): ReadonlyMap<string, T> {
  const indexed = new Map<string, T>();
  for (const value of values) {
    const key = identity(value);
    if (indexed.has(key)) {
      throw new Error(`${description} contêm a identidade duplicada ${JSON.stringify(key)}.`);
    }
    indexed.set(key, value);
  }
  return indexed;
}

function readTimelineValue<T>(
  values: ReadonlyMap<string, T>,
  identity: string,
  description: string,
): T {
  const value = values.get(identity);
  if (value === undefined) {
    throw new Error(`${description} ${JSON.stringify(identity)} não está disponível.`);
  }
  return value;
}

function readVirtualTurn(
  turnsById: ReadonlyMap<string, VisibleThreadTurn>,
  turnId: string,
): VisibleThreadTurn {
  const turn = turnsById.get(turnId);
  if (turn === undefined) {
    throw new Error(`O turno virtual ${turnId} não está disponível na janela atual.`);
  }
  return turn;
}
