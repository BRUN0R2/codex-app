import type {
  DiffDocument,
  SplitDiffProjection,
  SplitDiffRow,
  UnifiedDiffLine,
} from "./diffDocument";
import { DIFF_ROW_HEIGHT_PX, type DiffVirtualRange } from "./diffViewport";
import type { SyntaxLine } from "./syntax/contracts";
import { DiffSyntaxHighlighter } from "./syntax/diffHighlighter";
import { escapeHtml, syntaxLineToHtml } from "./syntax/render";
import { type VirtualRowsCanvas, VirtualRowsWindow } from "./virtualRowsWindow";

export type DiffVirtualRowsMode = "split" | "unified";

const MAXIMUM_WINDOWS_PER_DOCUMENT = 16;
const highlighter = new DiffSyntaxHighlighter();
const rowsByDocument = new WeakMap<DiffDocument, Map<string, VirtualRowsWindow>>();

export function readDiffVirtualRows(input: {
  readonly document: DiffDocument;
  readonly mode: DiffVirtualRowsMode;
  readonly path: string;
  readonly range: DiffVirtualRange;
}): VirtualRowsWindow {
  const key = `${input.path}\u0000${input.mode}\u0000${input.range.start}\u0000${input.range.end}\u0000${Math.round(input.range.offsetTop)}`;
  const cache = readDocumentCache(input.document);
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const markup = input.mode === "split" ? renderSplitRows(input) : renderUnifiedRows(input);
  const rows = new VirtualRowsWindow({
    owner: input.document,
    template: parseRows(markup, input.range.totalHeight),
    variant: `${input.path}\u0000${input.mode}`,
  });
  cache.set(key, rows);
  while (cache.size > MAXIMUM_WINDOWS_PER_DOCUMENT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      throw new Error("O cache de janelas de diff perdeu sua entrada mais antiga.");
    }
    cache.delete(oldest);
  }
  return rows;
}

function renderUnifiedRows(input: {
  readonly document: DiffDocument;
  readonly path: string;
  readonly range: DiffVirtualRange;
}): string {
  let markup = "";
  for (let rowIndex = input.range.start; rowIndex < input.range.end; rowIndex += 1) {
    const row = input.document.unifiedRows[rowIndex];
    if (row === undefined) {
      throw new Error(`A linha unificada ${rowIndex} não existe.`);
    }
    const top = input.range.offsetTop + (rowIndex - input.range.start) * DIFF_ROW_HEIGHT_PX;
    markup += renderUnifiedRow(
      row,
      rowIndex,
      top,
      highlighter.render(input.document, input.path, rowIndex),
    );
  }
  return markup;
}

function renderUnifiedRow(
  row: UnifiedDiffLine,
  rowIndex: number,
  top: number,
  tokens: SyntaxLine | null,
): string {
  const opening = `<div aria-rowindex="${rowIndex + 1}" class="diff-virtual-row unified-diff-row is-${row.type}" role="row" style="top:${Math.round(top)}px">`;
  const lineNumber = row.type === "deletion" ? row.oldNumber : row.newNumber;
  return `${opening}<div class="diff-line-number" role="rowheader"><span class="diff-line-number-content">${lineNumber ?? ""}</span></div><div class="unified-diff-code" role="cell"><code>${renderSyntaxContent(row.content, tokens)}</code></div></div>`;
}

function renderSplitRows(input: {
  readonly document: DiffDocument;
  readonly path: string;
  readonly range: DiffVirtualRange;
}): string {
  const projection = input.document.splitProjection();
  let markup = "";
  for (let rowIndex = input.range.start; rowIndex < input.range.end; rowIndex += 1) {
    const row = projection.rows[rowIndex];
    if (row === undefined) {
      throw new Error(`A linha dividida ${rowIndex} não existe.`);
    }
    const top = input.range.offsetTop + (rowIndex - input.range.start) * DIFF_ROW_HEIGHT_PX;
    markup += renderSplitRow(input.document, input.path, projection, row, rowIndex, top);
  }
  return markup;
}

function renderSplitRow(
  document: DiffDocument,
  path: string,
  projection: SplitDiffProjection,
  row: SplitDiffRow,
  rowIndex: number,
  top: number,
): string {
  const opening = `<div aria-rowindex="${rowIndex + 1}" class="diff-virtual-row split-diff-row" role="row" style="top:${Math.round(top)}px">`;
  const leftTokens = highlighter.render(
    document,
    path,
    readSplitSourceIndex(projection.leftSourceIndexes, rowIndex),
  );
  const rightTokens = highlighter.render(
    document,
    path,
    readSplitSourceIndex(projection.rightSourceIndexes, rowIndex),
  );
  return `${opening}<div class="diff-line-number left" role="rowheader"><span class="diff-line-number-content">${row.leftNumber ?? ""}</span></div><div class="split-diff-cell left ${row.leftType}" role="cell"><code>${renderSyntaxContent(row.leftContent, leftTokens)}</code></div><div class="diff-line-number right" role="rowheader"><span class="diff-line-number-content">${row.rightNumber ?? ""}</span></div><div class="split-diff-cell right ${row.rightType}" role="cell"><code>${renderSyntaxContent(row.rightContent, rightTokens)}</code></div></div>`;
}

function readSplitSourceIndex(indexes: Uint32Array, rowIndex: number): number | null {
  const sourceIndex = indexes[rowIndex];
  if (sourceIndex === undefined) {
    throw new Error(`O índice sintático dividido ${rowIndex} não existe.`);
  }
  return sourceIndex === 0 ? null : sourceIndex - 1;
}

function renderSyntaxContent(content: string, tokens: SyntaxLine | null): string {
  return tokens === null ? escapeHtml(content) : syntaxLineToHtml(tokens);
}

function readDocumentCache(document: DiffDocument): Map<string, VirtualRowsWindow> {
  let cache = rowsByDocument.get(document);
  if (cache === undefined) {
    cache = new Map();
    rowsByDocument.set(document, cache);
  }
  return cache;
}

function parseRows(markup: string, totalHeight: number): VirtualRowsCanvas {
  const template = document.createElement("template");
  template.innerHTML = `<div class="diff-virtual-canvas" role="rowgroup" style="height:${totalHeight}px">${markup}</div>`;
  const canvas = template.content.firstElementChild;
  if (!(canvas instanceof HTMLDivElement) || canvas.nextElementSibling !== null) {
    throw new Error("O navegador não materializou as linhas virtuais do diff.");
  }
  return canvas;
}
