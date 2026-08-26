import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import type { DiffDocument } from "./diffDocument";
import {
  calculateDiffViewportIntrinsicHeight,
  calculateDiffVirtualRange,
  type DiffVirtualRange,
  resolveDiffVirtualizationHeight,
} from "./diffViewport";
import { readDiffVirtualRows } from "./diffVirtualRows";
import { observeElementResize, readResizeObserverBorderBoxHeight } from "./elementResize";
import {
  releaseVirtualRowsCanvas,
  type VirtualRowsCanvas,
  type VirtualRowsWindow,
} from "./virtualRowsWindow";

export type DiffDisplayMode = "split" | "unified";
export type DiffViewportSizing = "container" | "intrinsic";
export function DiffView(props: {
  readonly document: DiffDocument;
  readonly hidden?: boolean | undefined;
  readonly mode: DiffDisplayMode;
  readonly path: string;
  readonly viewportSizing: DiffViewportSizing;
}) {
  let viewportElement: HTMLDivElement | undefined;
  let canvasElement: VirtualRowsCanvas | undefined;
  let releaseResizeObservation: (() => void) | undefined;
  let rowsWindow: VirtualRowsWindow | undefined;
  let observedDocument: DiffDocument | undefined;
  let observedIdentity = "";
  let knownScrollLeft = 0;
  let knownScrollTop = 0;
  const usesContainerSizing = props.viewportSizing === "container";
  const viewportMeasurement = usesContainerSizing ? createSignal<number | null>(null) : undefined;
  const [scrollTop, setScrollTop] = createSignal(0);
  const splitProjection = createMemo(() => props.document.splitProjection());
  const rowCount = createMemo(() =>
    props.mode === "split" ? splitProjection().rows.length : props.document.unifiedRows.length,
  );
  const intrinsicViewportHeight = createMemo(() =>
    calculateDiffViewportIntrinsicHeight({
      hidden: props.hidden === true,
      rowCount: rowCount(),
    }),
  );
  const viewportHeight =
    viewportMeasurement === undefined
      ? intrinsicViewportHeight
      : createMemo(() =>
          resolveDiffVirtualizationHeight(intrinsicViewportHeight(), viewportMeasurement[0]()),
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
  function updateViewportScroll(event: Event & { readonly currentTarget: HTMLDivElement }): void {
    knownScrollLeft = Math.max(0, event.currentTarget.scrollLeft);
    knownScrollTop = Math.max(0, event.currentTarget.scrollTop);
    setScrollTop(knownScrollTop);
  }

  createEffect(() => {
    const document = props.document;
    const identity = `${props.path}\u0000${props.mode}`;
    const documentChanged = observedDocument !== undefined && observedDocument !== document;
    const identityChanged = observedIdentity.length > 0 && observedIdentity !== identity;
    // Scroll events keep these values authoritative. Reading layout-backed DOM scroll properties
    // here would make every virtual slot replacement eligible for a synchronous layout flush.
    if (
      (documentChanged || identityChanged) &&
      viewportElement !== undefined &&
      (knownScrollTop !== 0 || knownScrollLeft !== 0)
    ) {
      viewportElement.scrollTop = 0;
      viewportElement.scrollLeft = 0;
      knownScrollLeft = 0;
      knownScrollTop = 0;
      setScrollTop(0);
    }
    observedDocument = document;
    observedIdentity = identity;
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
  if (viewportMeasurement !== undefined) {
    const [, setObservedViewportHeight] = viewportMeasurement;
    onMount(() => {
      if (viewportElement === undefined) {
        return;
      }
      releaseResizeObservation = observeElementResize(viewportElement, (entry) => {
        const height = readResizeObserverBorderBoxHeight(entry) ?? entry.contentRect.height;
        if (!Number.isFinite(height) || height <= 0) {
          return;
        }
        setObservedViewportHeight((current) =>
          current !== null && Math.abs(current - height) < 0.25 ? current : height,
        );
      });
    });
  }
  onCleanup(() => {
    releaseResizeObservation?.();
    if (canvasElement !== undefined) {
      releaseVirtualRowsCanvas(canvasElement);
    }
  });

  return (
    <div
      class={`diff-viewport is-${props.mode}`}
      data-timeline-scroll-region=""
      data-viewport-sizing={props.viewportSizing}
      hidden={props.hidden}
      onScroll={updateViewportScroll}
      ref={viewportElement}
      style={{
        height: usesContainerSizing ? undefined : `${intrinsicViewportHeight()}px`,
      }}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the virtual diff viewport must remain keyboard-scrollable without mounting the full document.
      tabIndex={0}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: native table formatting is not interoperable with absolutely positioned virtual rows in supported WebViews. */}
      <div
        aria-label={`Diferenças em ${props.path}`}
        aria-colcount={props.mode === "split" ? 4 : 2}
        aria-rowcount={rowCount()}
        class="diff-virtual-table"
        role="table"
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
        {/* biome-ignore lint/a11y/useSemanticElements: the virtual rowgroup must remain a block canvas outside native table layout. */}
        <div
          class="diff-virtual-canvas"
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
