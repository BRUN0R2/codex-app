import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";

import { calculateFixedRowVirtualRange } from "./fixedRowVirtualization";
import { readSourceVirtualRows } from "./sourceVirtualRows";
import type { SourceOutputProjection } from "./toolOutputProjection";
import {
  releaseVirtualRowsCanvas,
  type VirtualRowsCanvas,
  type VirtualRowsWindow,
} from "./virtualRowsWindow";

const SOURCE_ROW_HEIGHT_PX = 22;
const SOURCE_OVERSCAN_ROWS = 0;
const SOURCE_VIEWPORT_HEIGHT_PX = 205;
const MAX_SOURCE_CANVAS_HEIGHT_PX = 8_000_000;

export function VirtualizedSourceOutput(props: { readonly projection: SourceOutputProjection }) {
  let viewportElement: HTMLDivElement | undefined;
  let canvasElement: VirtualRowsCanvas | undefined;
  let rowsWindow: VirtualRowsWindow | undefined;
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
    const nextWindow = readSourceVirtualRows(props.projection, range(), SOURCE_ROW_HEIGHT_PX);
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
  onCleanup(() => {
    if (canvasElement !== undefined) {
      releaseVirtualRowsCanvas(canvasElement);
    }
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
      {/* biome-ignore lint/a11y/useSemanticElements: native table formatting is not interoperable with absolutely positioned virtual rows in supported WebViews. */}
      <div
        aria-label="Código lido do arquivo"
        aria-colcount={2}
        aria-rowcount={props.projection.lines.length}
        class="tool-source-output tool-source-virtual-table"
        role="table"
        style={{
          "--tool-source-line-number-width": `calc(${props.projection.lineNumberDigits}ch + 10px)`,
          width: canvasWidth(),
        }}
      >
        {/* biome-ignore lint/a11y/useSemanticElements: the virtual rowgroup must remain a block canvas outside native table layout. */}
        <div
          class="tool-source-virtual-canvas"
          role="rowgroup"
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
      </div>
    </div>
  );
}
