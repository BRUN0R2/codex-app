import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import type { DiffDocument } from "./diffDocument";
import {
  calculateDiffVirtualRange,
  DIFF_ROW_HEIGHT_PX,
  type DiffVirtualRange,
} from "./diffViewport";
import { acquireDiffVirtualRows } from "./diffVirtualRows";
import type { VirtualRowsLease } from "./virtualRowsPool";

export type DiffDisplayMode = "split" | "unified";
const INITIAL_DIFF_VIEWPORT_HEIGHT_PX = 360;

export function DiffView(props: {
  readonly document: DiffDocument;
  readonly hidden?: boolean | undefined;
  readonly mode: DiffDisplayMode;
  readonly path: string;
}) {
  let viewportElement: HTMLDivElement | undefined;
  let canvasElement: HTMLTableSectionElement | undefined;
  let rowsLease: VirtualRowsLease | undefined;
  let observedIdentity = "";
  let knownScrollLeft = 0;
  let knownScrollTop = 0;
  const [scrollTop, setScrollTop] = createSignal(0);
  const splitProjection = createMemo(() => props.document.splitProjection());
  const rowCount = createMemo(() =>
    props.mode === "split" ? splitProjection().rows.length : props.document.unifiedRows.length,
  );
  const viewportHeight = createMemo(() =>
    Math.max(
      1,
      props.hidden === true
        ? 1
        : Math.min(INITIAL_DIFF_VIEWPORT_HEIGHT_PX, rowCount() * DIFF_ROW_HEIGHT_PX),
    ),
  );
  const range = createMemo<DiffVirtualRange>(() =>
    calculateDiffVirtualRange({
      rowCount: rowCount(),
      scrollTop: scrollTop(),
      viewportHeight: viewportHeight(),
    }),
  );
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
  createEffect(() => {
    const nextLease = acquireDiffVirtualRows({
      document: props.document,
      mode: props.mode,
      path: props.path,
      range: range(),
    });
    if (canvasElement === undefined) {
      rowsLease = nextLease;
      return;
    }
    const previousLease = rowsLease;
    canvasElement.replaceWith(nextLease.element);
    canvasElement = nextLease.element;
    previousLease?.release();
    rowsLease = nextLease;
  });
  onCleanup(() => rowsLease?.release());

  function updateViewportScroll(event: Event & { readonly currentTarget: HTMLDivElement }): void {
    knownScrollLeft = Math.max(0, event.currentTarget.scrollLeft);
    knownScrollTop = Math.max(0, event.currentTarget.scrollTop);
    setScrollTop(knownScrollTop);
  }

  createEffect(() => {
    const identity = `${props.path}\u0000${props.mode}`;
    if (
      observedIdentity.length > 0 &&
      observedIdentity !== identity &&
      viewportElement !== undefined &&
      (knownScrollTop !== 0 || knownScrollLeft !== 0)
    ) {
      viewportElement.scrollTop = 0;
      viewportElement.scrollLeft = 0;
      knownScrollLeft = 0;
      knownScrollTop = 0;
      setScrollTop(0);
    }
    observedIdentity = identity;
  });

  return (
    <div
      class={`diff-viewport is-${props.mode}`}
      data-timeline-scroll-region=""
      hidden={props.hidden}
      onScroll={updateViewportScroll}
      ref={viewportElement}
      style={{ height: `${viewportHeight()}px` }}
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
          ref={(element) => {
            canvasElement = element;
            if (rowsLease !== undefined) {
              element.replaceWith(rowsLease.element);
              canvasElement = rowsLease.element;
            }
          }}
        />
      </table>
    </div>
  );
}
