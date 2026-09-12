import type { TimelineDisclosureKey } from "./timelineDisclosure";
import type { TimelineDisclosureBinding } from "./timelineDisclosureContext";

export const controlledTimelineDisclosureKeys = new WeakMap<
  HTMLElement,
  () => TimelineDisclosureKey
>();
export const DIFF_COPY_FEEDBACK_RESET_MILLISECONDS = 2_000;
export const ACTIVITY_ITEM_VIRTUALIZATION_THRESHOLD = 48;
export const ACTIVITY_OPEN_DISCLOSURE_VIRTUALIZATION_THRESHOLD = 4;
export const LIVE_OUTPUT_FOLLOW_EPSILON_PX = 24;
export const IMAGE_OUTPUT_PRESENTATION = { type: "image" } as const;

export function bindControlledTimelineDisclosure(
  element: HTMLElement,
  disclosure: TimelineDisclosureBinding,
): void {
  bindControlledTimelineDisclosureKey(element, disclosure.storageKey);
}

export function bindControlledTimelineDisclosureKey(
  element: HTMLElement,
  storageKey: () => TimelineDisclosureKey,
): void {
  controlledTimelineDisclosureKeys.set(element, storageKey);
}
