export interface ViewportVisualAnchorSearch {
  readonly isAnchorCandidate?: ((index: number) => boolean) | undefined;
  readonly itemCount: number;
  readonly readItemBounds: (index: number) => {
    readonly bottom: number;
    readonly top: number;
  };
  readonly viewportBottom: number;
  readonly viewportTop: number;
}

export function findViewportVisualAnchorIndex(input: ViewportVisualAnchorSearch): number | null {
  if (
    !Number.isInteger(input.itemCount) ||
    input.itemCount < 0 ||
    !Number.isFinite(input.viewportTop) ||
    !Number.isFinite(input.viewportBottom) ||
    input.viewportBottom < input.viewportTop
  ) {
    throw new Error("Viewport visual anchor bounds must be finite and ordered.");
  }
  let firstIntersectingIndex: number | null = null;
  for (let index = 0; index < input.itemCount; index += 1) {
    if (input.isAnchorCandidate?.(index) === false) {
      continue;
    }
    const bounds = input.readItemBounds(index);
    if (!Number.isFinite(bounds.top) || !Number.isFinite(bounds.bottom)) {
      throw new Error("Viewport visual item bounds must be finite.");
    }
    if (bounds.bottom <= input.viewportTop || bounds.top >= input.viewportBottom) {
      continue;
    }
    firstIntersectingIndex ??= index;
    if (bounds.top >= input.viewportTop) {
      return index;
    }
  }
  return firstIntersectingIndex;
}
