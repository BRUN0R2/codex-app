import {
  batch,
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
  untrack,
} from "solid-js";

import { useI18n } from "../i18n/context";
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

import type { VisibleThreadTurn } from "../state/visibleTurnSequence";
import { COLLAPSED_ACTIVITY_ITEM_ESTIMATE_PX } from "./activityListProjection";
import {
  ActivityVirtualizerStore,
  shouldDeferActivityContent,
  shouldMinimizeActivityOverscan,
} from "./activityVirtualization";
import {
  AgentActivityProjectionStore,
  type AgentActivityRenderUnit,
  agentActivityRenderUnitIdentity,
  canAgentActivityOwnHeadline,
} from "./agentActivityPresentation";
import {
  projectVirtualLogicalOffset,
  resolveBoundedVirtualViewport,
  virtualLogicalToPhysicalOffset,
} from "./boundedVirtualViewport";
import { presentAssistantText } from "./contentReferenceMarkers";
import { observeElementResize, readResizeObserverBorderBoxHeight } from "./elementResize";
import { FrontendFailureContext, useFrontendFailureReporter } from "./frontendFailure";
import { Icon } from "./Icon";
import { TimelineTurnRenderFailure } from "./RenderFailure";
import {
  resolveScrollbarPageScrollAmount,
  SCROLLBAR_ARROW_SCROLL_STEP_PX,
  sameScrollbarMetrics,
} from "./scrollCommands";
import {
  blockPreview,
  inlinePreview,
  userMessageAnchor,
  userMessageCopyText,
} from "./TimelineMessages";
import {
  TimelineActivityContext,
  type TimelineActivityContextValue,
  type TimelineActivityViewportSnapshot,
  type TimelineActivityVisualAnchor,
} from "./timelineActivityContext";
import { createTimelineDisclosureStore, type TimelineDisclosureKey } from "./timelineDisclosure";
import {
  type TimelineDisclosureBinding,
  TimelineDisclosureContext,
  type TimelineDisclosureContextValue,
  timelineDisclosureNamespacePrefix,
  useTimelineDisclosure,
} from "./timelineDisclosureContext";
import {
  ActivityHeadline,
  AgentActivityGroup,
  asAgentActivityGroup,
  asAgentActivityItem,
  asImageViewGroup,
  EmptyConversation,
  ImageViewGroup,
  readTimelineValue,
  readVirtualTurn,
  TimelineItem,
} from "./timelineItems";
import { TimelineLayoutMeasurement } from "./timelineLayoutMeasurement";
import {
  formatElapsedSeconds,
  reasoningTitle,
  thinkingPresentation,
  turnDurationLabel,
} from "./timelinePresentation";
import {
  calculateTimelineScrollbar,
  findTimelineAnchorIndex,
  isTimelineNearEnd,
  resolveTimelineAnchorCorrection,
  resolveTimelineFollowing,
  resolveTimelineMessageLogicalOffset,
  resolveTimelineRestorationTop,
  type ScrollbarMetrics,
  shouldHandleTimelineWheel,
  shouldMeasureTimelineScrollAsUserInitiated,
  shouldPreserveTimelineAnchor,
  shouldSynchronizeTimelineToEnd,
  TimelineProgrammaticScrollTracker,
} from "./timelineScroll";
import { TimelineThreadSessionStore, type TimelineViewportAnchor } from "./timelineSession";
import { controlledTimelineDisclosureKeys } from "./timelineShared";
import { presentTurnFailure } from "./turnFailure";
import {
  asTurnMessageBlock,
  asTurnWorkBlock,
  type TurnPresentationBlock,
  TurnPresentationStore,
  type TurnWorkItem,
} from "./turnPresentation";
import { type UserMessageEntry, UserMessageNavigator } from "./UserMessageNavigator";
import { VariableSizeVirtualizer, type VirtualRange } from "./variableSizeVirtualizer";
import { findViewportVisualAnchorIndex } from "./viewportAnchor";

const TIMELINE_ESTIMATED_TURN_HEIGHT = 498;
const TIMELINE_MINIMUM_VIRTUAL_OVERSCAN_PX = 900;
const TIMELINE_VIRTUAL_OVERSCAN_VIEWPORTS = 1.5;
const TIMELINE_HISTORY_LOAD_THRESHOLD_PX = 640;
const TIMELINE_SESSION_CACHE_CAPACITY: number = 16;
const ACTIVITY_SESSION_CACHE_CAPACITY = 256;
const USER_MESSAGE_NAVIGATION_QUIET_FRAMES: number = 8;
const USER_MESSAGE_SCROLL_INSET_PX: number = 32;
const USER_MESSAGE_NAVIGATOR_TITLE_PREVIEW_CHARACTERS: number = 180;
const USER_MESSAGE_NAVIGATOR_DETAIL_PREVIEW_CHARACTERS: number = 320;
const ACTIVE_MESSAGE_VIEWPORT_INSET_PX: number = 112;
const ACTIVITY_CONTENT_SETTLE_DELAY_MS = 90;
const TIMELINE_SCROLL_REGION_SELECTOR = "[data-timeline-scroll-region]";
const TIMELINE_WHEEL_LISTENER_OPTIONS = {
  capture: true,
  passive: false,
} as const satisfies AddEventListenerOptions;

interface TimelineUserMessageEntry extends UserMessageEntry {
  readonly turnIndex: number;
}

interface PendingUserMessageNavigation {
  targetScrollTop: number | null;
  quietFrames: number;
  unmountedFrames: number;
  readonly message: TimelineUserMessageEntry;
  readonly threadId: string;
}

interface CapturedTimelineViewportAnchor extends TimelineViewportAnchor {
  readonly contentOffset: number;
  readonly threadId: string;
}

interface PendingHistoryLayout {
  readonly firstTurnKey: string | null;
  readonly listOffset: number;
  readonly threadId: string;
}

interface TimelineLayoutSnapshot {
  readonly clientHeight: number;
  readonly listOffset: number;
  readonly scrollHeight: number;
  readonly trackHeight: number;
}

interface TimelineVirtualViewport {
  offset: number;
  scrollTop: number;
  size: number;
}

export function Timeline(props: {
  readonly bottomOcclusion: number;
  readonly controller: TimelineController;
  readonly onSelectSuggestion: (prompt: string) => void;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().timeline;
  let scrollElement: HTMLDivElement | undefined;
  let contentElement: HTMLDivElement | undefined;
  let virtualListElement: HTMLDivElement | undefined;
  let scrollbarTrackElement: HTMLDivElement | undefined;
  let scrollbarThumbElement: HTMLDivElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let animationFrame: number | undefined;
  let pendingExplicitUserScrollMeasurement = false;
  let pendingLayoutSynchronization = false;
  let pendingUnownedScrollMeasurement = false;
  let timelineRestorationFrame: number | undefined;
  let activityContentResumeTimer: number | undefined;
  let activityContentResumeDeadline = 0;
  let previousActivityScrollTop = 0;
  let userMessageNavigationFrame: number | undefined;
  let pendingUserMessageNavigation: PendingUserMessageNavigation | undefined;
  let pendingHistoryLayout: PendingHistoryLayout | undefined;
  let pendingVirtualAnchorCorrection: CapturedTimelineViewportAnchor | undefined;
  let pendingActivityVisualAnchor: TimelineActivityVisualAnchor | undefined;
  let timelineLayoutSnapshot: TimelineLayoutSnapshot | undefined;
  let virtualMeasurementGeneration = 0;
  let virtualMeasurementScheduledGeneration: number | undefined;
  let activeTimelineThreadId: string | null = null;
  let timelineTransitionRevision = 0;
  let timelineLayoutRevision = 0;
  let measuredTimelineLayoutRevision = 0;
  let observedActiveTurnId: string | null | undefined;
  let observedThreadId: string | null | undefined;
  let dragState:
    | { readonly pointerId: number; readonly startScrollTop: number; readonly startY: number }
    | undefined;
  const [followingLatest, setFollowingLatest] = createSignal(true);
  const [showScrollToEnd, setShowScrollToEnd] = createSignal(false);
  const [activeUserMessageIndex, setActiveUserMessageIndex] = createSignal(0);
  const [activityContentDeferred, setActivityContentDeferred] = createSignal(false);
  const [activityMinimalOverscan, setActivityMinimalOverscan] = createSignal(false);
  const [activityLayoutRevision, setActivityLayoutRevision] = createSignal(0);
  const [clock, setClock] = createSignal(Date.now());
  const [timelineLayoutWidth, setTimelineLayoutWidth] = createSignal(0);
  const timelineSessions = new TimelineThreadSessionStore(
    () => new VariableSizeVirtualizer(TIMELINE_ESTIMATED_TURN_HEIGHT),
    TIMELINE_SESSION_CACHE_CAPACITY,
  );
  const activitySessions = new ActivityVirtualizerStore(
    COLLAPSED_ACTIVITY_ITEM_ESTIMATE_PX,
    ACTIVITY_SESSION_CACHE_CAPACITY,
  );
  const programmaticScroll = new TimelineProgrammaticScrollTracker();
  let virtualizer = new VariableSizeVirtualizer(TIMELINE_ESTIMATED_TURN_HEIGHT);
  const [virtualRevision, setVirtualRevision] = createSignal(0);
  const virtualViewportBufferA: TimelineVirtualViewport = { offset: 0, scrollTop: 0, size: 1 };
  const virtualViewportBufferB: TimelineVirtualViewport = { offset: 0, scrollTop: 0, size: 1 };
  const [virtualViewport, setVirtualViewportSignal] =
    createSignal<TimelineVirtualViewport>(virtualViewportBufferA);
  function commitVirtualViewport(offset: number, scrollTop: number, size: number): void {
    const current = untrack(virtualViewport);
    if (current.offset === offset && current.scrollTop === scrollTop && current.size === size) {
      return;
    }
    const next =
      current === virtualViewportBufferA ? virtualViewportBufferB : virtualViewportBufferA;
    next.offset = offset;
    next.scrollTop = scrollTop;
    next.size = size;
    setVirtualViewportSignal(next);
  }
  const [scrollbar, setScrollbar] = createSignal<ScrollbarMetrics>({
    maximumScroll: 0,
    scrollable: false,
    thumbHeight: 0,
    thumbTop: 0,
  });
  const disclosures = createTimelineDisclosureStore();
  const layoutMeasurement = new TimelineLayoutMeasurement(measureMountedVirtualTurns);
  const disclosureContext: TimelineDisclosureContextValue = {
    keyPrefix: () => timelineDisclosureNamespacePrefix(props.controller.currentThread()?.id ?? ""),
    onLayoutChange: () => {
      recordTimelineLayoutChange();
      layoutMeasurement.request();
    },
    store: disclosures,
  };
  const reportFrontendFailure = (reason: unknown) => props.controller.reportError(reason);
  const pendingVirtualMeasurements = new Map<string, number>();
  const timelineLayoutSignature = createMemo(() => {
    const width = timelineLayoutWidth();
    if (width <= 0) {
      return null;
    }
    const preferences = props.controller.config()?.config.desktop;
    return [width, preferences?.uiFontSize ?? 14, preferences?.diffDisplay ?? "unified"].join(":");
  });
  const virtualGeometry = createMemo(() => {
    virtualRevision();
    const viewport = virtualViewport();
    return resolveBoundedVirtualViewport({
      logicalTotalSize: virtualizer.totalSize(),
      physicalOffset: viewport.offset,
      viewportSize: viewport.size,
    });
  });
  const activityViewport = createMemo<TimelineActivityViewportSnapshot | null>((previous) => {
    virtualRevision();
    const viewport = virtualViewport();
    const scrollTop = viewport.scrollTop;
    const element = scrollElement;
    if (element === undefined) {
      return null;
    }
    const size = Math.max(1, viewport.size - props.bottomOcclusion);
    const geometry = virtualGeometry();
    const contentTranslation = Math.round(geometry.physicalOffset - geometry.logicalOffset);
    return previous !== null &&
      previous.element === element &&
      previous.scrollTop === scrollTop &&
      previous.contentTranslation === contentTranslation &&
      previous.size === size
      ? previous
      : { element, contentTranslation, scrollTop, size };
  }, null);
  const activityContext: TimelineActivityContextValue = {
    preserveVisualAnchor: (anchor) => {
      if (scrollElement === undefined || pendingActivityVisualAnchor !== undefined) {
        return;
      }
      pendingActivityVisualAnchor = anchor;
      scheduleTimelineFrame(false, true);
    },
    contentDeferred: activityContentDeferred,
    layoutRevision: activityLayoutRevision,
    layoutSignature: timelineLayoutSignature,
    minimalOverscan: activityMinimalOverscan,
    notifyLayoutChange: disclosureContext.onLayoutChange,
    sessions: activitySessions,
    shouldPreserveAnchor: () => !followingLatest() && !programmaticTimelineNavigationActive(),
    viewport: activityViewport,
  };
  const virtualRange = createMemo<VirtualRange>((previousRange) => {
    const viewport = virtualGeometry();
    const nextRange = virtualizer.range(
      viewport.logicalOffset,
      viewport.viewportSize,
      Math.max(
        TIMELINE_MINIMUM_VIRTUAL_OVERSCAN_PX,
        viewport.viewportSize * TIMELINE_VIRTUAL_OVERSCAN_VIEWPORTS,
      ),
    );
    return previousRange !== undefined &&
      previousRange.start === nextRange.start &&
      previousRange.end === nextRange.end
      ? previousRange
      : nextRange;
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
    return virtualGeometry().physicalTotalSize;
  });
  const userMessages = createMemo<readonly TimelineUserMessageEntry[]>((previous = []) => {
    const previousById = new Map(previous.map((message) => [message.id, message]));
    const result: TimelineUserMessageEntry[] = [];
    const turns = props.controller.turns();
    for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
      const turn = turns.at(turnIndex);
      if (turn === undefined) continue;
      const response = turn.items.findLast((item) => item.type === "agentMessage");
      const detail =
        response?.type === "agentMessage"
          ? blockPreview(
              presentAssistantText(response.text),
              USER_MESSAGE_NAVIGATOR_DETAIL_PREVIEW_CHARACTERS,
            )
          : null;
      for (const item of turn.items) {
        if (item.type !== "userMessage") continue;
        const title = inlinePreview(
          userMessageCopyText(item.content, messages()),
          USER_MESSAGE_NAVIGATOR_TITLE_PREVIEW_CHARACTERS,
          messages().textlessMessage,
        );
        const previousEntry = previousById.get(item.id);
        result.push(
          previousEntry?.title === title &&
            previousEntry.detail === detail &&
            previousEntry.turnIndex === turnIndex
            ? previousEntry
            : {
                id: item.id,
                title,
                detail,
                label: detail === null ? title : `${title}. ${detail.replace(/\s+/gu, " ")}`,
                turnIndex,
              },
        );
      }
    }
    return result.length === previous.length &&
      result.every((entry, index) => entry === previous[index])
      ? previous
      : result;
  });

  function readMountedUserMessageOffset(
    messageId: string,
    virtualListTop: number | null = null,
  ): number | null {
    if (virtualListElement === undefined) {
      return null;
    }
    const anchor = document.getElementById(userMessageAnchor(messageId));
    if (!(anchor instanceof HTMLElement) || !virtualListElement.contains(anchor)) {
      return null;
    }
    return (
      anchor.getBoundingClientRect().top -
      (virtualListTop ?? virtualListElement.getBoundingClientRect().top)
    );
  }

  function recordTimelineLayoutChange(): void {
    timelineLayoutRevision += 1;
    setActivityLayoutRevision(timelineLayoutRevision);
    if (pendingUserMessageNavigation !== undefined) {
      scheduleUserMessageNavigation();
    }
  }

  function readUserMessageLogicalOffset(
    message: TimelineUserMessageEntry,
    virtualListTop: number | null = null,
  ): number {
    return resolveTimelineMessageLogicalOffset(
      readMountedUserMessageOffset(message.id, virtualListTop),
      virtualizer.offsetOf(message.turnIndex),
      virtualGeometry(),
    );
  }

  function captureTimelineViewportAnchor(
    threadId = activeTimelineThreadId ?? props.controller.currentThread()?.id ?? null,
    listOffsetOverride: number | null = null,
    excludedAnchorKeys: readonly string[] = [],
  ): CapturedTimelineViewportAnchor | null {
    if (threadId === null || scrollElement === undefined || virtualListElement === undefined) {
      return null;
    }
    const viewportBounds = scrollElement.getBoundingClientRect();
    const mountedTurns = [
      ...virtualListElement.querySelectorAll<HTMLElement>(
        ":scope > .timeline-virtual-item[data-virtual-turn-id]",
      ),
    ].map((element) => {
      const turnId = element.getAttribute("data-virtual-turn-id");
      return {
        bounds: element.getBoundingClientRect(),
        element,
        key: turnId === null ? null : `${threadId}\u0000${turnId}`,
      };
    });
    const mountedAnchorIndex = findViewportVisualAnchorIndex({
      isAnchorCandidate: (index) => {
        const key = mountedTurns[index]?.key ?? null;
        return key !== null && !excludedAnchorKeys.includes(key);
      },
      itemCount: mountedTurns.length,
      readItemBounds: (index) => mountedTurns[index]?.bounds ?? { bottom: 0, top: 0 },
      viewportBottom: viewportBounds.bottom,
      viewportTop: viewportBounds.top,
    });
    const mountedAnchor =
      mountedAnchorIndex === null ? undefined : mountedTurns[mountedAnchorIndex];
    const mountedAnchorKey = mountedAnchor?.key ?? null;
    if (mountedAnchor !== undefined && mountedAnchorKey !== null) {
      const key = mountedAnchorKey;
      const virtualIndex = virtualizer.indexOf(key);
      if (virtualIndex !== null) {
        const startsInsideViewport = mountedAnchor.bounds.top >= viewportBounds.top;
        const viewportOffset = startsInsideViewport
          ? mountedAnchor.bounds.top - viewportBounds.top
          : 0;
        return {
          anchor: {
            key,
            offsetWithinItem: startsInsideViewport
              ? 0
              : Math.min(
                  virtualizer.sizeOf(virtualIndex),
                  viewportBounds.top - mountedAnchor.bounds.top,
                ),
          },
          contentOffset: scrollElement.scrollTop + viewportOffset,
          threadId,
          viewportOffset,
        };
      }
    }
    const listOffset = listOffsetOverride ?? virtualListElement.offsetTop;
    const viewport = resolveBoundedVirtualViewport({
      logicalTotalSize: virtualizer.totalSize(),
      physicalOffset: Math.max(0, scrollElement.scrollTop - listOffset),
      viewportSize: Math.max(1, scrollElement.clientHeight),
    });
    const anchor = virtualizer.anchorAt(viewport.logicalOffset);
    const anchorOffset = anchor === null ? null : virtualizer.resolveAnchorOffset(anchor);
    if (anchor === null || anchorOffset === null) {
      return null;
    }
    const contentOffset = listOffset + projectVirtualLogicalOffset(viewport, anchorOffset);
    return {
      anchor,
      contentOffset,
      threadId,
      viewportOffset: contentOffset - scrollElement.scrollTop,
    };
  }

  function resolveCapturedTimelineAnchorOffset(captured: TimelineViewportAnchor): number | null {
    if (virtualListElement === undefined) {
      return null;
    }
    const virtualOffset = virtualizer.resolveAnchorOffset(captured.anchor);
    return virtualOffset === null
      ? null
      : virtualListElement.offsetTop +
          projectVirtualLogicalOffset(virtualGeometry(), virtualOffset);
  }

  function readActiveUserMessageIndex(input: {
    readonly clientHeight: number;
    readonly listOffset: number;
    readonly scrollHeight: number;
    readonly scrollTop: number;
  }): number {
    const messages = userMessages();
    const list = virtualListElement;
    if (messages.length <= 1 || list === undefined) {
      return 0;
    }
    if (
      isTimelineNearEnd({
        clientHeight: input.clientHeight,
        scrollHeight: input.scrollHeight,
        scrollTop: input.scrollTop,
      })
    ) {
      return messages.length - 1;
    }
    const physicalOffset = Math.max(0, input.scrollTop - input.listOffset);
    const viewport = resolveBoundedVirtualViewport({
      logicalTotalSize: virtualizer.totalSize(),
      physicalOffset,
      viewportSize: input.clientHeight,
    });
    const viewportTop =
      viewport.logicalOffset +
      physicalOffset -
      viewport.physicalOffset +
      ACTIVE_MESSAGE_VIEWPORT_INSET_PX;
    const listTop = list.getBoundingClientRect().top;
    return findTimelineAnchorIndex(
      messages.length,
      (index) => {
        const message = messages[index];
        return message === undefined
          ? Number.MAX_SAFE_INTEGER
          : readUserMessageLogicalOffset(message, listTop);
      },
      viewportTop,
    );
  }

  async function revealOlderTurns(): Promise<void> {
    const threadId = props.controller.currentThread()?.id ?? null;
    if (
      threadId === null ||
      virtualListElement === undefined ||
      !props.controller.hasOlderHistory() ||
      props.controller.historyLoading()
    ) {
      return;
    }
    setActiveTimelineFollowing(false);
    const firstTurn = props.controller.persistedTurns()[0];
    const pendingLayout = {
      firstTurnKey: firstTurn === undefined ? null : virtualTurnKey(firstTurn.id),
      listOffset: virtualListElement.offsetTop,
      threadId,
    } satisfies PendingHistoryLayout;
    pendingHistoryLayout = pendingLayout;
    const loaded = await props.controller.loadOlderHistory();
    if (!loaded && pendingHistoryLayout === pendingLayout) {
      pendingHistoryLayout = undefined;
      return;
    }
    requestAnimationFrame(() => {
      if (pendingHistoryLayout === pendingLayout) {
        pendingHistoryLayout = undefined;
      }
    });
  }

  function scrollTimelineTo(
    top: number,
    behavior: ScrollBehavior = "auto",
    synchronizedLayout?: TimelineLayoutSnapshot | undefined,
  ): void {
    if (scrollElement === undefined) {
      return;
    }
    const maximumScroll = Math.max(
      0,
      synchronizedLayout === undefined
        ? scrollElement.scrollHeight - scrollElement.clientHeight
        : synchronizedLayout.scrollHeight - synchronizedLayout.clientHeight,
    );
    const target = Math.min(maximumScroll, Math.max(0, top));
    if (Math.abs(scrollElement.scrollTop - target) <= 1) {
      programmaticScroll.cancel();
      return;
    }
    if (behavior === "auto") {
      programmaticScroll.begin("instant", target);
      scrollElement.scrollTop = target;
      return;
    }
    programmaticScroll.begin("smooth", target);
    scrollElement.scrollTo({ behavior, top: target });
  }

  function saveActiveTimelineViewport(nextFollowingLatest = followingLatest()): void {
    if (activeTimelineThreadId === null || scrollElement === undefined) {
      return;
    }
    const capturedAnchor = captureTimelineViewportAnchor(activeTimelineThreadId);
    timelineSessions.save(activeTimelineThreadId, {
      anchor:
        capturedAnchor === null
          ? null
          : {
              anchor: capturedAnchor.anchor,
              viewportOffset: capturedAnchor.viewportOffset,
            },
      followingLatest: nextFollowingLatest,
      scrollTop: Math.max(0, scrollElement.scrollTop),
    });
  }

  function setActiveTimelineFollowing(nextFollowingLatest: boolean): void {
    if (followingLatest() !== nextFollowingLatest) {
      setFollowingLatest(nextFollowingLatest);
    }
  }

  function cancelActivityContentDeferral(): void {
    if (activityContentResumeTimer !== undefined) {
      window.clearTimeout(activityContentResumeTimer);
      activityContentResumeTimer = undefined;
    }
    activityContentResumeDeadline = 0;
    batch(() => {
      setActivityContentDeferred(false);
      setActivityMinimalOverscan(false);
    });
  }

  function resumeActivityContentAfterSettle(): void {
    activityContentResumeTimer = undefined;
    const remainingDelay = activityContentResumeDeadline - performance.now();
    if (remainingDelay > 0) {
      activityContentResumeTimer = window.setTimeout(
        resumeActivityContentAfterSettle,
        Math.ceil(remainingDelay),
      );
      return;
    }
    activityContentResumeDeadline = 0;
    batch(() => {
      setActivityContentDeferred(false);
      setActivityMinimalOverscan(false);
    });
  }

  function scheduleActivityContentResume(): void {
    activityContentResumeDeadline = performance.now() + ACTIVITY_CONTENT_SETTLE_DELAY_MS;
    if (activityContentResumeTimer === undefined) {
      activityContentResumeTimer = window.setTimeout(
        resumeActivityContentAfterSettle,
        ACTIVITY_CONTENT_SETTLE_DELAY_MS,
      );
    }
  }

  function updateActivityContentDeferral(scrollTop: number, viewportSize: number): void {
    const scrollDelta = scrollTop - previousActivityScrollTop;
    previousActivityScrollTop = scrollTop;
    if (programmaticTimelineNavigationActive() && dragState === undefined) {
      cancelActivityContentDeferral();
      return;
    }
    const largeJump = shouldDeferActivityContent(scrollDelta, viewportSize);
    if (shouldMinimizeActivityOverscan(scrollDelta, viewportSize)) {
      setActivityMinimalOverscan(true);
    }
    if (!largeJump && !activityContentDeferred()) {
      return;
    }
    if (largeJump) {
      setActivityContentDeferred(true);
    }
    scheduleActivityContentResume();
  }

  function cancelUserMessageNavigationFrame(): void {
    if (userMessageNavigationFrame !== undefined) {
      cancelAnimationFrame(userMessageNavigationFrame);
      userMessageNavigationFrame = undefined;
    }
  }

  function cancelPendingUserMessageNavigation(): void {
    cancelUserMessageNavigationFrame();
    pendingUserMessageNavigation = undefined;
  }

  function cancelPendingTimelineWork(): number {
    layoutMeasurement.cancel();
    timelineTransitionRevision += 1;
    cancelPendingUserMessageNavigation();
    if (animationFrame !== undefined) {
      cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
    }
    if (timelineRestorationFrame !== undefined) {
      cancelAnimationFrame(timelineRestorationFrame);
      timelineRestorationFrame = undefined;
    }
    virtualMeasurementGeneration += 1;
    virtualMeasurementScheduledGeneration = undefined;
    pendingExplicitUserScrollMeasurement = false;
    pendingLayoutSynchronization = false;
    pendingUnownedScrollMeasurement = false;
    pendingVirtualMeasurements.clear();
    pendingActivityVisualAnchor = undefined;
    timelineLayoutSnapshot = undefined;
    pendingHistoryLayout = undefined;
    pendingVirtualAnchorCorrection = undefined;
    cancelActivityContentDeferral();
    programmaticScroll.cancel();
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
    layoutSignature: string | null,
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
      threadId === null
        ? null
        : timelineSessions.activate(threadId, persistedTurns, layoutSignature).session;
    virtualizer =
      session?.virtualizer ?? new VariableSizeVirtualizer(TIMELINE_ESTIMATED_TURN_HEIGHT);
    const following = session?.followingLatest ?? true;
    const savedScrollTop = session?.scrollTop ?? 0;
    previousActivityScrollTop = Math.max(0, scrollElement?.scrollTop ?? 0);
    const savedAnchor = session?.anchor ?? null;
    const savedAnchorOffset =
      savedAnchor === null ? null : virtualizer.resolveAnchorOffset(savedAnchor.anchor);
    const physicalTotalSize = resolveBoundedVirtualViewport({
      logicalTotalSize: virtualizer.totalSize(),
      physicalOffset: 0,
      viewportSize,
    }).physicalTotalSize;
    const anchoredVirtualOffset =
      savedAnchor === null || savedAnchorOffset === null
        ? null
        : virtualLogicalToPhysicalOffset(
            Math.max(0, savedAnchorOffset - savedAnchor.viewportOffset),
            virtualizer.totalSize(),
            viewportSize,
          );
    const initialVirtualOffset = resolveTimelineRestorationTop({
      followingLatest: following,
      maximumScroll: Math.max(0, physicalTotalSize - viewportSize),
      savedScrollTop: anchoredVirtualOffset ?? savedScrollTop,
    });
    setFollowingLatest(following);
    commitVirtualViewport(initialVirtualOffset, initialVirtualOffset, viewportSize);
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
      const anchoredScrollTop =
        session?.anchor === null || session?.anchor === undefined
          ? null
          : (() => {
              const contentOffset = resolveCapturedTimelineAnchorOffset(session.anchor);
              return contentOffset === null
                ? null
                : Math.max(0, contentOffset - session.anchor.viewportOffset);
            })();
      scrollTimelineTo(
        resolveTimelineRestorationTop({
          followingLatest: following,
          maximumScroll,
          savedScrollTop: anchoredScrollTop ?? savedScrollTop,
        }),
      );
      pendingExplicitUserScrollMeasurement = false;
      pendingLayoutSynchronization = false;
      pendingUnownedScrollMeasurement = false;
      measureScroll(false);
    });
  }

  function virtualOffset(index: number): number {
    return projectVirtualLogicalOffset(virtualGeometry(), virtualizer.offsetOf(index));
  }

  function virtualTurnKey(turnId: string): string {
    return `${props.controller.currentThread()?.id ?? ""}\u0000${turnId}`;
  }

  function programmaticTimelineNavigationActive(): boolean {
    return (
      timelineRestorationFrame !== undefined ||
      programmaticScroll.smoothActive() ||
      pendingUserMessageNavigation !== undefined
    );
  }

  function commitVirtualizerChange(anchor: CapturedTimelineViewportAnchor | null): void {
    const programmaticNavigationActive = programmaticTimelineNavigationActive();
    const preserveAnchor =
      anchor !== null &&
      !followingLatest() &&
      !programmaticNavigationActive &&
      virtualizer.resolveAnchorOffset(anchor.anchor) !== null;
    if (preserveAnchor) {
      pendingVirtualAnchorCorrection ??= anchor;
      const nextAnchorOffset = virtualizer.resolveAnchorOffset(anchor.anchor);
      if (nextAnchorOffset !== null) {
        const viewport = virtualViewport();
        commitVirtualViewport(
          virtualLogicalToPhysicalOffset(
            Math.max(0, nextAnchorOffset - anchor.viewportOffset),
            virtualizer.totalSize(),
            viewport.size,
          ),
          viewport.scrollTop,
          viewport.size,
        );
      }
    } else if (followingLatest()) {
      const viewport = virtualViewport();
      const physicalTotalSize = resolveBoundedVirtualViewport({
        logicalTotalSize: virtualizer.totalSize(),
        physicalOffset: 0,
        viewportSize: viewport.size,
      }).physicalTotalSize;
      commitVirtualViewport(
        Math.max(0, physicalTotalSize - viewport.size),
        viewport.scrollTop,
        viewport.size,
      );
    }
    setVirtualRevision((revision) => revision + 1);
    synchronizeScroll();
  }

  function applyPendingVirtualAnchorCorrection(): void {
    const pending = pendingVirtualAnchorCorrection;
    pendingVirtualAnchorCorrection = undefined;
    if (
      pending === undefined ||
      pending.threadId !== props.controller.currentThread()?.id ||
      scrollElement === undefined
    ) {
      return;
    }
    const nextAnchorOffset = resolveCapturedTimelineAnchorOffset(pending);
    if (nextAnchorOffset === null) {
      return;
    }
    const anchorDelta = nextAnchorOffset - pending.contentOffset;
    if (
      !shouldPreserveTimelineAnchor({
        anchorDelta,
        followingLatest: followingLatest(),
        programmaticNavigationActive: programmaticTimelineNavigationActive(),
      })
    ) {
      return;
    }
    const previousScrollTop = scrollElement.scrollTop;
    scrollTimelineTo(
      resolveTimelineAnchorCorrection({
        currentScrollTop: previousScrollTop,
        nextAnchorOffset,
        previousAnchorOffset: pending.contentOffset,
      }),
      "auto",
      timelineLayoutSnapshot,
    );
    if (dragState !== undefined) {
      dragState = {
        ...dragState,
        startScrollTop: dragState.startScrollTop + scrollElement.scrollTop - previousScrollTop,
      };
    }
  }

  function applyPendingActivityVisualAnchor(): void {
    const anchor = pendingActivityVisualAnchor;
    pendingActivityVisualAnchor = undefined;
    if (
      anchor === undefined ||
      scrollElement === undefined ||
      followingLatest() ||
      programmaticTimelineNavigationActive() ||
      Math.abs(scrollElement.scrollTop - anchor.scrollTop) > 0.5 ||
      !anchor.element.isConnected ||
      anchor.element.getAttribute("data-virtual-activity-key") !== anchor.key
    ) {
      return;
    }
    const viewportOffset =
      anchor.element.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top;
    const correction = viewportOffset - anchor.viewportOffset;
    if (!Number.isFinite(correction) || correction === 0) {
      return;
    }
    const previousScrollTop = scrollElement.scrollTop;
    scrollTimelineTo(previousScrollTop + correction, "auto", timelineLayoutSnapshot);
    if (dragState !== undefined) {
      dragState = {
        ...dragState,
        startScrollTop: dragState.startScrollTop + scrollElement.scrollTop - previousScrollTop,
      };
    }
  }

  function measureMountedVirtualTurns(): void {
    if (virtualListElement === undefined) {
      return;
    }
    for (const element of virtualListElement.querySelectorAll<HTMLElement>(
      ":scope > .timeline-virtual-item[data-virtual-turn-id]",
    )) {
      const turnId = element.getAttribute("data-virtual-turn-id");
      if (turnId !== null) {
        measureVirtualTurn(virtualTurnKey(turnId), element.getBoundingClientRect().height);
      }
    }
  }

  function measureVirtualTurn(key: string, size: number): void {
    pendingVirtualMeasurements.set(key, size);
    if (virtualMeasurementScheduledGeneration !== undefined) {
      return;
    }
    virtualMeasurementGeneration += 1;
    const generation = virtualMeasurementGeneration;
    virtualMeasurementScheduledGeneration = generation;
    queueMicrotask(() => {
      if (virtualMeasurementScheduledGeneration !== generation) {
        return;
      }
      virtualMeasurementScheduledGeneration = undefined;
      const measurements = [...pendingVirtualMeasurements].map(
        ([measurementKey, measuredSize]) => ({
          key: measurementKey,
          size: measuredSize,
        }),
      );
      pendingVirtualMeasurements.clear();
      const changedMeasurementKeys = measurements.flatMap((measurement) => {
        const index = virtualizer.indexOf(measurement.key);
        const nextSize = Math.max(1, Math.round(measurement.size));
        return index !== null && virtualizer.sizeOf(index) !== nextSize ? [measurement.key] : [];
      });
      if (changedMeasurementKeys.length === 0) {
        measuredTimelineLayoutRevision = timelineLayoutRevision;
        return;
      }
      const anchor = captureTimelineViewportAnchor(undefined, null, changedMeasurementKeys);
      const batch = virtualizer.measureBatch(measurements);
      if (!batch.changed) {
        measuredTimelineLayoutRevision = timelineLayoutRevision;
        return;
      }
      recordTimelineLayoutChange();
      measuredTimelineLayoutRevision = timelineLayoutRevision;
      commitVirtualizerChange(anchor);
    });
  }

  function readTimelineLayoutSnapshot(): TimelineLayoutSnapshot | null {
    if (scrollElement === undefined || virtualListElement === undefined) {
      return null;
    }
    const snapshot = {
      clientHeight: scrollElement.clientHeight,
      listOffset: virtualListElement.offsetTop,
      scrollHeight: scrollElement.scrollHeight,
      trackHeight: scrollbarTrackElement?.clientHeight ?? 0,
    } satisfies TimelineLayoutSnapshot;
    timelineLayoutSnapshot = snapshot;
    return snapshot;
  }

  function measureScroll(
    userInitiated: boolean,
    synchronizedLayout: TimelineLayoutSnapshot | null = null,
  ): void {
    if (scrollElement === undefined || virtualListElement === undefined) {
      return;
    }
    const layout = synchronizedLayout ?? timelineLayoutSnapshot ?? readTimelineLayoutSnapshot();
    if (layout === null) {
      return;
    }
    const { clientHeight, listOffset, scrollHeight, trackHeight } = layout;
    const scrollTop = scrollElement.scrollTop;
    const nextViewportOffset = Math.max(0, scrollTop - listOffset);
    const nextViewportScrollTop = Math.max(0, scrollTop);
    const nextViewportSize = Math.max(1, clientHeight);
    const nextScrollbar = calculateTimelineScrollbar({
      clientHeight,
      scrollHeight,
      scrollTop,
      trackHeight,
    });
    const isNearEnd = isTimelineNearEnd({
      clientHeight,
      scrollHeight,
      scrollTop,
    });
    const nextFollowingLatest = resolveTimelineFollowing({
      followingLatest: followingLatest(),
      nearEnd: isNearEnd,
      userInitiated,
    });
    const nextActiveUserMessageIndex = readActiveUserMessageIndex({
      clientHeight,
      listOffset,
      scrollHeight,
      scrollTop,
    });
    const currentScrollbar = untrack(scrollbar);
    batch(() => {
      updateActivityContentDeferral(scrollTop, clientHeight);
      if (!sameScrollbarMetrics(currentScrollbar, nextScrollbar)) {
        setScrollbar(nextScrollbar);
      }
      setShowScrollToEnd(!isNearEnd);
      setActiveTimelineFollowing(nextFollowingLatest);
      setActiveUserMessageIndex(nextActiveUserMessageIndex);
      commitVirtualViewport(nextViewportOffset, nextViewportScrollTop, nextViewportSize);
    });
    if (
      userInitiated &&
      scrollTop <= TIMELINE_HISTORY_LOAD_THRESHOLD_PX &&
      props.controller.hasOlderHistory() &&
      !props.controller.historyLoading()
    ) {
      void revealOlderTurns();
    }
  }

  function claimTimelineScrollOwnership(): void {
    cancelPendingUserMessageNavigation();
    if (timelineRestorationFrame !== undefined) {
      cancelAnimationFrame(timelineRestorationFrame);
      timelineRestorationFrame = undefined;
    }
    const programmaticSmoothActive = programmaticScroll.smoothActive();
    programmaticScroll.cancel();
    if (programmaticSmoothActive && scrollElement !== undefined) {
      scrollElement.scrollTo({ behavior: "auto", top: scrollElement.scrollTop });
    }
    pendingActivityVisualAnchor = undefined;
    pendingVirtualAnchorCorrection = undefined;
    setActiveTimelineFollowing(false);
  }

  function readNestedTimelineScrollRegion(target: EventTarget | null): HTMLElement | null {
    if (!(target instanceof Element) || scrollElement === undefined) {
      return null;
    }
    const region = target.closest<HTMLElement>(TIMELINE_SCROLL_REGION_SELECTOR);
    return region !== null && region !== scrollElement && scrollElement.contains(region)
      ? region
      : null;
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
        claimTimelineScrollOwnership();
        scheduleTimelineFrame(true, false);
        return;
    }
  }

  function handleTimelinePointerDown(event: PointerEvent): void {
    if (!event.isPrimary) {
      return;
    }
    if (event.pointerType === "touch" || (event.pointerType === "mouse" && event.button === 1)) {
      claimTimelineScrollOwnership();
      scheduleTimelineFrame(true, false);
    }
  }

  function handleTimelineWheel(event: WheelEvent): void {
    const nestedRegion = readNestedTimelineScrollRegion(event.target);
    if (
      !shouldHandleTimelineWheel({
        controlKey: event.ctrlKey,
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        insideNestedRegion: nestedRegion !== null,
        shiftKey: event.shiftKey,
      })
    ) {
      return;
    }
    claimTimelineScrollOwnership();
    scheduleTimelineFrame(true, false);
  }

  function handleTimelineClick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    const summary = target?.closest<HTMLElement>("[data-timeline-disclosure]");
    if (summary === null || summary === undefined) {
      return;
    }
    const details = summary.parentElement;
    const storageKey =
      controlledTimelineDisclosureKeys.get(summary)?.() ??
      summary.getAttribute("data-timeline-disclosure");
    if (
      !(details instanceof HTMLDetailsElement) ||
      storageKey === null ||
      storageKey.length === 0
    ) {
      return;
    }
    event.preventDefault();
    claimTimelineScrollOwnership();
    setActiveTimelineFollowing(false);
    disclosures.setOpen(storageKey as TimelineDisclosureKey, !details.open);
    disclosureContext.onLayoutChange();
  }

  function runScheduledTimelineFrame(): void {
    animationFrame = undefined;
    const shouldSynchronizeLayout = pendingLayoutSynchronization;
    const shouldMeasureAsUserScroll = shouldMeasureTimelineScrollAsUserInitiated({
      explicitUserInput: pendingExplicitUserScrollMeasurement,
      layoutRequested: shouldSynchronizeLayout,
      unownedScroll: pendingUnownedScrollMeasurement,
    });
    pendingExplicitUserScrollMeasurement = false;
    pendingLayoutSynchronization = false;
    pendingUnownedScrollMeasurement = false;
    if (scrollElement === undefined) {
      return;
    }
    const synchronizedLayout = shouldSynchronizeLayout ? readTimelineLayoutSnapshot() : null;
    applyPendingVirtualAnchorCorrection();
    applyPendingActivityVisualAnchor();
    if (shouldMeasureAsUserScroll) {
      measureScroll(true, synchronizedLayout);
    }
    if (
      shouldSynchronizeTimelineToEnd({
        followingLatest: followingLatest(),
        layoutRequested: shouldSynchronizeLayout,
      })
    ) {
      scrollTimelineTo(
        synchronizedLayout?.scrollHeight ?? scrollElement.scrollHeight,
        "auto",
        synchronizedLayout ?? undefined,
      );
      measureScroll(false, synchronizedLayout);
      return;
    }
    if (!shouldMeasureAsUserScroll) {
      measureScroll(false, synchronizedLayout);
    }
  }

  function scheduleTimelineFrame(userInitiated: boolean, synchronizeLayout: boolean): void {
    pendingExplicitUserScrollMeasurement ||= userInitiated;
    pendingLayoutSynchronization ||= synchronizeLayout;
    if (timelineRestorationFrame !== undefined || animationFrame !== undefined) {
      return;
    }
    animationFrame = requestAnimationFrame(runScheduledTimelineFrame);
  }

  function synchronizeScroll(): void {
    scheduleTimelineFrame(false, true);
  }

  function scrollToEnd(behavior: ScrollBehavior = "auto"): void {
    if (scrollElement === undefined) {
      return;
    }
    claimTimelineScrollOwnership();
    setActiveTimelineFollowing(true);
    scrollTimelineTo(scrollElement.scrollHeight, behavior);
    if (behavior === "auto") {
      scheduleTimelineFrame(false, false);
    }
  }

  function scheduleUserMessageNavigation(): void {
    if (userMessageNavigationFrame === undefined && pendingUserMessageNavigation !== undefined) {
      userMessageNavigationFrame = requestAnimationFrame(runUserMessageNavigation);
    }
  }

  function runUserMessageNavigation(): void {
    userMessageNavigationFrame = undefined;
    const pending = pendingUserMessageNavigation;
    if (pending === undefined || scrollElement === undefined || virtualListElement === undefined)
      return;
    const message = userMessages().find((entry) => entry.id === pending.message.id);
    if (props.controller.currentThread()?.id !== pending.threadId || message === undefined) {
      cancelPendingUserMessageNavigation();
      return;
    }
    const mountedOffset = readMountedUserMessageOffset(message.id);
    const logicalOffset =
      resolveTimelineMessageLogicalOffset(
        mountedOffset,
        virtualizer.offsetOf(message.turnIndex),
        virtualGeometry(),
      ) - USER_MESSAGE_SCROLL_INSET_PX;
    const boundedLogicalOffset = Math.min(
      Math.max(0, virtualizer.totalSize() - virtualViewport().size),
      Math.max(0, logicalOffset),
    );
    const targetOffset =
      virtualListElement.offsetTop +
      virtualLogicalToPhysicalOffset(
        boundedLogicalOffset,
        virtualizer.totalSize(),
        virtualViewport().size,
      ) +
      logicalOffset -
      boundedLogicalOffset;
    const maximum = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    const target = Math.min(maximum, Math.max(0, targetOffset));
    const currentTop = scrollElement.scrollTop;
    if (pending.targetScrollTop === null || Math.abs(pending.targetScrollTop - target) > 1) {
      pending.targetScrollTop = target;
      pending.quietFrames = 0;
      scrollTimelineTo(
        target,
        matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      );
    }
    const reachedTarget = Math.abs(currentTop - target) <= 1;
    const layoutSettled = measuredTimelineLayoutRevision >= timelineLayoutRevision;
    pending.quietFrames = reachedTarget && mountedOffset !== null ? pending.quietFrames + 1 : 0;
    pending.unmountedFrames =
      reachedTarget && mountedOffset === null && layoutSettled && !programmaticScroll.smoothActive()
        ? pending.unmountedFrames + 1
        : 0;
    if (pending.unmountedFrames >= USER_MESSAGE_NAVIGATION_QUIET_FRAMES) {
      cancelPendingUserMessageNavigation();
      reportFrontendFailure(
        new Error("The selected user message did not mount at its virtual position."),
      );
      return;
    }
    if (pending.quietFrames >= USER_MESSAGE_NAVIGATION_QUIET_FRAMES) {
      pendingUserMessageNavigation = undefined;
      return;
    }
    scheduleUserMessageNavigation();
  }

  function scrollToUserMessage(message: UserMessageEntry): void {
    if (scrollElement === undefined || virtualListElement === undefined) return;
    const target = userMessages().find((entry) => entry.id === message.id);
    const threadId = props.controller.currentThread()?.id;
    if (target === undefined || threadId === undefined) return;
    cancelPendingUserMessageNavigation();
    pendingUserMessageNavigation = {
      message: target,
      threadId,
      targetScrollTop: null,
      quietFrames: 0,
      unmountedFrames: 0,
    };
    setActiveTimelineFollowing(false);
    scheduleUserMessageNavigation();
  }

  function setScrollTopFromThumb(thumbTop: number, userInitiated: boolean): void {
    if (scrollElement === undefined || scrollbarTrackElement === undefined) {
      return;
    }
    programmaticScroll.cancel();
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
    claimTimelineScrollOwnership();
    const track = scrollbarTrackElement.getBoundingClientRect();
    setScrollTopFromThumb(event.clientY - track.top - scrollbar().thumbHeight / 2, true);
  }

  function handleScrollbarThumbPointerDown(event: PointerEvent): void {
    if (scrollElement === undefined || scrollbarThumbElement === undefined) {
      return;
    }
    event.preventDefault();
    claimTimelineScrollOwnership();
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

  function endScrollbarThumbDrag(pointerId: number, releaseCapture: boolean): void {
    if (dragState?.pointerId !== pointerId) {
      return;
    }
    dragState = undefined;
    if (releaseCapture && scrollbarThumbElement?.hasPointerCapture(pointerId) === true) {
      scrollbarThumbElement.releasePointerCapture(pointerId);
    }
    scheduleTimelineFrame(true, false);
  }

  function handleScrollbarThumbPointerUp(event: PointerEvent): void {
    endScrollbarThumbDrag(event.pointerId, true);
  }

  function handleScrollbarThumbPointerCancel(event: PointerEvent): void {
    endScrollbarThumbDrag(event.pointerId, true);
  }

  function handleScrollbarThumbLostPointerCapture(event: PointerEvent): void {
    endScrollbarThumbDrag(event.pointerId, false);
  }

  function handleScrollbarKeyDown(event: KeyboardEvent): void {
    if (scrollElement === undefined) {
      return;
    }
    const page = resolveScrollbarPageScrollAmount(scrollElement.clientHeight);
    switch (event.key) {
      case "ArrowDown":
        scrollElement.scrollBy({ top: SCROLLBAR_ARROW_SCROLL_STEP_PX });
        break;
      case "ArrowUp":
        scrollElement.scrollBy({ top: -SCROLLBAR_ARROW_SCROLL_STEP_PX });
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
    claimTimelineScrollOwnership();
    event.preventDefault();
    scheduleTimelineFrame(true, false);
  }

  function scrollTimelineBy(delta: number): void {
    if (scrollElement === undefined) {
      return;
    }
    claimTimelineScrollOwnership();
    scrollElement.scrollBy({ top: delta });
    scheduleTimelineFrame(true, false);
  }

  createEffect(() => {
    const threadId = props.controller.currentThread()?.id ?? null;
    const persistedTurns = props.controller.persistedTurns();
    const layoutSignature = timelineLayoutSignature();
    if (activeTimelineThreadId !== threadId) {
      activateTimelineThread(threadId, persistedTurns, layoutSignature);
      return;
    }
    if (threadId !== null) {
      const historyLayout =
        pendingHistoryLayout?.threadId === threadId ? pendingHistoryLayout : undefined;
      const anchor = captureTimelineViewportAnchor(threadId, historyLayout?.listOffset ?? null);
      const activation = timelineSessions.activate(threadId, persistedTurns, layoutSignature);
      virtualizer = activation.session.virtualizer;
      if (activation.keysChanged || activation.measurementsReset) {
        const historyWasPrepended =
          activation.keysChanged &&
          historyLayout?.firstTurnKey !== null &&
          historyLayout?.firstTurnKey !== undefined &&
          (virtualizer.resolveAnchorOffset({
            key: historyLayout.firstTurnKey,
            offsetWithinItem: 0,
          }) ?? 0) > 0;
        if (historyWasPrepended) {
          pendingHistoryLayout = undefined;
        }
        commitVirtualizerChange(anchor);
      }
    }
  });

  function synchronizeTimelineLayoutWidth(): void {
    if (contentElement === undefined) {
      return;
    }
    const width = Math.max(0, Math.round(contentElement.clientWidth));
    setTimelineLayoutWidth((current) => (current === width ? current : width));
  }

  onMount(() => {
    if (scrollElement === undefined || contentElement === undefined) {
      return;
    }
    const handleScroll = () => {
      if (!programmaticScroll.consume(Math.max(0, scrollElement?.scrollTop ?? 0))) {
        pendingUnownedScrollMeasurement = true;
      }
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
      runScheduledTimelineFrame();
    };
    const handleScrollEnd = () => {
      programmaticScroll.finish();
    };
    const handleResize = () => {
      synchronizeTimelineLayoutWidth();
      synchronizeScroll();
    };
    scrollElement.addEventListener("wheel", handleTimelineWheel, TIMELINE_WHEEL_LISTENER_OPTIONS);
    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    scrollElement.addEventListener("scrollend", handleScrollEnd);
    resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(scrollElement);
    resizeObserver.observe(contentElement, { box: "border-box" });
    if (scrollbarTrackElement !== undefined) {
      resizeObserver.observe(scrollbarTrackElement);
    }
    synchronizeTimelineLayoutWidth();
    synchronizeScroll();
    const clockInterval = window.setInterval(() => setClock(Date.now()), 1_000);
    onCleanup(() => window.clearInterval(clockInterval));
    onCleanup(() =>
      scrollElement?.removeEventListener(
        "wheel",
        handleTimelineWheel,
        TIMELINE_WHEEL_LISTENER_OPTIONS,
      ),
    );
    onCleanup(() => scrollElement?.removeEventListener("scroll", handleScroll));
    onCleanup(() => scrollElement?.removeEventListener("scrollend", handleScrollEnd));
  });

  onCleanup(() => {
    saveActiveTimelineViewport();
    layoutMeasurement.cancel();
    resizeObserver?.disconnect();
    cancelPendingUserMessageNavigation();
    if (animationFrame !== undefined) {
      cancelAnimationFrame(animationFrame);
    }
    if (timelineRestorationFrame !== undefined) {
      cancelAnimationFrame(timelineRestorationFrame);
    }
    virtualMeasurementGeneration += 1;
    virtualMeasurementScheduledGeneration = undefined;
    pendingVirtualMeasurements.clear();
    pendingActivityVisualAnchor = undefined;
    timelineLayoutSnapshot = undefined;
    pendingHistoryLayout = undefined;
    pendingVirtualAnchorCorrection = undefined;
    cancelActivityContentDeferral();
    programmaticScroll.cancel();
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
        <TimelineActivityContext.Provider value={activityContext}>
          <div class="timeline-frame">
            <UserMessageNavigator
              activeIndex={activeUserMessageIndex()}
              messages={userMessages()}
              onSelect={scrollToUserMessage}
            />
            <section
              aria-label={messages().conversation}
              class="timeline"
              id="conversation-timeline"
              onClick={handleTimelineClick}
              onKeyDown={handleTimelineKeyDown}
              onPointerDown={handleTimelinePointerDown}
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
                            ? messages().loadingHistory
                            : messages().loadPrevious}
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
                aria-label={messages().scrollUp}
                class="surface-scrollbar-arrow up"
                disabled={!scrollbar().scrollable || scrollbar().thumbTop <= 0.5}
                onClick={() => scrollTimelineBy(-SCROLLBAR_ARROW_SCROLL_STEP_PX)}
                title={messages().scrollUpTitle}
                type="button"
              >
                <span aria-hidden="true" class="surface-scrollbar-arrow-glyph" />
              </button>
              <div
                aria-controls="conversation-timeline"
                aria-label={messages().conversationPosition}
                aria-orientation="vertical"
                aria-valuemax={Math.round(scrollbar().maximumScroll)}
                aria-valuemin={0}
                aria-valuenow={Math.round(virtualViewport().scrollTop)}
                class="surface-scrollbar-track"
                onKeyDown={handleScrollbarKeyDown}
                onPointerDown={handleScrollbarTrackPointerDown}
                ref={scrollbarTrackElement}
                role="scrollbar"
                tabIndex={scrollbar().scrollable ? 0 : -1}
              >
                <div
                  class="surface-scrollbar-thumb"
                  onLostPointerCapture={handleScrollbarThumbLostPointerCapture}
                  onPointerCancel={handleScrollbarThumbPointerCancel}
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
                aria-label={messages().scrollDown}
                class="surface-scrollbar-arrow down"
                disabled={
                  !scrollbar().scrollable ||
                  scrollbar().thumbTop + scrollbar().thumbHeight >=
                    (scrollbarTrackElement?.clientHeight ?? 0) - 0.5
                }
                onClick={() => scrollTimelineBy(SCROLLBAR_ARROW_SCROLL_STEP_PX)}
                title={messages().scrollDownTitle}
                type="button"
              >
                <span aria-hidden="true" class="surface-scrollbar-arrow-glyph" />
              </button>
            </div>
            <Show when={showScrollToEnd()}>
              <button
                aria-label={messages().goToEnd}
                class="scroll-to-end-button"
                onClick={() => scrollToEnd("smooth")}
                title={messages().goToEnd}
                type="button"
              >
                <Icon name="chevronDown" size={16} />
              </button>
            </Show>
          </div>
        </TimelineActivityContext.Provider>
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

function ConversationTurn(props: {
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

function TurnPresentationBlockView(props: {
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

function TurnHeader(props: {
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

function TurnWorkBlock(props: {
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

function WorkTimelineUnit(props: {
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
