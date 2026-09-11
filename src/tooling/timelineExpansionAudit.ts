import { batch } from "solid-js";

/** Opens the real delegated controls; no disclosure state or rendered content is injected. */
export async function expandTimelineFileDetails(
  timeline: HTMLElement,
  expectedCount: number,
): Promise<{ readonly expandedCount: number; readonly preparationMs: number }> {
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const started = performance.now();
  const opened = new Set<number>();
  let nextIndex = 0;
  let expandedHeight = 0;
  let stalledIterations = 0;
  const list = timeline.querySelector<HTMLElement>(".agent-activity-virtual-list");
  const first = list?.querySelector<HTMLElement>(".agent-activity-virtual-item");
  if (list === null || list === undefined || first === null || first === undefined) {
    throw new Error("The file expansion audit requires a mounted virtual list.");
  }
  const collapsedHeight = first.getBoundingClientRect().height;
  timeline.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -1 }));

  while (nextIndex < expectedCount) {
    const previousIndex = nextIndex;
    if (performance.now() - started > 600_000) {
      throw new Error(`File expansion stopped at ${nextIndex} of ${expectedCount}.`);
    }
    const controls = [
      ...list.querySelectorAll<HTMLElement>(
        ".agent-activity-virtual-item details:not([open]) > summary",
      ),
    ].map((summary) => {
      const wrapper = summary.closest<HTMLElement>(".agent-activity-virtual-item");
      const match = wrapper?.getAttribute("data-virtual-activity-key")?.match(/module-(\d+)\.ts/);
      if (match === undefined || match === null) {
        throw new Error("An extreme file control has no fixture identity.");
      }
      return { index: Number(match[1]), summary };
    });
    batch(() => {
      for (const { index, summary } of controls) {
        summary.click();
        opened.add(index);
      }
    });
    await frame();
    await frame();
    while (opened.has(nextIndex)) nextIndex += 1;
    const expanded = list.querySelector<HTMLElement>(
      ".agent-activity-virtual-item:has(details[open])",
    );
    if (expanded !== null) expandedHeight = expanded.getBoundingClientRect().height;
    if (expandedHeight <= 0) {
      throw new Error("The file expansion audit did not render an expanded detail.");
    }
    const logicalHeight =
      opened.size * expandedHeight + (expectedCount - opened.size) * collapsedHeight;
    const viewportHeight = timeline.clientHeight;
    const physicalHeight = list.getBoundingClientRect().height;
    const physicalScale = Math.min(
      1,
      (physicalHeight - viewportHeight) / (logicalHeight - viewportHeight),
    );
    const anchors = [...list.querySelectorAll<HTMLElement>(".agent-activity-virtual-item")].map(
      (element) => ({
        element,
        index: Number(
          element.getAttribute("data-virtual-activity-key")?.match(/module-(\d+)\.ts/)?.[1],
        ),
      }),
    );
    const anchor = anchors.reduce(
      (closest, candidate) =>
        closest === undefined ||
        Math.abs(candidate.index - nextIndex) < Math.abs(closest.index - nextIndex)
          ? candidate
          : closest,
      anchors[0],
    );
    if (anchor === undefined || !Number.isInteger(anchor.index)) {
      throw new Error("The file expansion audit lost its scroll anchor.");
    }
    const logicalDelta =
      anchor.element.getBoundingClientRect().top -
      timeline.getBoundingClientRect().top +
      (nextIndex - anchor.index) * expandedHeight;
    timeline.scrollTop += logicalDelta * physicalScale - collapsedHeight;
    await frame();
    await frame();
    stalledIterations = previousIndex === nextIndex ? stalledIterations + 1 : 0;
    if (stalledIterations > 120) {
      throw new Error(
        `File expansion stalled: ${JSON.stringify({
          nextIndex,
          opened: opened.size,
          controls: controls.map((control) => control.index),
          anchors: anchors.map((item) => item.index),
          logicalDelta,
          expandedHeight,
          scrollTop: timeline.scrollTop,
        })}`,
      );
    }
  }
  return { expandedCount: opened.size, preparationMs: performance.now() - started };
}
