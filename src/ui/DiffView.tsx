import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import type { DiffDocument, SplitDiffRow, UnifiedDiffLine } from "./diffDocument";
import {
  calculateDiffVirtualRange,
  DIFF_ROW_HEIGHT_PX,
  type DiffVirtualRange,
} from "./diffViewport";
import { observeElementResize } from "./elementResize";
import type { SyntaxLine } from "./syntax/contracts";
import { DiffSyntaxHighlighter } from "./syntax/diffHighlighter";
import { SyntaxTokens } from "./syntax/SyntaxTokens";

export type DiffDisplayMode = "split" | "unified";

interface DiffViewportMetrics {
  readonly height: number;
  readonly scrollTop: number;
}

export function DiffView(props: {
  readonly document: DiffDocument;
  readonly mode: DiffDisplayMode;
  readonly path: string;
}) {
  let viewportElement: HTMLDivElement | undefined;
  let releaseResizeObservation: (() => void) | undefined;
  let measurementFrame: number | undefined;
  let observedIdentity = "";
  const highlighter = new DiffSyntaxHighlighter();
  const [viewport, setViewport] = createSignal<DiffViewportMetrics>({
    height: 1,
    scrollTop: 0,
  });
  const splitProjection = createMemo(() => props.document.splitProjection());
  const rowCount = createMemo(() =>
    props.mode === "split" ? splitProjection().rows.length : props.document.unifiedRows.length,
  );
  const range = createMemo<DiffVirtualRange>(() =>
    calculateDiffVirtualRange({
      rowCount: rowCount(),
      scrollTop: viewport().scrollTop,
      viewportHeight: viewport().height,
    }),
  );
  const unifiedRows = createMemo(() => {
    const currentRange = range();
    return props.document.unifiedRows.slice(currentRange.start, currentRange.end);
  });
  const splitRows = createMemo(() => {
    const currentRange = range();
    return splitProjection().rows.slice(currentRange.start, currentRange.end);
  });
  const canvasWidth = createMemo(() => {
    const lineNumberColumns =
      props.document.oldLineNumberDigits + props.document.newLineNumberDigits;
    if (props.mode === "split") {
      const projection = splitProjection();
      const columns = Math.max(1, projection.leftMaximumColumns + projection.rightMaximumColumns);
      return `max(100%, calc(${columns + lineNumberColumns}ch + 48px))`;
    }
    return `max(100%, calc(${Math.max(
      1,
      props.document.unifiedMaximumColumns + lineNumberColumns,
    )}ch + 38px))`;
  });

  function measureViewport(): void {
    if (viewportElement === undefined) {
      return;
    }
    const next = {
      height: Math.max(1, viewportElement.clientHeight),
      scrollTop: Math.max(0, viewportElement.scrollTop),
    };
    setViewport((current) =>
      current.height === next.height && current.scrollTop === next.scrollTop ? current : next,
    );
  }

  function scheduleViewportMeasurement(): void {
    if (measurementFrame !== undefined) {
      return;
    }
    measurementFrame = requestAnimationFrame(() => {
      measurementFrame = undefined;
      measureViewport();
    });
  }

  onMount(() => {
    if (viewportElement !== undefined) {
      releaseResizeObservation = observeElementResize(viewportElement, scheduleViewportMeasurement);
      scheduleViewportMeasurement();
    }
  });
  onCleanup(() => {
    releaseResizeObservation?.();
    if (measurementFrame !== undefined) {
      cancelAnimationFrame(measurementFrame);
    }
  });

  createEffect(() => {
    const identity = `${props.path}\u0000${props.mode}`;
    if (
      observedIdentity.length > 0 &&
      observedIdentity !== identity &&
      viewportElement !== undefined
    ) {
      viewportElement.scrollTop = 0;
      viewportElement.scrollLeft = 0;
    }
    observedIdentity = identity;
    scheduleViewportMeasurement();
  });

  return (
    <div
      class={`diff-viewport is-${props.mode}`}
      data-timeline-scroll-region=""
      onScroll={scheduleViewportMeasurement}
      ref={viewportElement}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the virtual diff viewport must remain keyboard-scrollable without mounting the full document.
      tabIndex={0}
    >
      <table
        aria-label={`Diferenças em ${props.path}`}
        aria-rowcount={rowCount()}
        class="diff-virtual-table"
        style={{
          "--diff-new-line-number-width": `calc(${props.document.newLineNumberDigits}ch + 8px)`,
          "--diff-old-line-number-width": `calc(${props.document.oldLineNumberDigits}ch + 8px)`,
          width: canvasWidth(),
        }}
      >
        <tbody
          class="diff-virtual-canvas"
          style={{
            height: `${range().totalHeight}px`,
          }}
        >
          <Show
            when={props.mode === "split"}
            fallback={
              <For each={unifiedRows()}>
                {(row, relativeIndex) => (
                  <UnifiedDiffRowView
                    row={row}
                    rowIndex={range().start + relativeIndex()}
                    tokens={highlighter.render(
                      props.document,
                      props.path,
                      range().start + relativeIndex(),
                    )}
                    top={range().offsetTop + relativeIndex() * DIFF_ROW_HEIGHT_PX}
                  />
                )}
              </For>
            }
          >
            <For each={splitRows()}>
              {(row, relativeIndex) => (
                <SplitDiffRowView
                  leftTokens={highlighter.render(
                    props.document,
                    props.path,
                    splitSourceIndex(
                      splitProjection().leftSourceIndexes,
                      range().start + relativeIndex(),
                    ),
                  )}
                  row={row}
                  rowIndex={range().start + relativeIndex()}
                  rightTokens={highlighter.render(
                    props.document,
                    props.path,
                    splitSourceIndex(
                      splitProjection().rightSourceIndexes,
                      range().start + relativeIndex(),
                    ),
                  )}
                  top={range().offsetTop + relativeIndex() * DIFF_ROW_HEIGHT_PX}
                />
              )}
            </For>
          </Show>
        </tbody>
      </table>
    </div>
  );
}

function splitSourceIndex(indexes: Uint32Array, rowIndex: number): number | null {
  const sourceIndex = indexes[rowIndex];
  if (sourceIndex === undefined) {
    throw new Error(`Split diff source index ${rowIndex} does not exist.`);
  }
  return sourceIndex === 0 ? null : sourceIndex - 1;
}

function UnifiedDiffRowView(props: {
  readonly row: UnifiedDiffLine;
  readonly rowIndex: number;
  readonly tokens: SyntaxLine | null;
  readonly top: number;
}) {
  const header = () => props.row.type === "hunk" || props.row.type === "meta";
  return (
    <tr
      aria-rowindex={props.rowIndex + 1}
      class={`diff-virtual-row unified-diff-row is-${props.row.type}`}
      style={{ top: `${Math.round(props.top)}px` }}
    >
      <Show
        when={header()}
        fallback={
          <>
            <th class="diff-line-number old" scope="row">
              {props.row.oldNumber ?? ""}
            </th>
            <th class="diff-line-number new" scope="row">
              {props.row.newNumber ?? ""}
            </th>
            <td aria-hidden="true" class="diff-line-prefix">
              {props.row.type === "addition" ? "+" : props.row.type === "deletion" ? "−" : ""}
            </td>
            <td class="unified-diff-code">
              <code>
                <SyntaxTokens content={props.row.content} tokens={props.tokens} />
              </code>
            </td>
          </>
        }
      >
        <td class="unified-diff-hunk" colSpan={4}>
          {props.row.content}
        </td>
      </Show>
    </tr>
  );
}

function SplitDiffRowView(props: {
  readonly leftTokens: SyntaxLine | null;
  readonly row: SplitDiffRow;
  readonly rowIndex: number;
  readonly rightTokens: SyntaxLine | null;
  readonly top: number;
}) {
  const header = () => props.row.leftType === "header";
  return (
    <tr
      aria-rowindex={props.rowIndex + 1}
      class={`diff-virtual-row split-diff-row ${header() ? "is-header" : ""}`}
      style={{ top: `${Math.round(props.top)}px` }}
    >
      <Show
        when={header()}
        fallback={
          <>
            <th class="diff-line-number left" scope="row">
              {props.row.leftNumber ?? ""}
            </th>
            <td class={`split-diff-cell left ${props.row.leftType}`}>
              <code>
                <SyntaxTokens content={props.row.leftContent} tokens={props.leftTokens} />
              </code>
            </td>
            <th class="diff-line-number right" scope="row">
              {props.row.rightNumber ?? ""}
            </th>
            <td class={`split-diff-cell right ${props.row.rightType}`}>
              <code>
                <SyntaxTokens content={props.row.rightContent} tokens={props.rightTokens} />
              </code>
            </td>
          </>
        }
      >
        <td class="split-diff-hunk" colSpan={4}>
          {props.row.leftContent}
        </td>
      </Show>
    </tr>
  );
}
