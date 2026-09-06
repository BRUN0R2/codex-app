import { createTimelineDisclosureStore } from "../src/ui/timelineDisclosure.ts";
import {
  timelineDisclosureChildKey,
  timelineDisclosureStorageKey,
} from "../src/ui/timelineDisclosureContext.ts";

const DISCLOSURE_COUNT = 100_000;
const MAXIMUM_RETAINED_BYTES = 28 * 1_024 * 1_024;
const collect = globalThis.gc;
if (collect === undefined) {
  throw new Error("The disclosure memory benchmark requires --expose-gc.");
}
collect();
const baseline = process.memoryUsage().heapUsed;
const disclosures = createTimelineDisclosureStore();
const parent = timelineDisclosureStorageKey("thread:soak", "activity:files");
for (let index = 0; index < DISCLOSURE_COUNT; index += 1) {
  disclosures.setOpen(timelineDisclosureChildKey(parent, `change:${index}`), true);
}
collect();
const retainedBytes = process.memoryUsage().heapUsed - baseline;
if (disclosures.countOpenDescendants(parent) !== DISCLOSURE_COUNT) {
  throw new Error("The disclosure memory benchmark lost expanded items.");
}
console.log(JSON.stringify({ disclosureCount: DISCLOSURE_COUNT, retainedBytes }));
if (retainedBytes > MAXIMUM_RETAINED_BYTES) {
  throw new Error(`Disclosure state retained ${retainedBytes} bytes, above ${MAXIMUM_RETAINED_BYTES}.`);
}
