import { marked } from "marked";

import { normalizeMarkdownSource } from "./markdownSource";

export interface MarkdownRenderUpdate {
  readonly appendHtml: string;
  readonly reset: boolean;
  readonly tailHtml: string;
}

export type MarkdownRenderMode = "append" | "final";

export interface MarkdownStreamRenderer {
  readonly finalize: (source: string, html: string) => MarkdownRenderUpdate;
  /**
   * Append mode belongs to one logical message stream and requires append-only source updates.
   * Final mode is authoritative and may replace any incremental presentation.
   */
  readonly render: (source: string, mode: MarkdownRenderMode) => MarkdownRenderUpdate;
}

export function createMarkdownStreamRenderer(
  renderHtml: (source: string) => string,
): MarkdownStreamRenderer {
  let committedLength = 0;
  let finalized = false;
  let previousSource = "";

  function finalize(source: string, html: string): MarkdownRenderUpdate {
    previousSource = normalizeMarkdownSource(source);
    committedLength = previousSource.length;
    finalized = true;
    return { appendHtml: html, reset: true, tailHtml: "" };
  }

  return {
    finalize,
    render(source, mode) {
      const normalized = normalizeMarkdownSource(source);
      if (mode === "final") {
        return finalize(normalized, renderHtml(normalized));
      }

      const reset =
        finalized ||
        normalized.length < previousSource.length ||
        (normalized.length === previousSource.length && normalized !== previousSource);
      if (reset) {
        committedLength = 0;
        finalized = false;
      }
      previousSource = normalized;
      const remainder = normalized.slice(committedLength);
      const tokens = marked.lexer(remainder, { gfm: true });
      let stableLength = 0;
      for (let index = 0; index < tokens.length - 1; index += 1) {
        stableLength += tokens[index]?.raw.length ?? 0;
      }
      const stableSource = remainder.slice(0, stableLength);
      committedLength += stableLength;
      const tailSource = normalized.slice(committedLength);
      return {
        appendHtml: stableSource.length === 0 ? "" : renderHtml(stableSource),
        reset,
        tailHtml: tailSource.length === 0 ? "" : renderHtml(tailSource),
      };
    },
  };
}
