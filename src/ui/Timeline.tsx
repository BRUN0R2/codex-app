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
import { activityContentProjectionCache } from "./activityContentProjectionCache";
import { fileName, isFileReadTool, toolIconName, toolLabel } from "./activityLabels";
import {
  type ActivityListProjection,
  activityListEntryDisclosureKey,
  COLLAPSED_ACTIVITY_ITEM_ESTIMATE_PX,
  createActivityListProjection,
  estimateActivityListEntrySize,
} from "./activityListProjection";
import {
  ActivityVirtualizerStore,
  shouldDeferActivityContent,
  shouldMinimizeActivityOverscan,
} from "./activityVirtualization";
import {
  type AgentActivityItem,
  type AgentActivityKind,
  AgentActivityProjectionStore,
  type AgentActivityRenderUnit,
  activeAgentActivity,
  agentActivityRenderUnitIdentity,
  agentActivitySummaryLabel,
  type ImageViewItem,
  isTerminalReadTool,
  shouldRenderAgentActivityGroup,
  summarizeAgentActivity,
  webSearchActivityTitle,
} from "./agentActivityPresentation";
import {
  projectVirtualLogicalOffset,
  resolveBoundedVirtualViewport,
  virtualLogicalToPhysicalOffset,
} from "./boundedVirtualViewport";
import { CodexGlyph } from "./CodexGlyph";
import { presentAssistantText } from "./contentReferenceMarkers";
import { DiffView } from "./DiffView";
import { observeElementResize, readResizeObserverBorderBoxHeight } from "./elementResize";
import { fileChangeLineStats } from "./fileChangeStats";
import {
  FrontendFailureContext,
  frontendFailureMessage,
  useFrontendFailureReporter,
} from "./frontendFailure";
import { Icon, type IconName } from "./Icon";
import { TimelineTurnRenderFailure } from "./RenderFailure";
import {
  resolveScrollbarPageScrollAmount,
  SCROLLBAR_ARROW_SCROLL_STEP_PX,
  sameScrollbarMetrics,
} from "./scrollCommands";
import { ThreadOutputView } from "./ThreadOutputView";
import {
  AgentMessage,
  blockPreview,
  CommentaryMessage,
  inlinePreview,
  UserMessage,
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
  timelineDisclosureChildKey,
  timelineDisclosureNamespacePrefix,
  useTimelineDisclosure,
  useTimelineDisclosureStorageKey,
} from "./timelineDisclosureContext";
import { timelineFileChangeIdentity, timelineItemRenderIdentity } from "./timelineIdentity";
import {
  commandActivityTitle,
  commandLiveOutputText,
  commandOutputText,
  commandPollActivityTitle,
  fileChangeActionLabel,
  fileChangeGroupTitle,
  fileReadActivityTitle,
  formatCompactElapsedSeconds,
  formatElapsedSeconds,
  reasoningTitle,
  runningCommandHeadline,
  terminalReadActivityTitle,
  thinkingPresentation,
  toolActivityTitle,
  toolOutputText,
  turnDurationLabel,
  visibleCommandDurationMs,
} from "./timelinePresentation";
import {
  calculateTimelineScrollbar,
  findTimelineAnchorIndex,
  hasReachedTimelineWheelHandoffTarget,
  isTimelineNearEnd,
  normalizeTimelineWheelDelta,
  resolveNestedTimelineWheelTransfer,
  resolveTimelineAnchorCorrection,
  resolveTimelineFollowing,
  resolveTimelineMessageOffset,
  resolveTimelineRestorationTop,
  resolveTimelineWheelHandoffTarget,
  type ScrollbarMetrics,
  shouldMeasureTimelineScrollAsUserInitiated,
  shouldPreserveTimelineAnchor,
  shouldSynchronizeTimelineToEnd,
  TimelineProgrammaticScrollTracker,
} from "./timelineScroll";
import { TimelineThreadSessionStore, type TimelineViewportAnchor } from "./timelineSession";
import { presentTurnFailure } from "./turnFailure";
import {
  asTurnMessageBlock,
  asTurnWorkBlock,
  type TurnPresentationBlock,
  TurnPresentationStore,
  type TurnWorkItem,
} from "./turnPresentation";
import { type UserMessageEntry, UserMessageNavigator } from "./UserMessageNavigator";
import { VirtualizedActivityList } from "./VirtualizedActivityList";
import { VariableSizeVirtualizer, type VirtualRange } from "./variableSizeVirtualizer";
import { findViewportVisualAnchorIndex } from "./viewportAnchor";

const controlledTimelineDisclosureKeys = new WeakMap<HTMLElement, () => TimelineDisclosureKey>();
const DIFF_COPY_FEEDBACK_RESET_MILLISECONDS = 2_000;

function bindControlledTimelineDisclosure(
  element: HTMLElement,
  disclosure: TimelineDisclosureBinding,
): void {
  bindControlledTimelineDisclosureKey(element, disclosure.storageKey);
}

function bindControlledTimelineDisclosureKey(
  element: HTMLElement,
  storageKey: () => TimelineDisclosureKey,
): void {
  controlledTimelineDisclosureKeys.set(element, storageKey);
}

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
const TIMELINE_MINIMUM_VIRTUAL_OVERSCAN_PX = 900;
const TIMELINE_VIRTUAL_OVERSCAN_VIEWPORTS = 1.5;
const TIMELINE_HISTORY_LOAD_THRESHOLD_PX = 640;
const TIMELINE_SESSION_CACHE_CAPACITY: number = 16;
const ACTIVITY_SESSION_CACHE_CAPACITY = 256;
const ACTIVITY_ITEM_VIRTUALIZATION_THRESHOLD = 48;
const ACTIVITY_OPEN_DISCLOSURE_VIRTUALIZATION_THRESHOLD = 4;
const USER_MESSAGE_NAVIGATION_MAX_FRAMES: number = 8;
const USER_MESSAGE_NAVIGATION_QUIET_FRAMES: number = 8;
const USER_MESSAGE_SCROLL_INSET_PX: number = 32;
const USER_MESSAGE_NAVIGATOR_TITLE_PREVIEW_CHARACTERS: number = 180;
const USER_MESSAGE_NAVIGATOR_DETAIL_PREVIEW_CHARACTERS: number = 320;
const ACTIVE_MESSAGE_VIEWPORT_INSET_PX: number = 112;
const LIVE_OUTPUT_FOLLOW_EPSILON_PX: number = 24;
const ACTIVITY_CONTENT_SETTLE_DELAY_MS = 90;
const TIMELINE_SCROLL_REGION_SELECTOR = "[data-timeline-scroll-region]";
const TIMELINE_WHEEL_LISTENER_OPTIONS = {
  capture: true,
  passive: false,
} as const satisfies AddEventListenerOptions;
const IMAGE_OUTPUT_PRESENTATION = { type: "image" } as const;

interface TimelineUserMessageEntry extends UserMessageEntry {
  readonly turnIndex: number;
}

interface PendingUserMessageNavigation {
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
  let nestedWheelTimelineRegion: HTMLElement | undefined;
  let nestedWheelTimelineTarget: number | undefined;
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
  const disclosureContext: TimelineDisclosureContextValue = {
    keyPrefix: () => timelineDisclosureNamespacePrefix(props.controller.currentThread()?.id ?? ""),
    onLayoutChange: () => {
      recordTimelineLayoutChange();
      queueMicrotask(measureMountedVirtualTurns);
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
  const activityViewport = createMemo<TimelineActivityViewportSnapshot | null>((previous) => {
    virtualRevision();
    const viewport = virtualViewport();
    const element = scrollElement;
    if (element === undefined) {
      return null;
    }
    const size = Math.max(1, viewport.size - props.bottomOcclusion);
    return previous !== null &&
      previous.element === element &&
      previous.scrollTop === viewport.scrollTop &&
      previous.size === size
      ? previous
      : { element, scrollTop: viewport.scrollTop, size };
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
  const virtualGeometry = createMemo(() => {
    virtualRevision();
    const viewport = virtualViewport();
    return resolveBoundedVirtualViewport({
      logicalTotalSize: virtualizer.totalSize(),
      physicalOffset: viewport.offset,
      viewportSize: viewport.size,
    });
  });
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
  const userMessages = createMemo<readonly TimelineUserMessageEntry[]>(() =>
    props.controller.persistedTurns().flatMap((turn, turnIndex) => {
      const response = [...turn.items].reverse().find((item) => item.type === "agentMessage");
      const detail =
        response?.type === "agentMessage"
          ? blockPreview(
              presentAssistantText(response.text),
              USER_MESSAGE_NAVIGATOR_DETAIL_PREVIEW_CHARACTERS,
            )
          : null;
      return turn.items.flatMap((item) => {
        if (item.type !== "userMessage") {
          return [];
        }
        const title = inlinePreview(
          userMessageCopyText(item.content),
          USER_MESSAGE_NAVIGATOR_TITLE_PREVIEW_CHARACTERS,
        );
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
    return Math.max(
      0,
      anchor.getBoundingClientRect().top -
        (virtualListTop ?? virtualListElement.getBoundingClientRect().top),
    );
  }

  function recordTimelineLayoutChange(): void {
    timelineLayoutRevision += 1;
    setActivityLayoutRevision(timelineLayoutRevision);
    const pending = pendingUserMessageNavigation;
    if (pending === undefined) {
      return;
    }
    cancelUserMessageNavigationFrame();
    scheduleMountedUserMessageNavigation(
      pending.message,
      pending.threadId,
      USER_MESSAGE_NAVIGATION_MAX_FRAMES,
      timelineLayoutRevision,
    );
  }

  function readUserMessageOffset(
    message: TimelineUserMessageEntry,
    virtualListTop: number | null = null,
  ): number {
    return resolveTimelineMessageOffset(
      readMountedUserMessageOffset(message.id, virtualListTop),
      virtualOffset(message.turnIndex),
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
    if (messages.length === 0 || list === undefined) {
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
    const viewportTop = Math.max(
      0,
      input.scrollTop - input.listOffset + ACTIVE_MESSAGE_VIEWPORT_INSET_PX,
    );
    return findTimelineAnchorIndex(
      messages.length,
      (index) => {
        const message = messages[index];
        return message === undefined ? Number.MAX_SAFE_INTEGER : virtualOffset(message.turnIndex);
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

  function updateVirtualViewport(): void {
    if (scrollElement === undefined || virtualListElement === undefined) {
      return;
    }
    commitVirtualViewport(
      Math.max(0, scrollElement.scrollTop - virtualListElement.offsetTop),
      Math.max(0, scrollElement.scrollTop),
      Math.max(1, scrollElement.clientHeight),
    );
  }

  function scrollTimelineTo(
    top: number,
    behavior: ScrollBehavior = "auto",
    synchronizedLayout?: TimelineLayoutSnapshot | undefined,
  ): void {
    cancelTimelineWheelHandoff();
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

  function consumeProgrammaticScroll(): boolean {
    return scrollElement === undefined
      ? false
      : programmaticScroll.consume(scrollElement.scrollTop);
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
    timelineTransitionRevision += 1;
    cancelPendingUserMessageNavigation();
    cancelTimelineWheelHandoff();
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
      nestedWheelTimelineTarget !== undefined ||
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

  function cancelTimelineWheelHandoff(): void {
    const handoffActive = nestedWheelTimelineTarget !== undefined;
    nestedWheelTimelineRegion = undefined;
    nestedWheelTimelineTarget = undefined;
    if (!handoffActive) {
      return;
    }
    if (scrollElement !== undefined) {
      scrollElement.scrollTo({ behavior: "auto", top: scrollElement.scrollTop });
    }
  }

  function claimTimelineScrollOwnership(
    preserveWheelHandoff = false,
    releaseFollowing = true,
  ): void {
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
    if (!preserveWheelHandoff) {
      cancelTimelineWheelHandoff();
    }
    if (releaseFollowing) {
      setActiveTimelineFollowing(false);
    }
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
    if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
      return;
    }
    const nestedRegion = readNestedTimelineScrollRegion(event.target);
    claimTimelineScrollOwnership(true, nestedRegion === null);
    if (nestedRegion === null) {
      cancelTimelineWheelHandoff();
      scheduleTimelineFrame(true, false);
      return;
    }
    if (nestedWheelTimelineRegion !== undefined && nestedWheelTimelineRegion !== nestedRegion) {
      cancelTimelineWheelHandoff();
    }
    if (scrollElement === undefined || !event.cancelable) {
      cancelTimelineWheelHandoff();
      scheduleTimelineFrame(true, false);
      return;
    }
    const transfer = resolveNestedTimelineWheelTransfer({
      clientHeight: nestedRegion.clientHeight,
      delta: normalizeTimelineWheelDelta({
        deltaMode: event.deltaMode,
        deltaY: event.deltaY,
        viewportHeight: nestedRegion.clientHeight,
      }),
      scrollHeight: nestedRegion.scrollHeight,
      scrollTop: nestedRegion.scrollTop,
    });
    if (transfer === null) {
      cancelTimelineWheelHandoff();
      return;
    }
    setActiveTimelineFollowing(false);
    event.preventDefault();
    nestedRegion.scrollTop = transfer.nestedScrollTop;
    const target = resolveTimelineWheelHandoffTarget({
      currentScrollTop: scrollElement.scrollTop,
      delta: transfer.timelineDelta,
      maximumScroll: Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight),
      pendingTarget: nestedWheelTimelineTarget ?? null,
    });
    if (Math.abs(scrollElement.scrollTop - target) <= 1) {
      nestedWheelTimelineRegion = undefined;
      nestedWheelTimelineTarget = undefined;
      return;
    }
    nestedWheelTimelineRegion = nestedRegion;
    nestedWheelTimelineTarget = target;
    scrollElement.scrollTo({ behavior: "smooth", top: target });
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
    setActiveTimelineFollowing(true);
    scrollTimelineTo(scrollElement.scrollHeight, behavior);
    if (behavior === "auto") {
      scheduleTimelineFrame(false, false);
    }
  }

  function scheduleUserMessageNavigationCompletion(
    message: TimelineUserMessageEntry,
    threadId: string,
    alignedOffset: number,
    alignedLayoutRevision: number,
    quietFrames: number,
  ): void {
    userMessageNavigationFrame = requestAnimationFrame(() => {
      userMessageNavigationFrame = undefined;
      const pending = pendingUserMessageNavigation;
      if (
        pending?.threadId !== threadId ||
        pending.message.id !== message.id ||
        props.controller.currentThread()?.id !== threadId
      ) {
        return;
      }
      const mountedOffset = readMountedUserMessageOffset(message.id);
      const layoutStable =
        timelineLayoutRevision === alignedLayoutRevision &&
        measuredTimelineLayoutRevision >= timelineLayoutRevision;
      const geometryStable = mountedOffset !== null && Math.abs(mountedOffset - alignedOffset) <= 1;
      if (layoutStable && geometryStable) {
        if (quietFrames <= 1) {
          pendingUserMessageNavigation = undefined;
          return;
        }
        scheduleUserMessageNavigationCompletion(
          message,
          threadId,
          mountedOffset,
          alignedLayoutRevision,
          quietFrames - 1,
        );
        return;
      }
      scheduleMountedUserMessageNavigation(
        message,
        threadId,
        USER_MESSAGE_NAVIGATION_MAX_FRAMES,
        timelineLayoutRevision,
        mountedOffset,
      );
    });
  }

  function scheduleMountedUserMessageNavigation(
    message: TimelineUserMessageEntry,
    threadId: string,
    remainingFrames: number,
    requiredLayoutRevision: number,
    previousOffset: number | null = null,
  ): void {
    userMessageNavigationFrame = requestAnimationFrame(() => {
      userMessageNavigationFrame = undefined;
      if (props.controller.currentThread()?.id !== threadId || virtualListElement === undefined) {
        return;
      }
      const mountedOffset = readMountedUserMessageOffset(message.id);
      if (mountedOffset === null) {
        if (remainingFrames <= 1) {
          return;
        }
        updateVirtualViewport();
        scheduleMountedUserMessageNavigation(
          message,
          threadId,
          remainingFrames - 1,
          requiredLayoutRevision,
          null,
        );
        return;
      }
      const stable = previousOffset !== null && Math.abs(mountedOffset - previousOffset) <= 1;
      const layoutSettled = measuredTimelineLayoutRevision >= requiredLayoutRevision;
      if ((layoutSettled && stable) || remainingFrames <= 1) {
        const alignedLayoutRevision = timelineLayoutRevision;
        scrollTimelineTo(
          virtualListElement.offsetTop + mountedOffset - USER_MESSAGE_SCROLL_INSET_PX,
        );
        scheduleUserMessageNavigationCompletion(
          message,
          threadId,
          mountedOffset,
          alignedLayoutRevision,
          USER_MESSAGE_NAVIGATION_QUIET_FRAMES,
        );
        return;
      }
      scheduleMountedUserMessageNavigation(
        message,
        threadId,
        remainingFrames - 1,
        requiredLayoutRevision,
        mountedOffset,
      );
    });
  }

  function scrollToUserMessage(message: UserMessageEntry): void {
    if (scrollElement === undefined || virtualListElement === undefined) {
      return;
    }
    const target = userMessages().find((entry) => entry.id === message.id);
    const threadId = props.controller.currentThread()?.id;
    if (target === undefined || threadId === undefined) {
      return;
    }
    cancelPendingUserMessageNavigation();
    pendingUserMessageNavigation = { message: target, threadId };
    setActiveTimelineFollowing(false);
    if (readMountedUserMessageOffset(target.id) === null) {
      scrollTimelineTo(
        virtualListElement.offsetTop + readUserMessageOffset(target) - USER_MESSAGE_SCROLL_INSET_PX,
      );
      updateVirtualViewport();
    }
    scheduleMountedUserMessageNavigation(
      target,
      threadId,
      USER_MESSAGE_NAVIGATION_MAX_FRAMES,
      timelineLayoutRevision,
    );
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
      if (!consumeProgrammaticScroll()) {
        pendingUnownedScrollMeasurement = true;
      }
      scheduleTimelineFrame(false, false);
    };
    const handleScrollEnd = () => {
      if (
        scrollElement !== undefined &&
        nestedWheelTimelineTarget !== undefined &&
        hasReachedTimelineWheelHandoffTarget({
          currentScrollTop: scrollElement.scrollTop,
          maximumScroll: Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight),
          target: nestedWheelTimelineTarget,
        })
      ) {
        nestedWheelTimelineRegion = undefined;
        nestedWheelTimelineTarget = undefined;
      }
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
    resizeObserver.observe(contentElement);
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
    nestedWheelTimelineRegion = undefined;
    nestedWheelTimelineTarget = undefined;
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
              aria-label="Conversa"
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
                onClick={() => scrollTimelineBy(-SCROLLBAR_ARROW_SCROLL_STEP_PX)}
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
                aria-label="Rolar conversa para baixo"
                class="surface-scrollbar-arrow down"
                disabled={
                  !scrollbar().scrollable ||
                  scrollbar().thumbTop + scrollbar().thumbHeight >=
                    (scrollbarTrackElement?.clientHeight ?? 0) - 0.5
                }
                onClick={() => scrollTimelineBy(SCROLLBAR_ARROW_SCROLL_STEP_PX)}
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
  readonly clock: number;
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
              clock={props.clock}
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
  readonly clock: number;
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
          />
        )}
      </Match>
    </Switch>
  );
}

function asImageViewGroup(
  unit: AgentActivityRenderUnit,
): Extract<AgentActivityRenderUnit, { readonly kind: "imageView" }> | null {
  return unit.kind === "imageView" ? unit : null;
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

function ImageViewGroup(props: {
  readonly disclosureKey: string;
  readonly items: readonly ImageViewItem[];
}) {
  const disclosure = useTimelineDisclosure(() => props.disclosureKey);
  const label = () =>
    props.items.length === 1 ? "Visualizou uma imagem" : `Visualizou ${props.items.length} imagens`;

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
                fallback={<span class="tool-image-output-error">Imagem indisponível.</span>}
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

function AgentActivityGroup(props: {
  readonly clock: number;
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly disclosureKey: string;
  readonly isCurrent: boolean;
  readonly items: readonly AgentActivityItem[];
  readonly reasoningHeading: string | null;
}) {
  const disclosure = useTimelineDisclosure(() => props.disclosureKey);
  const listProjection = createMemo(() => createActivityListProjection(props.items));
  const summaries = createMemo(() => summarizeAgentActivity(props.items));
  const activeActivity = createMemo(() => activeAgentActivity(props.items));
  const estimateStorageKeys = new Map<string, TimelineDisclosureKey>();
  let estimateStorageKeyPrefix: TimelineDisclosureKey | null = null;
  const iconKind = createMemo(() =>
    props.isCurrent ? activeActivity()?.kind : summaries()[0]?.kind,
  );
  const activeCommandDuration = createMemo(() => {
    if (!props.isCurrent || activeActivity()?.kind !== "commands") {
      return null;
    }
    for (let index = props.items.length - 1; index >= 0; index -= 1) {
      const item = props.items[index];
      if (item?.type !== "commandExecution" || item.status !== "inProgress") {
        continue;
      }
      return commandDurationLabel(item, props.clock);
    }
    return null;
  });
  const title = createMemo(() => {
    if (!props.isCurrent) {
      return agentActivitySummaryLabel(props.items);
    }
    const fallback = activeActivity()?.label ?? props.reasoningHeading ?? "Pensando";
    return activeActivity()?.kind === "commands"
      ? runningCommandHeadline(activeCommandDuration(), fallback)
      : fallback;
  });
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

function ActivityListProjectionView(props: {
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

function CollapsedActivityListProjectionView(props: {
  readonly entryIndex: () => number;
  readonly entryKey: () => string;
  readonly projection: () => ActivityListProjection;
}) {
  const change = createMemo(() =>
    props.projection().fileChangeAt(props.entryIndex(), props.entryKey()),
  );
  return <CollapsedChange change={change()} disclosureKey={props.entryKey()} />;
}

function agentActivityIcon(kind: AgentActivityKind | undefined): IconName {
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
    case "webSearch":
      return "globe";
    default:
      return "sparkles";
  }
}

function TimelineActivityIcon(props: { readonly name: IconName }) {
  return (
    <span aria-hidden="true" class="activity-icon">
      <Icon name={props.name} size={16} />
    </span>
  );
}

function TimelineDisclosureIcon(props: {
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
  readonly clock?: number | undefined;
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly item: VisibleThreadItem;
  readonly materializeBody?: (() => boolean) | undefined;
  readonly streaming?: boolean | undefined;
  readonly variant?: "default" | "grouped" | undefined;
}

function TimelineItem(props: TimelineItemProps) {
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

function ContextCompaction(props: {
  readonly active?: boolean | undefined;
  readonly item: Extract<ThreadItem, { type: "contextCompaction" }>;
}) {
  return (
    <section class="context-compaction-row" id={props.item.id}>
      <TimelineActivityIcon name="layers" />
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
  readonly clock: number;
  readonly item: Extract<ThreadItem, { type: "commandExecution" }>;
  readonly materializeBody?: (() => boolean) | undefined;
  readonly variant?: "default" | "grouped" | undefined;
}) {
  let outputScrollElement: HTMLDivElement | undefined;
  let followLiveOutput = true;
  let knownOutputScrollLeft = 0;
  let knownOutputScrollTop = 0;
  let activeItemId = props.item.id;
  const disclosure = useTimelineDisclosure(() => `command:${props.item.id}`);
  const output = () => props.item.aggregatedOutput;
  const liveOutput = () => commandLiveOutputText(props.item.liveOutput);
  const duration = () =>
    props.variant === "grouped" && props.item.status === "inProgress"
      ? null
      : commandDurationLabel(props.item, props.clock);
  const backgroundRunning = () =>
    props.item.status === "inProgress" && props.item.processId !== null;
  const title = () => {
    const fallback = commandActivityTitle(
      props.item.command,
      props.item.status,
      props.variant === "grouped" ? false : disclosure.isOpen(),
    );
    return backgroundRunning() ? runningCommandHeadline(duration(), fallback) : fallback;
  };

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
        <ActivityHeadline active={props.item.status === "inProgress"} text={title()} />
        <Show when={!backgroundRunning() && duration()}>
          {(visibleDuration) => <span class="activity-elapsed">· {visibleDuration()}</span>}
        </Show>
        <TimelineDisclosureIcon expanded={disclosure.isOpen()} />
      </summary>
      <Show when={disclosure.isOpen() && (props.materializeBody?.() ?? true)}>
        <div class="command-card-inner">
          <div class="command-card-header">Shell</div>
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
                {props.item.status === "declined" ? "Recusado" : "Falhou"}
              </span>
            </div>
          </Show>
        </div>
      </Show>
    </details>
  );
}

function commandDurationLabel(
  item: Extract<ThreadItem, { type: "commandExecution" }>,
  clock: number,
): string | null {
  const duration = visibleCommandDurationMs(item.status, item.startedAt, item.durationMs, clock);
  return duration === null ? null : formatCompactElapsedSeconds(Math.floor(duration / 1_000));
}

function ToolItem(props: {
  readonly item: Extract<ThreadItem, { type: "toolExecution" }>;
  readonly materializeBody?: (() => boolean) | undefined;
  readonly variant?: "default" | "grouped" | undefined;
}) {
  const disclosure = useTimelineDisclosure(() => `tool:${props.item.id}`);
  const description = () => props.item.description || toolLabel(props.item.name);
  const isWebSearch = () => props.item.name === "web_search" || props.item.name === "web_fetch";
  const isCommandPoll = () => props.item.name === "poll_command";
  const isFileRead = () => isFileReadTool(props.item.name);
  const isTerminalRead = () => isTerminalReadTool(props.item.name);
  const output = () => props.item.output;
  const hasDetails = () =>
    output() !== null || props.item.status === "failed" || props.item.status === "declined";
  const fileReadTitle = () => {
    const base = fileReadActivityTitle(props.item.status);
    return props.item.outputPresentation.type === "sourceFile"
      ? `${base}: ${fileName(props.item.outputPresentation.path)}`
      : base;
  };
  const title = () =>
    isCommandPoll()
      ? commandPollActivityTitle(props.item.status)
      : isTerminalRead()
        ? terminalReadActivityTitle(props.item.status)
        : isFileRead()
          ? fileReadTitle()
          : isWebSearch()
            ? webSearchActivityTitle(description(), props.item.status)
            : toolActivityTitle(description(), props.item.status, disclosure.isOpen());

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
          <ToolActivityHeadline item={props.item} title={title()} />
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
          <ToolActivityHeadline item={props.item} title={title()} />
          <TimelineDisclosureIcon expanded={disclosure.isOpen()} />
        </summary>
        <Show when={disclosure.isOpen() && (props.materializeBody?.() ?? true)}>
          <div class="command-card-inner">
            <div class="command-card-header">{toolLabel(props.item.name)}</div>
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

function ToolActivityHeadline(props: {
  readonly item: Extract<ThreadItem, { type: "toolExecution" }>;
  readonly title: string;
}) {
  return (
    <>
      <TimelineActivityIcon name={toolIconName(props.item.name)} />
      <ActivityHeadline active={props.item.status === "inProgress"} text={props.title} />
    </>
  );
}

function FileChangeItem(props: {
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly item: Extract<ThreadItem, { type: "fileChange" }>;
  readonly materializeBody?: (() => boolean) | undefined;
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

function FileChangeGroup(props: {
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly item: Extract<ThreadItem, { type: "fileChange" }>;
  readonly materializeBody?: (() => boolean) | undefined;
}) {
  const disclosure = useTimelineDisclosure(() => `file-change:${props.item.id}`);
  const title = () => fileChangeGroupTitle(props.item.changes.length);
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
            change={readTimelineValue(changesByIdentity(), changeIdentity, "alteração de arquivo")}
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
        <ActivityHeadline active={props.item.status === "inProgress"} text={title()} />
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

function Change(props: {
  readonly change: FileChange;
  readonly diffDisplay?: "split" | "unified" | undefined;
  readonly disclosureKey: string;
  readonly materializeBody?: (() => boolean) | undefined;
}) {
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
        <span class="file-change-action">{fileChangeActionLabel(kind())}</span>
        <Show when={!disclosure.isOpen()}>
          <span class="diff-file-identity">
            <code title={path()}>{fileName(path())}</code>
          </span>
          <Show when={kind() !== "update"}>
            <span class={`change-kind kind-${kind()}`}>
              {kind() === "add" ? "NOVO" : "EXCLUÍDO"}
            </span>
          </Show>
          <Show when={additions() > 0}>
            <span class="diff-stat additions" title={`${additions()} linhas adicionadas`}>
              +{additions()}
            </span>
          </Show>
          <Show when={deletions() > 0}>
            <span class="diff-stat deletions" title={`${deletions()} linhas removidas`}>
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
              fallback={<div class="diff-empty-state">Nenhuma diferença textual disponível.</div>}
            >
              <ExpandedChangeDiff change={bodyChange()} mode={props.diffDisplay ?? "unified"} />
            </Show>
          </div>
        )}
      </Show>
    </details>
  );
}

function CollapsedChange(props: { readonly change: FileChange; readonly disclosureKey: string }) {
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
      actionElement.textContent = fileChangeActionLabel(kind);
      kindElement.className = `change-kind kind-${kind}`;
      kindElement.hidden = kind === "update";
      kindElement.textContent = kind === "add" ? "NOVO" : "EXCLUÍDO";
      previousKind = kind;
    }
    if (path !== previousPath) {
      fileElement.title = path;
      fileElement.textContent = fileName(path);
      previousPath = path;
    }
    if (stats.additions !== previousAdditions) {
      additionsElement.hidden = stats.additions === 0;
      additionsElement.title = `${stats.additions} linhas adicionadas`;
      additionsElement.textContent = `+${stats.additions}`;
      previousAdditions = stats.additions;
    }
    if (stats.deletions !== previousDeletions) {
      deletionsElement.hidden = stats.deletions === 0;
      deletionsElement.title = `${stats.deletions} linhas removidas`;
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
          {fileChangeActionLabel(initialKind)}
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
          {initialKind === "add" ? "NOVO" : "EXCLUÍDO"}
        </span>
        <span
          class="diff-stat additions"
          hidden={initialStats.additions === 0}
          ref={additionsElement}
          title={`${initialStats.additions} linhas adicionadas`}
        >
          +{initialStats.additions}
        </span>
        <span
          class="diff-stat deletions"
          hidden={initialStats.deletions === 0}
          ref={deletionsElement}
          title={`${initialStats.deletions} linhas removidas`}
        >
          -{initialStats.deletions}
        </span>
        <TimelineDisclosureIcon class="diff-file-chevron" expanded={false} />
      </summary>
    </details>
  );
}

function DiffPanelHeader(props: { readonly change: FileChange }) {
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
      reportFailure(frontendFailureMessage("Falha ao copiar a edição", reason));
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
        return "Edição copiada";
      case "failed":
        return "Falha ao copiar a edição";
      case "idle":
        return "Copiar edição";
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

function ExpandedChangeDiff(props: {
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
