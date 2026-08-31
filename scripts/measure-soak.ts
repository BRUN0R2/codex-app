import { performance } from "node:perf_hooks";
import { createRoot } from "solid-js";

import type { VisibleThreadItem } from "../src/contracts/types.ts";
import { overlayVisibleTurn } from "../src/state/visibleTurnSequence.ts";
import { ActivityVirtualizerStore } from "../src/ui/activityVirtualization.ts";
import { AgentActivityProjectionStore } from "../src/ui/agentActivityPresentation.ts";
import {
  projectVirtualLogicalOffset,
  resolveBoundedVirtualViewport,
} from "../src/ui/boundedVirtualViewport.ts";
import { createMarkdownStreamRenderer } from "../src/ui/markdownStreamRenderer.ts";
import { createTimelineDisclosureStore } from "../src/ui/timelineDisclosure.ts";
import {
  timelineDisclosureChildKey,
  timelineDisclosureStorageKey,
} from "../src/ui/timelineDisclosureContext.ts";
import { TimelineThreadSessionStore } from "../src/ui/timelineSession.ts";
import { TurnPresentationStore } from "../src/ui/turnPresentation.ts";
import { VariableSizeVirtualizer } from "../src/ui/variableSizeVirtualizer.ts";

const TURN_COUNT = 100_000;
const RANGE_QUERY_COUNT = 50_000;
const MEASUREMENT_COUNT = 10_000;
const OVERLAY_PROJECTION_COUNT = 50_000;
const MARKDOWN_BLOCK_COUNT = 5_000;
const TIMELINE_SESSION_COUNT = 12;
const TIMELINE_SESSION_SWITCH_COUNT = 50_000;
const TIMELINE_SESSION_TURN_COUNT = 1_000;
const PROJECTION_ACTIVITY_COUNT = 240;
const PROJECTION_UPDATE_COUNT = 20_000;
const ESTIMATED_TURN_HEIGHT = 498;
const ACTIVITY_FILE_COUNT = 100_000;
const ACTIVITY_RANGE_QUERY_COUNT = 50_000;
const ACTIVITY_VIEWPORT_SIZE = 900;
const COLLAPSED_ACTIVITY_HEIGHT = 30;
const EXPANDED_ACTIVITY_HEIGHT = 400;

const keys = Array.from({ length: TURN_COUNT }, (_, index) => `turn-${index}`);
const virtualizer = new VariableSizeVirtualizer(ESTIMATED_TURN_HEIGHT);
const buildMilliseconds = duration(() => virtualizer.setKeys(keys));
const measurementMilliseconds = duration(() => {
  for (let index = 0; index < MEASUREMENT_COUNT; index += 1) {
    const key = keys[index];
    if (key === undefined) {
      throw new Error("Soak benchmark could not resolve a measured turn.");
    }
    virtualizer.measure(key, 320 + (index % 17) * 23);
  }
});
let maximumRenderedTurns = 0;
let rangeChecksum = 0;
const rangeQueryMilliseconds = duration(() => {
  const maximumOffset = Math.max(1, virtualizer.totalSize() - 900);
  for (let query = 0; query < RANGE_QUERY_COUNT; query += 1) {
    const offset = (query * 104_729) % maximumOffset;
    const range = virtualizer.range(offset, 900, 900);
    maximumRenderedTurns = Math.max(maximumRenderedTurns, range.end - range.start);
    rangeChecksum += range.start + range.end;
  }
});

let activityKeyReads = 0;
const activitySource = {
  count: ACTIVITY_FILE_COUNT,
  estimatedOffsetOf: (index: number) => index * COLLAPSED_ACTIVITY_HEIGHT,
  estimatedSizeAt: () => COLLAPSED_ACTIVITY_HEIGHT,
  identity: {},
  indexOf: (key: string) => {
    const index = Number(key.slice("file-".length));
    return Number.isInteger(index) && index >= 0 && index < ACTIVITY_FILE_COUNT ? index : null;
  },
  keyAt: (index: number) => {
    activityKeyReads += 1;
    return `file-${index}`;
  },
} as const;
const activitySessions = new ActivityVirtualizerStore(COLLAPSED_ACTIVITY_HEIGHT, 2);
let collapsedActivityVirtualizer: VariableSizeVirtualizer | undefined;
const collapsedActivityBuildMilliseconds = duration(() => {
  collapsedActivityVirtualizer = activitySessions.activateSource(
    "thread:activity-files",
    activitySource,
    "1280:14:unified",
    0,
    COLLAPSED_ACTIVITY_HEIGHT,
  ).virtualizer;
});
const collapsedActivityBuildKeyReads = activityKeyReads;
if (collapsedActivityVirtualizer === undefined) {
  throw new Error("Activity soak benchmark did not create its collapsed virtualizer.");
}
let maximumCollapsedActivities = 0;
let collapsedActivityRangeChecksum = 0;
const collapsedActivityQueryMilliseconds = duration(() => {
  const logicalTotalSize = collapsedActivityVirtualizer.totalSize();
  const geometry = resolveBoundedVirtualViewport({
    logicalTotalSize,
    physicalOffset: 0,
    viewportSize: ACTIVITY_VIEWPORT_SIZE,
  });
  const maximumPhysicalOffset = Math.max(1, geometry.physicalTotalSize - ACTIVITY_VIEWPORT_SIZE);
  for (let query = 0; query < ACTIVITY_RANGE_QUERY_COUNT; query += 1) {
    const physicalOffset = (query * 104_729) % maximumPhysicalOffset;
    const viewport = resolveBoundedVirtualViewport({
      logicalTotalSize,
      physicalOffset,
      viewportSize: ACTIVITY_VIEWPORT_SIZE,
    });
    const range = collapsedActivityVirtualizer.range(
      viewport.logicalOffset,
      ACTIVITY_VIEWPORT_SIZE,
      ACTIVITY_VIEWPORT_SIZE,
    );
    maximumCollapsedActivities = Math.max(
      maximumCollapsedActivities,
      range.end - range.start,
    );
    collapsedActivityRangeChecksum +=
      range.start +
      range.end +
      Math.round(
        projectVirtualLogicalOffset(
          viewport,
          collapsedActivityVirtualizer.offsetOf(range.start),
        ),
      );
  }
});

let expandedActivityVirtualizer: VariableSizeVirtualizer | undefined;
const expandedActivityBuildMilliseconds = duration(() => {
  expandedActivityVirtualizer = activitySessions.activateSource(
    "thread:activity-files",
    activitySource,
    "1280:14:unified",
    1,
    EXPANDED_ACTIVITY_HEIGHT,
  ).virtualizer;
});
if (expandedActivityVirtualizer === undefined) {
  throw new Error("Activity soak benchmark did not create its expanded virtualizer.");
}
const expandedLogicalTotalSize = expandedActivityVirtualizer.totalSize();
const expandedGeometry = resolveBoundedVirtualViewport({
  logicalTotalSize: expandedLogicalTotalSize,
  physicalOffset: 0,
  viewportSize: ACTIVITY_VIEWPORT_SIZE,
});
let maximumExpandedActivities = 0;
let expandedActivityRangeChecksum = 0;
const expandedActivityQueryMilliseconds = duration(() => {
  const maximumPhysicalOffset = Math.max(
    1,
    expandedGeometry.physicalTotalSize - ACTIVITY_VIEWPORT_SIZE,
  );
  for (let query = 0; query < ACTIVITY_RANGE_QUERY_COUNT; query += 1) {
    const physicalOffset = (query * 104_729) % maximumPhysicalOffset;
    const viewport = resolveBoundedVirtualViewport({
      logicalTotalSize: expandedLogicalTotalSize,
      physicalOffset,
      viewportSize: ACTIVITY_VIEWPORT_SIZE,
    });
    const range = expandedActivityVirtualizer.range(
      viewport.logicalOffset,
      ACTIVITY_VIEWPORT_SIZE,
      ACTIVITY_VIEWPORT_SIZE,
    );
    maximumExpandedActivities = Math.max(maximumExpandedActivities, range.end - range.start);
    expandedActivityRangeChecksum +=
      range.start +
      range.end +
      Math.round(
        projectVirtualLogicalOffset(
          viewport,
          expandedActivityVirtualizer.offsetOf(range.start),
        ),
      );
  }
});
for (let index = 0; index < MEASUREMENT_COUNT; index += 1) {
  expandedActivityVirtualizer.measure(`file-${index}`, EXPANDED_ACTIVITY_HEIGHT + (index % 11));
}
let collapsedActivityRestoreTotalSize = Number.NaN;
const collapsedActivityRestoreMilliseconds = duration(() => {
  const activation = activitySessions.activateSource(
    "thread:activity-files",
    activitySource,
    "1280:14:unified",
    2,
    COLLAPSED_ACTIVITY_HEIGHT,
  );
  if (!activation.measurementsReset) {
    throw new Error("Collapsing the activity subtree retained expanded file measurements.");
  }
  collapsedActivityRestoreTotalSize = activation.virtualizer.totalSize();
});

interface DisclosureSoakMetrics {
  readonly closeParentMilliseconds: number;
  readonly closeSingleLeafMilliseconds: number;
  readonly countAfterLeafClose: number;
  readonly countBeforeClose: number;
  readonly openMilliseconds: number;
  readonly removedChildUsesFallback: boolean;
  readonly subtreeRevision: number;
}

let disclosureSoakMetrics: DisclosureSoakMetrics | undefined;
createRoot((dispose) => {
  const disclosures = createTimelineDisclosureStore();
  const parent = timelineDisclosureStorageKey("thread:soak", "activity:files");
  const children = Array.from({ length: ACTIVITY_FILE_COUNT }, (_, index) =>
    timelineDisclosureChildKey(parent, `change:${index}`),
  );
  const openMilliseconds = duration(() => {
    for (const child of children) {
      disclosures.setOpen(child, true);
    }
  });
  const countBeforeClose = disclosures.countOpenDescendants(parent);
  const selectedChild = children[Math.floor(children.length / 2)];
  if (selectedChild === undefined) {
    throw new Error("Disclosure soak benchmark did not create its selected child.");
  }
  const closeSingleLeafMilliseconds = duration(() => disclosures.setOpen(selectedChild, false));
  const countAfterLeafClose = disclosures.countOpenDescendants(parent);
  const closeParentMilliseconds = duration(() => disclosures.setOpen(parent, false));
  disclosureSoakMetrics = {
    closeParentMilliseconds,
    closeSingleLeafMilliseconds,
    countAfterLeafClose,
    countBeforeClose,
    openMilliseconds,
    removedChildUsesFallback: disclosures.read(selectedChild, true),
    subtreeRevision: disclosures.subtreeRevision(parent),
  };
  dispose();
});
if (disclosureSoakMetrics === undefined) {
  throw new Error("Disclosure soak benchmark did not produce metrics.");
}

const timelineSessions = new TimelineThreadSessionStore(
  () => new VariableSizeVirtualizer(ESTIMATED_TURN_HEIGHT),
  16,
);
const timelineSessionTurns = Array.from({ length: TIMELINE_SESSION_COUNT }, (_, sessionIndex) =>
  Array.from(
    { length: TIMELINE_SESSION_TURN_COUNT },
    (_, turnIndex) => ({ id: `turn-${turnIndex}` }),
  ),
);
for (let sessionIndex = 0; sessionIndex < TIMELINE_SESSION_COUNT; sessionIndex += 1) {
  const threadId = `thread-${sessionIndex}`;
  const sessionTurns = timelineSessionTurns[sessionIndex];
  if (sessionTurns === undefined) {
    throw new Error("Timeline session benchmark could not resolve its turns.");
  }
  const session = timelineSessions.activate(threadId, sessionTurns).session;
  const firstTurn = sessionTurns[0];
  if (firstTurn === undefined) {
    throw new Error("Timeline session benchmark requires at least one turn.");
  }
  session.virtualizer.measure(`${threadId}\u0000${firstTurn.id}`, 600 + sessionIndex);
  timelineSessions.save(threadId, {
    anchor: null,
    followingLatest: sessionIndex % 2 === 0,
    scrollTop: sessionIndex * 1_000,
  });
}
let timelineSessionChecksum = 0;
const timelineSessionSwitchMilliseconds = duration(() => {
  for (let switchIndex = 0; switchIndex < TIMELINE_SESSION_SWITCH_COUNT; switchIndex += 1) {
    const sessionIndex = switchIndex % TIMELINE_SESSION_COUNT;
    const threadId = `thread-${sessionIndex}`;
    const sessionTurns = timelineSessionTurns[sessionIndex];
    if (sessionTurns === undefined) {
      throw new Error("Timeline session switch lost its turn source.");
    }
    const session = timelineSessions.activate(threadId, sessionTurns).session;
    timelineSessionChecksum +=
      session.virtualizer.offsetOf(1) + session.scrollTop + Number(session.followingLatest);
  }
});

const persistedTurns = keys.map((id, index) => ({
  id,
  items: [],
  status: "completed" as const,
  error: null,
  createdAt: index,
  updatedAt: index,
}));
const lastPersistedTurn = persistedTurns.at(-1);
if (lastPersistedTurn === undefined) {
  throw new Error("Soak benchmark requires at least one persisted turn.");
}
const overlayTurn = {
  ...lastPersistedTurn,
  status: "inProgress" as const,
  items: [{ type: "agentMessage" as const, id: "streaming", text: "partial", phase: null }],
};
let overlayChecksum = 0;
const overlayProjectionMilliseconds = duration(() => {
  for (let index = 0; index < OVERLAY_PROJECTION_COUNT; index += 1) {
    const sequence = overlayVisibleTurn(persistedTurns, TURN_COUNT - 1, overlayTurn);
    overlayChecksum += sequence.slice(-8).length;
  }
});

const markdown = createMarkdownStreamRenderer((source) => source);
let markdownSource = "";
let committedCharacters = 0;
const markdownMilliseconds = duration(() => {
  for (let index = 0; index < MARKDOWN_BLOCK_COUNT; index += 1) {
    markdownSource += `${index === 0 ? "" : "\n\n"}Paragraph ${index}.`;
    const update = markdown.render(markdownSource, "append");
    committedCharacters += update.appendHtml.length;
  }
  const completed = markdown.render(markdownSource, "final");
  if (completed.appendHtml.length !== markdownSource.length) {
    throw new Error("Markdown soak benchmark lost content during finalization.");
  }
});

const projectionActivities = Array.from(
  { length: PROJECTION_ACTIVITY_COUNT },
  (_, index): Extract<VisibleThreadItem, { type: "commandExecution" }> => ({
    type: "commandExecution",
    id: `projection-command-${index}`,
    command: `command ${index}`,
    cwd: ".",
    processId: null,
    source: "agent",
    status: "completed",
    aggregatedOutput: null,
    exitCode: 0,
    durationMs: index,
  }),
);
const projectionPrefix = projectionActivities.slice(0, PROJECTION_ACTIVITY_COUNT / 2);
const projectionSuffix = projectionActivities.slice(PROJECTION_ACTIVITY_COUNT / 2);
const activityProjectionStore = new AgentActivityProjectionStore();
const initialActivityProjection = activityProjectionStore.project(projectionActivities);
let activityProjectionChecksum = 0;
const activityProjectionMilliseconds = duration(() => {
  for (let index = 0; index < PROJECTION_UPDATE_COUNT; index += 1) {
    const projected = activityProjectionStore.project([
      ...projectionPrefix,
      {
        type: "reasoning",
        id: "projection-reasoning",
        summary: [`Analysis ${index}`],
        content: [],
      },
      ...projectionSuffix,
    ]);
    if (projected !== initialActivityProjection) {
      throw new Error("Reasoning-only updates replaced an unchanged activity projection.");
    }
    activityProjectionChecksum += projected.length;
  }
});

const projectionUser: Extract<VisibleThreadItem, { type: "userMessage" }> = {
  type: "userMessage",
  id: "projection-user",
  content: [{ type: "text", text: "Execute a tarefa" }],
};
const projectionAnswer: Extract<VisibleThreadItem, { type: "agentMessage" }> = {
  type: "agentMessage",
  id: "projection-answer",
  text: "a",
  phase: "finalAnswer",
};
const turnProjectionStore = new TurnPresentationStore();
const initialTurnProjection = turnProjectionStore.project([
  projectionUser,
  ...projectionActivities,
  projectionAnswer,
]);
const stableUserBlock = initialTurnProjection.blocks[0];
const stableWorkBlock = initialTurnProjection.blocks[1];
let turnProjectionChecksum = 0;
const turnProjectionMilliseconds = duration(() => {
  for (let index = 0; index < PROJECTION_UPDATE_COUNT; index += 1) {
    const projected = turnProjectionStore.project([
      projectionUser,
      ...projectionActivities,
      { ...projectionAnswer, text: `Resposta parcial ${index}` },
    ]);
    if (projected.blocks[0] !== stableUserBlock || projected.blocks[1] !== stableWorkBlock) {
      throw new Error("Streaming replaced an unchanged turn presentation block.");
    }
    turnProjectionChecksum += projected.blocks.length;
  }
});

if (
  maximumRenderedTurns > 16 ||
  maximumCollapsedActivities > 128 ||
  maximumExpandedActivities > 16 ||
  rangeChecksum <= 0 ||
  collapsedActivityRangeChecksum <= 0 ||
  expandedActivityRangeChecksum <= 0 ||
  expandedLogicalTotalSize !== ACTIVITY_FILE_COUNT * EXPANDED_ACTIVITY_HEIGHT ||
  expandedGeometry.physicalTotalSize >= expandedLogicalTotalSize ||
  collapsedActivityBuildKeyReads !== 0 ||
  collapsedActivityRestoreTotalSize !== ACTIVITY_FILE_COUNT * COLLAPSED_ACTIVITY_HEIGHT ||
  disclosureSoakMetrics.countBeforeClose !== ACTIVITY_FILE_COUNT ||
  disclosureSoakMetrics.countAfterLeafClose !== ACTIVITY_FILE_COUNT - 1 ||
  disclosureSoakMetrics.subtreeRevision !== 1 ||
  !disclosureSoakMetrics.removedChildUsesFallback ||
  timelineSessionChecksum <= 0 ||
  overlayChecksum !== OVERLAY_PROJECTION_COUNT * 8 ||
  committedCharacters <= 0 ||
  activityProjectionChecksum !== PROJECTION_UPDATE_COUNT ||
  turnProjectionChecksum !== PROJECTION_UPDATE_COUNT * 3
) {
  throw new Error("Soak benchmark violated a virtualization or streaming invariant.");
}

process.stdout.write(
  `${JSON.stringify(
    {
      turnCount: TURN_COUNT,
      measuredTurns: MEASUREMENT_COUNT,
      rangeQueries: RANGE_QUERY_COUNT,
      maximumRenderedTurns,
      virtualizerBuildMs: roundMilliseconds(buildMilliseconds),
      virtualizerMeasurementsMs: roundMilliseconds(measurementMilliseconds),
      virtualizerQueriesMs: roundMilliseconds(rangeQueryMilliseconds),
      activityFileCount: ACTIVITY_FILE_COUNT,
      collapsedActivityBuildKeyReads,
      collapsedActivityBuildMs: roundMilliseconds(collapsedActivityBuildMilliseconds),
      collapsedActivityQueryMs: roundMilliseconds(collapsedActivityQueryMilliseconds),
      maximumCollapsedActivities,
      expandedActivityBuildMs: roundMilliseconds(expandedActivityBuildMilliseconds),
      expandedActivityQueryMs: roundMilliseconds(expandedActivityQueryMilliseconds),
      maximumExpandedActivities,
      expandedActivityLogicalHeight: expandedLogicalTotalSize,
      expandedActivityPhysicalHeight: expandedGeometry.physicalTotalSize,
      collapsedActivityRestoreMs: roundMilliseconds(collapsedActivityRestoreMilliseconds),
      disclosureOpenMs: roundMilliseconds(disclosureSoakMetrics.openMilliseconds),
      disclosureSingleLeafCloseMs: roundMilliseconds(
        disclosureSoakMetrics.closeSingleLeafMilliseconds,
      ),
      disclosureParentCloseMs: roundMilliseconds(disclosureSoakMetrics.closeParentMilliseconds),
      timelineSessionSwitches: TIMELINE_SESSION_SWITCH_COUNT,
      timelineSessionSwitchMs: roundMilliseconds(timelineSessionSwitchMilliseconds),
      overlayProjections: OVERLAY_PROJECTION_COUNT,
      overlayProjectionMs: roundMilliseconds(overlayProjectionMilliseconds),
      markdownBlocks: MARKDOWN_BLOCK_COUNT,
      incrementalMarkdownMs: roundMilliseconds(markdownMilliseconds),
      projectionActivities: PROJECTION_ACTIVITY_COUNT,
      projectionUpdates: PROJECTION_UPDATE_COUNT,
      activityProjectionMs: roundMilliseconds(activityProjectionMilliseconds),
      turnProjectionMs: roundMilliseconds(turnProjectionMilliseconds),
    },
    null,
    2,
  )}\n`,
);

function duration(operation: () => void): number {
  const startedAt = performance.now();
  operation();
  return performance.now() - startedAt;
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
