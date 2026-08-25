import { createEffect, onCleanup } from "solid-js";

import type { ThreadOutput } from "../contracts/types";
import { WeightedRecentCache } from "./weightedRecentCache";

interface PlainTextOutputCacheEntry {
  readonly text: string;
  readonly window: PlainTextOutputWindow;
}

interface PlainTextOutputCanvasState {
  readonly window: PlainTextOutputWindow;
}

const MAXIMUM_PLAIN_TEXT_CACHE_ENTRIES = 512;
const MAXIMUM_PLAIN_TEXT_CACHE_WEIGHT = 16 * 1_024 * 1_024;
const outputWindows = new WeightedRecentCache<ThreadOutput, PlainTextOutputCacheEntry>(
  MAXIMUM_PLAIN_TEXT_CACHE_ENTRIES,
  MAXIMUM_PLAIN_TEXT_CACHE_WEIGHT,
);
const canvasStates = new WeakMap<HTMLPreElement, PlainTextOutputCanvasState>();

export function PlainTextOutput(props: { readonly output: ThreadOutput; readonly text: string }) {
  let canvasElement: HTMLPreElement | undefined;
  let outputWindow: PlainTextOutputWindow | undefined;

  createEffect(() => {
    const nextWindow = readPlainTextOutputWindow(props.output, props.text);
    outputWindow = nextWindow;
    if (canvasElement !== undefined) {
      canvasElement = nextWindow.renderInto(canvasElement);
    }
  });
  onCleanup(() => {
    if (canvasElement !== undefined) {
      releasePlainTextOutputCanvas(canvasElement);
    }
  });

  return (
    <pre
      class="command-card-output"
      ref={(element) => {
        canvasElement = element;
        queueMicrotask(() => {
          if (
            canvasElement === element &&
            outputWindow !== undefined &&
            element.parentNode !== null
          ) {
            canvasElement = outputWindow.renderInto(element);
          }
        });
      }}
    />
  );
}

class PlainTextOutputWindow {
  readonly #presentations: HTMLPreElement[];
  readonly #text: string;

  constructor(text: string) {
    this.#text = text;
    this.#presentations = [this.#createPresentation()];
  }

  renderInto(canvas: HTMLPreElement): HTMLPreElement {
    const previousState = canvasStates.get(canvas);
    if (previousState?.window === this) {
      return canvas;
    }
    if (canvas.parentNode === null) {
      throw new Error("A plain-text output canvas must be attached before it can render.");
    }
    const presentation = this.#presentations.pop() ?? this.#createPresentation();
    canvas.replaceWith(presentation);
    canvasStates.delete(canvas);
    if (previousState !== undefined) {
      previousState.window.#releasePresentation(canvas);
    }
    canvasStates.set(presentation, { window: this });
    return presentation;
  }

  releaseCanvas(canvas: HTMLPreElement): void {
    if (canvasStates.get(canvas)?.window !== this) {
      return;
    }
    canvasStates.delete(canvas);
    this.#releasePresentation(canvas);
  }

  #createPresentation(): HTMLPreElement {
    const presentation = document.createElement("pre");
    presentation.className = "command-card-output";
    presentation.textContent = this.#text;
    return presentation;
  }

  #releasePresentation(presentation: HTMLPreElement): void {
    presentation.remove();
    if (this.#presentations.length === 0) {
      this.#presentations.push(presentation);
    }
  }
}

function readPlainTextOutputWindow(output: ThreadOutput, text: string): PlainTextOutputWindow {
  const cached = outputWindows.read(output);
  if (cached !== null && cached.text === text) {
    return cached.window;
  }
  const outputWindow = new PlainTextOutputWindow(text);
  outputWindows.write(output, { text, window: outputWindow }, Math.max(1, text.length * 2 + 128));
  return outputWindow;
}

function releasePlainTextOutputCanvas(canvas: HTMLPreElement): void {
  canvasStates.get(canvas)?.window.releaseCanvas(canvas);
}
