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
import { type VirtualRowsLease, VirtualRowsPool } from "./virtualRowsPool";

export type DiffVirtualRowsMode = "split" | "unified";

const MAXIMUM_WINDOWS_PER_DOCUMENT = 16;
const highlighter = new DiffSyntaxHighlighter();
const rowsByDocument = new WeakMap<DiffDocument, Map<string, VirtualRowsPool>>();

export function acquireDiffVirtualRows(input: {
  readonly document: DiffDocument;
  readonly mode: DiffVirtualRowsMode;
  readonly path: string;
  readonly range: DiffVirtualRange;
}): VirtualRowsLease {
  const key = `${input.path}\u0000${input.mode}\u0000${input.range.start}\u0000${input.range.end}\u0000${Math.round(input.range.offsetTop)}`;
  const cache = readDocumentCache(input.document);
  const cached = cache.get(key);
  if (cached !== undefined) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.acquire();
  }
  const markup = input.mode === "split" ? renderSplitRows(input) : renderUnifiedRows(input);
  const pool = new VirtualRowsPool(parseRows(markup, input.range.totalHeight));
  cache.set(key, pool);
  while (cache.size > MAXIMUM_WINDOWS_PER_DOCUMENT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      throw new Error("O cache de janelas de diff perdeu sua entrada mais antiga.");
    }
    cache.delete(oldest);
  }
  return pool.acquire();
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
  const opening = `<tr aria-rowindex="${rowIndex + 1}" class="diff-virtual-row unified-diff-row is-${row.type}" style="top:${Math.round(top)}px">`;
  if (row.type === "hunk" || row.type === "meta") {
    return `${opening}<td class="unified-diff-hunk" colspan="4">${escapeHtml(row.content)}</td></tr>`;
  }
  const prefix = row.type === "addition" ? "+" : row.type === "deletion" ? "−" : "";
  return `${opening}<th class="diff-line-number old" scope="row">${row.oldNumber ?? ""}</th><th class="diff-line-number new" scope="row">${row.newNumber ?? ""}</th><td aria-hidden="true" class="diff-line-prefix">${prefix}</td><td class="unified-diff-code"><code>${renderSyntaxContent(row.content, tokens)}</code></td></tr>`;
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
  const header = row.leftType === "header";
  const opening = `<tr aria-rowindex="${rowIndex + 1}" class="diff-virtual-row split-diff-row${header ? " is-header" : ""}" style="top:${Math.round(top)}px">`;
  if (header) {
    return `${opening}<td class="split-diff-hunk" colspan="4">${escapeHtml(row.leftContent)}</td></tr>`;
  }
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
  return `${opening}<th class="diff-line-number left" scope="row">${row.leftNumber ?? ""}</th><td class="split-diff-cell left ${row.leftType}"><code>${renderSyntaxContent(row.leftContent, leftTokens)}</code></td><th class="diff-line-number right" scope="row">${row.rightNumber ?? ""}</th><td class="split-diff-cell right ${row.rightType}"><code>${renderSyntaxContent(row.rightContent, rightTokens)}</code></td></tr>`;
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

function readDocumentCache(document: DiffDocument): Map<string, VirtualRowsPool> {
  let cache = rowsByDocument.get(document);
  if (cache === undefined) {
    cache = new Map();
    rowsByDocument.set(document, cache);
  }
  return cache;
}

function parseRows(markup: string, totalHeight: number): HTMLTableSectionElement {
  const template = document.createElement("template");
  template.innerHTML = `<table><tbody class="diff-virtual-canvas" style="height:${totalHeight}px">${markup}</tbody></table>`;
  const body = template.content.querySelector("tbody");
  if (body === null) {
    throw new Error("O navegador não materializou as linhas virtuais do diff.");
  }
  return body;
}
