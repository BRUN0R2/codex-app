/** Includes native scroll handlers in frame work, even when no animation callback is scheduled. */
export function observeTimelineScrollWork(timeline: HTMLElement): {
  readonly takeDuration: () => number;
  readonly dispose: () => void;
} {
  let started = 0;
  let duration = 0;
  const begin = () => {
    started = performance.now();
  };
  const end = () => {
    duration += performance.now() - started;
  };
  timeline.addEventListener("scroll", begin, { capture: true });
  timeline.addEventListener("scroll", end);
  return {
    takeDuration() {
      const measured = duration;
      duration = 0;
      return measured;
    },
    dispose() {
      timeline.removeEventListener("scroll", begin, true);
      timeline.removeEventListener("scroll", end);
    },
  };
}

/** Detects geometry reads after DOM mutation in the native scroll task. */
export async function probeTimelineScrollCommit(timeline: HTMLElement): Promise<{
  readonly synchronousMutations: number;
  readonly geometryReadsAfterMutation: number;
  readonly rangeChanged: boolean;
}> {
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await frame();
  await frame();
  const list = timeline.querySelector(".agent-activity-virtual-list");
  const previousStart = list?.getAttribute("data-virtual-activity-start");
  const maximum = timeline.scrollHeight - timeline.clientHeight;
  const target = maximum * (timeline.scrollTop < maximum / 2 ? 0.75 : 0.25);
  let observedMutations = 0;
  let measuring = false;
  let geometryReadsAfterMutation = 0;
  const scrollProperty = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");
  if (scrollProperty?.get === undefined || scrollProperty.set === undefined) {
    throw new Error("The native scroll-position accessor is missing.");
  }
  const readScrollTop = scrollProperty.get.bind(timeline);
  const writeScrollTop = scrollProperty.set.bind(timeline);
  const observer = new MutationObserver((records) => {
    observedMutations += records.length;
  });
  observer.observe(timeline, { attributes: true, childList: true, subtree: true });
  Object.defineProperty(timeline, "scrollTop", {
    configurable: true,
    get() {
      observedMutations += observer.takeRecords().length;
      if (measuring && observedMutations > 0) geometryReadsAfterMutation += 1;
      return readScrollTop();
    },
    set(value: number) {
      writeScrollTop(value);
    },
  });
  const begin = () => {
    observer.takeRecords();
    observedMutations = 0;
    measuring = true;
  };
  timeline.addEventListener("scroll", begin, { capture: true, once: true });
  let listener: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const measured = new Promise<number>((resolve, reject) => {
      listener = () => {
        measuring = false;
        resolve(observedMutations + observer.takeRecords().length);
      };
      timeline.addEventListener("scroll", listener, { once: true });
      timeout = setTimeout(
        () => reject(new Error("The timeline scroll probe did not move.")),
        3000,
      );
    });
    timeline.scrollTop = target;
    const synchronousMutations = await measured;
    await frame();
    await frame();
    return {
      synchronousMutations,
      geometryReadsAfterMutation,
      rangeChanged: list?.getAttribute("data-virtual-activity-start") !== previousStart,
    };
  } finally {
    observer.disconnect();
    Reflect.deleteProperty(timeline, "scrollTop");
    timeline.removeEventListener("scroll", begin, true);
    if (listener !== undefined) timeline.removeEventListener("scroll", listener);
    clearTimeout(timeout);
  }
}

/** Establishes a settled origin before frame-interval instrumentation begins. */
export async function settleTimelineScrollBeforeMeasurement(timeline: HTMLElement): Promise<void> {
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  timeline.scrollTop = 0;
  await frame();
  await frame();
}
