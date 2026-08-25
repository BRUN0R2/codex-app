import type { FixedRowVirtualRange } from "./fixedRowVirtualization";
import { escapeHtml, syntaxLineToHtml } from "./syntax/render";
import type { SourceOutputProjection } from "./toolOutputProjection";
import { VirtualRowsWindow } from "./virtualRowsWindow";

const MAXIMUM_WINDOWS_PER_PROJECTION = 16;
const rowsByProjection = new WeakMap<SourceOutputProjection, Map<string, VirtualRowsWindow>>();

export function readSourceVirtualRows(
  projection: SourceOutputProjection,
  range: FixedRowVirtualRange,
  rowHeight: number,
): VirtualRowsWindow {
  const key = `${range.start}\u0000${range.end}\u0000${Math.round(range.offset)}\u0000${rowHeight}`;
  const cache = readProjectionCache(projection);
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  let markup = "";
  for (let rowIndex = range.start; rowIndex < range.end; rowIndex += 1) {
    const line = projection.lines[rowIndex];
    if (line === undefined) {
      throw new Error(`A linha de código ${rowIndex} não existe.`);
    }
    const top = range.offset + (rowIndex - range.start) * rowHeight;
    const tokens = projection.tokensAt(rowIndex);
    const content = tokens === null ? escapeHtml(line.content) : syntaxLineToHtml(tokens);
    markup += `<tr aria-rowindex="${rowIndex + 1}" class="tool-source-line" style="top:${Math.round(top)}px"><th class="tool-source-line-number" scope="row">${line.number}</th><td><code>${content}</code></td></tr>`;
  }
  const rows = new VirtualRowsWindow({
    owner: projection,
    template: parseRows(markup, range.physicalTotalSize),
    variant: `source\u0000${rowHeight}`,
  });
  cache.set(key, rows);
  while (cache.size > MAXIMUM_WINDOWS_PER_PROJECTION) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      throw new Error("O cache de janelas de leitura perdeu sua entrada mais antiga.");
    }
    cache.delete(oldest);
  }
  return rows;
}

function readProjectionCache(projection: SourceOutputProjection): Map<string, VirtualRowsWindow> {
  let cache = rowsByProjection.get(projection);
  if (cache === undefined) {
    cache = new Map();
    rowsByProjection.set(projection, cache);
  }
  return cache;
}

function parseRows(markup: string, totalHeight: number): HTMLTableSectionElement {
  const template = document.createElement("template");
  template.innerHTML = `<table><tbody class="tool-source-virtual-canvas" style="height:${totalHeight}px">${markup}</tbody></table>`;
  const body = template.content.querySelector("tbody");
  if (body === null) {
    throw new Error("O navegador não materializou as linhas virtuais da leitura.");
  }
  return body;
}
