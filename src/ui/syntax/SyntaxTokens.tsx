import { createMemo, Show } from "solid-js";

import type { SyntaxLine } from "./contracts";
import { syntaxLineToHtml } from "./render";

const syntaxLineMarkup = new WeakMap<SyntaxLine, string>();

export function SyntaxTokens(props: {
  readonly content: string;
  readonly tokens: SyntaxLine | null;
}) {
  const highlightedMarkup = createMemo(() => {
    const tokens = props.tokens;
    if (tokens === null) {
      return null;
    }
    const cached = syntaxLineMarkup.get(tokens);
    if (cached !== undefined) {
      return cached;
    }
    const markup = syntaxLineToHtml(tokens);
    syntaxLineMarkup.set(tokens, markup);
    return markup;
  });

  return (
    <Show when={highlightedMarkup()} fallback={props.content}>
      {(markup) => <span class="syntax-line" innerHTML={markup()} />}
    </Show>
  );
}
