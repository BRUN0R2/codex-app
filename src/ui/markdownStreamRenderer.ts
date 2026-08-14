import { marked } from "marked";

export interface MarkdownRenderUpdate {
  readonly appendHtml: string;
  readonly reset: boolean;
  readonly tailHtml: string;
}

export interface MarkdownStreamRenderer {
  readonly finalize: (source: string, html: string) => MarkdownRenderUpdate;
  readonly render: (source: string, streaming: boolean) => MarkdownRenderUpdate;
}

export function createMarkdownStreamRenderer(
  renderHtml: (source: string) => string,
): MarkdownStreamRenderer {
  let committedSource = "";
  let finalized = false;

  function finalize(source: string, html: string): MarkdownRenderUpdate {
    committedSource = normalizeMarkdown(source);
    finalized = true;
    return { appendHtml: html, reset: true, tailHtml: "" };
  }

  return {
    finalize,
    render(source, streaming) {
      const normalized = normalizeMarkdown(source);
      if (!streaming) {
        return finalize(normalized, renderHtml(normalized));
      }

      const reset = finalized || !normalized.startsWith(committedSource);
      if (reset) {
        committedSource = "";
        finalized = false;
      }
      const remainder = normalized.slice(committedSource.length);
      const tokens = marked.lexer(remainder, { gfm: true });
      const stableSource = tokens
        .slice(0, -1)
        .map((token) => token.raw)
        .join("");
      committedSource += stableSource;
      const tailSource = normalized.slice(committedSource.length);
      return {
        appendHtml: stableSource.length === 0 ? "" : renderHtml(stableSource),
        reset,
        tailHtml: tailSource.length === 0 ? "" : renderHtml(tailSource),
      };
    },
  };
}

function normalizeMarkdown(source: string): string {
  return source.replace(/^[\u200B-\u200F\uFEFF]/u, "");
}
