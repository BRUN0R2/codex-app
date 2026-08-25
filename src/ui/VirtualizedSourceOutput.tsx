import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { calculateFixedRowVirtualRange } from "./fixedRowVirtualization";
import { acquireSourceVirtualRows } from "./sourceVirtualRows";
import type { SourceOutputProjection } from "./toolOutputProjection";
import type { VirtualRowsLease } from "./virtualRowsPool";

const SOURCE_ROW_HEIGHT_PX = 22;
const SOURCE_OVERSCAN_ROWS = 0;
const SOURCE_VIEWPORT_HEIGHT_PX = 205;
const MAX_SOURCE_CANVAS_HEIGHT_PX = 8_000_000;

export function VirtualizedSourceOutput(props: { readonly projection: SourceOutputProjection }) {
  let viewportElement: HTMLDivElement | undefined;
  let canvasElement: HTMLTableSectionElement | undefined;
  let rowsLease: VirtualRowsLease | undefined;
  let observedLines = props.projection.lines;
  let knownScrollLeft = 0;
  let knownScrollTop = 0;
  const [scrollTop, setScrollTop] = createSignal(0);
  const viewportHeight = createMemo(() =>
    Math.max(
      1,
      Math.min(props.projection.lines.length * SOURCE_ROW_HEIGHT_PX, SOURCE_VIEWPORT_HEIGHT_PX),
    ),
  );
  const range = createMemo(() =>
    calculateFixedRowVirtualRange({
      itemCount: props.projection.lines.length,
      itemSize: SOURCE_ROW_HEIGHT_PX,
      maximumCanvasSize: MAX_SOURCE_CANVAS_HEIGHT_PX,
      overscanItems: SOURCE_OVERSCAN_ROWS,
      scrollOffset: scrollTop(),
      viewportSize: viewportHeight(),
    }),
  );
  const canvasWidth = createMemo(
    () =>
      `max(100%, calc(${props.projection.maximumColumns + props.projection.lineNumberDigits}ch + 30px))`,
  );
  createEffect(() => {
    const nextLease = acquireSourceVirtualRows(props.projection, range(), SOURCE_ROW_HEIGHT_PX);
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
    const lines = props.projection.lines;
    if (
      observedLines !== lines &&
      viewportElement !== undefined &&
      (knownScrollTop !== 0 || knownScrollLeft !== 0)
    ) {
      viewportElement.scrollTop = 0;
      viewportElement.scrollLeft = 0;
      knownScrollLeft = 0;
      knownScrollTop = 0;
      setScrollTop(0);
    }
    observedLines = lines;
  });

  return (
    <div
      class="tool-source-viewport"
      data-timeline-scroll-region=""
      onScroll={updateViewportScroll}
      ref={viewportElement}
      style={{
        height: `${viewportHeight()}px`,
      }}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the virtual source viewport must remain keyboard-scrollable without mounting the full document.
      tabIndex={0}
    >
      <table
        aria-label="Código lido do arquivo"
        aria-rowcount={props.projection.lines.length}
        class="tool-source-output tool-source-virtual-table"
        style={{ width: canvasWidth() }}
      >
        <tbody
          class="tool-source-virtual-canvas"
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
