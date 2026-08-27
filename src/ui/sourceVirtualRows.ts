import type { FixedRowVirtualRange } from "./fixedRowVirtualization";
import { escapeHtml, syntaxLineToHtml } from "./syntax/render";
import type { SourceOutputProjection } from "./toolOutputProjection";
import { createFixedVirtualRowsCanvas, VirtualRowsWindow } from "./virtualRowsWindow";

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
    const tokens = projection.tokensAt(rowIndex);
    const content = tokens === null ? escapeHtml(line.content) : syntaxLineToHtml(tokens);
    markup += `<div aria-rowindex="${rowIndex + 1}" class="tool-source-line" role="row"><div class="tool-source-line-number" role="rowheader">${line.number}</div><div class="tool-source-code-cell" role="cell"><code>${content}</code></div></div>`;
  }
  const rows = new VirtualRowsWindow({
    owner: projection,
    template: createFixedVirtualRowsCanvas({
      className: "tool-source-virtual-canvas",
      firstRowTop: range.offset,
      rowHeight,
      rowMarkup: markup,
      totalHeight: range.physicalTotalSize,
    }),
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
