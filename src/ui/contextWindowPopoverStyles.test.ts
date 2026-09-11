import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const styles = readFileSync(new URL("../styles/global.css", import.meta.url), "utf8");

function popoverBlock(): string {
  const start = styles.indexOf(".context-window-popover {");
  const end = styles.indexOf("}", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return styles.slice(start, end);
}

describe("context window popover layout", () => {
  it("keeps the tooltip content inside its card for long cache copy", () => {
    const block = popoverBlock();
    expect(block).toMatch(/min-width:\s*168px/u);
    expect(block).toMatch(/max-width:\s*220px/u);
    expect(block).toMatch(/width:\s*max-content/u);
    expect(block).toMatch(/box-sizing:\s*border-box/u);
    expect(block).not.toMatch(/white-space:\s*nowrap/u);
    expect(block).toMatch(/overflow-wrap:\s*anywhere/u);
  });

  it("keeps the cache line visually separated from the token totals", () => {
    const start = styles.indexOf(".context-window-popover-cache {");
    const end = styles.indexOf("}", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(styles.slice(start, end)).toMatch(/margin-top:\s*2px/u);
  });
});

describe("settings navigation layout", () => {
  it("keeps the back control in the titlebar strip clear of drag", () => {
    const navStart = styles.indexOf(".settings-nav {");
    const navEnd = styles.indexOf("}", navStart);
    const slotStart = styles.indexOf(".settings-titlebar-slot {");
    const slotEnd = styles.indexOf("}", slotStart);
    const backStart = styles.indexOf(".settings-back {");
    const backEnd = styles.indexOf("}", backStart);
    const dragStart = styles.indexOf(".window-chrome-drag-region {");
    const dragEnd = styles.indexOf("}", dragStart);
    expect(styles.slice(navStart, navEnd)).toMatch(/position:\s*relative/u);
    expect(styles.slice(slotStart, slotEnd)).toMatch(/position:\s*absolute/u);
    expect(styles.slice(slotStart, slotEnd)).toMatch(/height:\s*var\(--app-titlebar-height\)/u);
    expect(styles.slice(backStart, backEnd)).toMatch(/height:\s*26px/u);
    expect(styles.slice(dragStart, dragEnd)).toMatch(/inset:\s*0 138px 0 168px/u);
  });

  it("keeps a clear gap between search and the section list", () => {
    const searchStart = styles.indexOf(".settings-search {");
    const searchEnd = styles.indexOf("}", searchStart);
    expect(styles.slice(searchStart, searchEnd)).toMatch(/height:\s*var\(--height-token-row\)/u);
    expect(styles.slice(searchStart, searchEnd)).toMatch(
      /margin:\s*var\(--titlebar-content-gap\) 0 var\(--interactive-list-gap\)/u,
    );
    expect(styles.slice(searchStart, searchEnd)).toMatch(/justify-content:\s*center/u);
  });

  it("reuses the chat list gap token for settings navigation density", () => {
    const navStart = styles.indexOf("\n.settings-nav nav {");
    const navEnd = styles.indexOf("}", navStart);
    expect(styles.slice(navStart, navEnd)).toMatch(/gap:\s*var\(--interactive-list-gap\)/u);
    expect(styles.slice(navStart, navEnd)).not.toMatch(/gap:\s*12px/u);
    const backStart = styles.indexOf(".settings-back {");
    const backEnd = styles.indexOf("}", backStart);
    expect(styles.slice(backStart, backEnd)).toMatch(/height:\s*26px/u);
    const itemStart = styles.indexOf(".settings-nav nav button {");
    const itemEnd = styles.indexOf("}", itemStart);
    expect(styles.slice(itemStart, itemEnd)).toMatch(/height:\s*var\(--height-token-row\)/u);
    expect(styles.slice(itemStart, itemEnd)).toMatch(/padding:\s*0 var\(--padding-row-x\)/u);
  });
});

describe("shell brand stacking", () => {
  it("keeps product brand under settings and below window chrome", () => {
    expect(styles).toMatch(/--layer-app-brand:\s*19500/u);
    expect(styles).toMatch(/--layer-settings:\s*19600/u);
    expect(styles).toMatch(/--layer-window-chrome:\s*20000/u);
    const slot = styles.indexOf(".shell-brand-slot {");
    const slotEnd = styles.indexOf("}", slot);
    expect(styles.slice(slot, slotEnd)).toMatch(/z-index:\s*var\(--layer-app-brand\)/u);
  });

  it("keeps primary actions clear of the titlebar brand", () => {
    expect(styles).toMatch(/--titlebar-content-gap:\s*14px/u);
    expect(styles).toMatch(
      /\.sidebar-titlebar\.chrome-owns-brand \+ \.sidebar-primary-nav\s*\{\s*padding-top:\s*var\(--titlebar-content-gap\);/u,
    );
  });

  it("aligns the brand and section labels with sidebar row gutters", () => {
    const slot = styles.indexOf(".shell-brand-slot {");
    const slotEnd = styles.indexOf("}", slot);
    expect(styles.slice(slot, slotEnd)).toMatch(/padding-left:\s*var\(--padding-row-x\)/u);
    const heading = styles.indexOf("\n.sidebar-section-heading {");
    const headingEnd = styles.indexOf("}", heading);
    expect(styles.slice(heading, headingEnd)).toMatch(/padding:\s*0 4px/u);
  });
});
