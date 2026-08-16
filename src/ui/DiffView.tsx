import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import type { DiffDocument, SplitDiffRow, UnifiedDiffLine } from "./diffDocument";
import {
  calculateDiffVirtualRange,
  DIFF_ROW_HEIGHT_PX,
  type DiffVirtualRange,
} from "./diffViewport";
import { observeElementResize } from "./elementResize";
import { escapeHtml, highlightCode } from "./syntaxHighlight";

export type DiffDisplayMode = "split" | "unified";

interface DiffViewportMetrics {
  readonly height: number;
  readonly scrollTop: number;
}

const MAX_HIGHLIGHT_CACHE_ENTRIES = 4_096;
const MAX_HIGHLIGHT_LINE_CHARACTERS = 10_000;

export function DiffView(props: {
  readonly document: DiffDocument;
  readonly mode: DiffDisplayMode;
  readonly path: string;
}) {
  let viewportElement: HTMLDivElement | undefined;
  let releaseResizeObservation: (() => void) | undefined;
  let measurementFrame: number | undefined;
  let observedIdentity = "";
  const highlighter = new BoundedDiffHighlighter();
  const [viewport, setViewport] = createSignal<DiffViewportMetrics>({
    height: 1,
    scrollTop: 0,
  });
  const rowCount = createMemo(() =>
    props.mode === "split"
      ? props.document.splitProjection().rows.length
      : props.document.unifiedRows.length,
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
    return props.document.splitProjection().rows.slice(currentRange.start, currentRange.end);
  });
  const canvasWidth = createMemo(() => {
    if (props.mode === "split") {
      const projection = props.document.splitProjection();
      const columns = Math.max(1, projection.leftMaximumColumns + projection.rightMaximumColumns);
      return `max(100%, calc(176px + ${columns}ch))`;
    }
    return `max(100%, calc(112px + ${Math.max(1, props.document.unifiedMaximumColumns)}ch))`;
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
                    highlighted={
                      row.type === "addition" || row.type === "deletion"
                        ? highlighter.render(row.content, props.path)
                        : escapeHtml(row.content)
                    }
                    row={row}
                    rowIndex={range().start + relativeIndex()}
                    top={range().offsetTop + relativeIndex() * DIFF_ROW_HEIGHT_PX}
                  />
                )}
              </For>
            }
          >
            <For each={splitRows()}>
              {(row, relativeIndex) => (
                <SplitDiffRowView
                  highlight={(content) => highlighter.render(content, props.path)}
                  row={row}
                  rowIndex={range().start + relativeIndex()}
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

function UnifiedDiffRowView(props: {
  readonly highlighted: string;
  readonly row: UnifiedDiffLine;
  readonly rowIndex: number;
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
              <code innerHTML={props.highlighted} />
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
  readonly highlight: (content: string) => string;
  readonly row: SplitDiffRow;
  readonly rowIndex: number;
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
              <code
                innerHTML={
                  props.row.leftType === "removed"
                    ? props.highlight(props.row.leftContent)
                    : escapeHtml(props.row.leftContent)
                }
              />
            </td>
            <th class="diff-line-number right" scope="row">
              {props.row.rightNumber ?? ""}
            </th>
            <td class={`split-diff-cell right ${props.row.rightType}`}>
              <code
                innerHTML={
                  props.row.rightType === "added"
                    ? props.highlight(props.row.rightContent)
                    : escapeHtml(props.row.rightContent)
                }
              />
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

class BoundedDiffHighlighter {
  readonly #entries = new Map<string, string>();
  #path = "";

  render(content: string, path: string): string {
    if (this.#path !== path) {
      this.#path = path;
      this.#entries.clear();
    }
    if (content.length > MAX_HIGHLIGHT_LINE_CHARACTERS) {
      return escapeHtml(content);
    }
    const cached = this.#entries.get(content);
    if (cached !== undefined) {
      return cached;
    }
    const highlighted = highlightCode(content, fileExtension(path));
    if (this.#entries.size >= MAX_HIGHLIGHT_CACHE_ENTRIES) {
      const oldest = this.#entries.keys().next().value;
      if (oldest !== undefined) {
        this.#entries.delete(oldest);
      }
    }
    this.#entries.set(content, highlighted);
    return highlighted;
  }
}

function fileExtension(path: string): string | undefined {
  const file = path.split(/[\\/]/u).at(-1) ?? path;
  const extension = file.includes(".") ? file.split(".").at(-1) : undefined;
  return extension?.toLowerCase();
}
