import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import type { DiffDocument } from "./diffDocument";
import {
  calculateDiffVirtualRange,
  DIFF_ROW_HEIGHT_PX,
  DIFF_VIEWPORT_MAX_HEIGHT_PX,
  type DiffVirtualRange,
} from "./diffViewport";
import { readDiffVirtualRows } from "./diffVirtualRows";
import { releaseVirtualRowsCanvas, type VirtualRowsWindow } from "./virtualRowsWindow";

export type DiffDisplayMode = "split" | "unified";
export function DiffView(props: {
  readonly document: DiffDocument;
  readonly hidden?: boolean | undefined;
  readonly mode: DiffDisplayMode;
  readonly path: string;
}) {
  let viewportElement: HTMLDivElement | undefined;
  let canvasElement: HTMLTableSectionElement | undefined;
  let rowsWindow: VirtualRowsWindow | undefined;
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
        : Math.min(DIFF_VIEWPORT_MAX_HEIGHT_PX, rowCount() * DIFF_ROW_HEIGHT_PX),
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
    if (props.mode === "split") {
      const projection = splitProjection();
      const columns = Math.max(1, projection.leftMaximumColumns + projection.rightMaximumColumns);
      return `max(100%, calc(${columns}ch + var(--diff-old-line-number-width) + var(--diff-new-line-number-width) + 4ch))`;
    }
    return `max(100%, calc(${Math.max(
      1,
      props.document.unifiedMaximumColumns,
    )}ch + var(--diff-line-number-width) + 2ch))`;
  });
  createEffect(() => {
    const nextWindow = readDiffVirtualRows({
      document: props.document,
      mode: props.mode,
      path: props.path,
      range: range(),
    });
    rowsWindow = nextWindow;
    if (canvasElement !== undefined) {
      canvasElement = nextWindow.renderInto(canvasElement).canvas;
    }
  });
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
  onCleanup(() => {
    if (canvasElement !== undefined) {
      releaseVirtualRowsCanvas(canvasElement);
    }
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
          "--diff-new-line-number-content-width": `${props.document.newLineNumberDigits}ch`,
          "--diff-new-line-number-width": `calc(${props.document.newLineNumberDigits}ch + var(--diff-line-number-inline-padding))`,
          "--diff-old-line-number-content-width": `${props.document.oldLineNumberDigits}ch`,
          "--diff-old-line-number-width": `calc(${props.document.oldLineNumberDigits}ch + var(--diff-line-number-inline-padding))`,
          "--diff-line-number-content-width": `${Math.max(
            props.document.oldLineNumberDigits,
            props.document.newLineNumberDigits,
          )}ch`,
          "--diff-line-number-width": `calc(${Math.max(
            props.document.oldLineNumberDigits,
            props.document.newLineNumberDigits,
          )}ch + var(--diff-line-number-inline-padding))`,
          width: canvasWidth(),
        }}
      >
        <tbody
          class="diff-virtual-canvas"
          ref={(element) => {
            canvasElement = element;
            queueMicrotask(() => {
              if (
                canvasElement === element &&
                rowsWindow !== undefined &&
                element.parentNode !== null
              ) {
                canvasElement = rowsWindow.renderInto(element).canvas;
              }
            });
          }}
        />
      </table>
    </div>
  );
}
