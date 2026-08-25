import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";

import { createTimelineDisclosureStore } from "./timelineDisclosure";
import {
  timelineDisclosureChildKey,
  timelineDisclosureStorageKey,
} from "./timelineDisclosureContext";

describe("timeline disclosure state", () => {
  it("lets an explicit choice override the live fallback", () => {
    createRoot((dispose) => {
      const disclosures = createTimelineDisclosureStore();
      const turnKey = timelineDisclosureStorageKey("thread:test", "turn:1");

      expect(disclosures.read(turnKey, true)).toBe(true);
      expect(disclosures.read(turnKey, false)).toBe(false);

      disclosures.setOpen(turnKey, true);
      expect(disclosures.read(turnKey, false)).toBe(true);

      disclosures.setOpen(turnKey, false);
      expect(disclosures.read(turnKey, true)).toBe(false);
      dispose();
    });
  });

  it("keeps independent state for commands and file diffs", () => {
    createRoot((dispose) => {
      const disclosures = createTimelineDisclosureStore();
      const commandKey = timelineDisclosureStorageKey("thread:test", "command:1");
      const otherCommandKey = timelineDisclosureStorageKey("thread:test", "command:2");
      const changeKey = timelineDisclosureStorageKey("thread:test", "change:1:0");

      disclosures.setOpen(commandKey, true);
      disclosures.setOpen(changeKey, false);

      expect(disclosures.read(commandKey)).toBe(true);
      expect(disclosures.read(changeKey, true)).toBe(false);
      expect(disclosures.read(otherCommandKey)).toBe(false);
      dispose();
    });
  });

  it("clears an entire disclosure subtree when its parent closes", () => {
    createRoot((dispose) => {
      const disclosures = createTimelineDisclosureStore();
      const parentKey = timelineDisclosureStorageKey("thread:one", "file-change:1");
      const childKey = timelineDisclosureChildKey(parentKey, "change:1:0");
      const unrelatedKey = timelineDisclosureStorageKey("thread:one", "command:2");

      disclosures.setOpen(parentKey, true);
      disclosures.setOpen(childKey, true);
      disclosures.setOpen(unrelatedKey, true);
      disclosures.setOpen(parentKey, false);

      expect(disclosures.read(parentKey)).toBe(false);
      expect(disclosures.read(childKey)).toBe(false);
      expect(disclosures.read(childKey, true)).toBe(true);
      expect(disclosures.read(unrelatedKey)).toBe(true);
      dispose();
    });
  });

  it("updates a leaf without disturbing a large sibling index", () => {
    createRoot((dispose) => {
      const disclosures = createTimelineDisclosureStore();
      const parent = timelineDisclosureStorageKey("thread:wide", "activity:1");
      const childKeys = Array.from({ length: 10_000 }, (_, index) =>
        timelineDisclosureChildKey(parent, `change:${index}`),
      );
      for (const child of childKeys) {
        disclosures.setOpen(child, true);
      }

      const selected = childKeys[5_000];
      if (selected === undefined) {
        throw new Error("The disclosure fixture did not create its selected child.");
      }
      disclosures.setOpen(selected, false);

      expect(disclosures.read(selected, true)).toBe(false);
      expect(disclosures.countOpenDescendants(parent)).toBe(9_999);
      expect(disclosures.subtreeRevision(parent)).toBe(0);
      dispose();
    });
  });

  it("counts only open descendants inside one disclosure subtree", () => {
    createRoot((dispose) => {
      const disclosures = createTimelineDisclosureStore();
      const parentKey = timelineDisclosureStorageKey("thread:one", "activity:1");
      const firstChild = timelineDisclosureChildKey(parentKey, "command:1");
      const secondChild = timelineDisclosureChildKey(parentKey, "tool:2");
      const unrelated = timelineDisclosureStorageKey("thread:one", "activity:2");

      disclosures.setOpen(parentKey, true);
      disclosures.setOpen(firstChild, true);
      disclosures.setOpen(secondChild, true);
      disclosures.setOpen(unrelated, true);

      expect(disclosures.countOpenDescendants(parentKey)).toBe(2);
      disclosures.setOpen(parentKey, false);
      expect(disclosures.countOpenDescendants(parentKey)).toBe(0);
      expect(disclosures.subtreeRevision(parentKey)).toBe(1);
      dispose();
    });
  });

  it("indexes large disclosure subtrees and revises them only when descendants are cleared", () => {
    createRoot((dispose) => {
      const disclosures = createTimelineDisclosureStore();
      const parent = timelineDisclosureStorageKey("thread:large", "activity:1");
      const childKeys = Array.from({ length: 1_000 }, (_, index) =>
        timelineDisclosureChildKey(parent, `change:${index}`),
      );
      for (const child of childKeys) {
        disclosures.setOpen(child, true);
      }

      expect(disclosures.countOpenDescendants(parent)).toBe(1_000);
      expect(disclosures.subtreeRevision(parent)).toBe(0);
      disclosures.setOpen(parent, false);
      expect(disclosures.countOpenDescendants(parent)).toBe(0);
      expect(disclosures.subtreeRevision(parent)).toBe(1);
      expect(disclosures.read(childKeys[500] ?? parent)).toBe(false);
      dispose();
    });
  });

  it("isolates identical disclosure keys between timeline conversations", () => {
    createRoot((dispose) => {
      const disclosures = createTimelineDisclosureStore();
      const firstThreadKey = timelineDisclosureStorageKey("thread:one", "command:1");
      const secondThreadKey = timelineDisclosureStorageKey("thread:two", "command:1");

      disclosures.setOpen(firstThreadKey, true);

      expect(disclosures.read(firstThreadKey)).toBe(true);
      expect(disclosures.read(secondThreadKey)).toBe(false);
      dispose();
    });
  });

  it("encodes namespace boundaries without ambiguous concatenation", () => {
    expect(timelineDisclosureStorageKey("ab", "c")).not.toBe(
      timelineDisclosureStorageKey("a", "bc"),
    );
  });
});
