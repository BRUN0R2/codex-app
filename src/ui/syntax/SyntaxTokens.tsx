import { For, Show } from "solid-js";

import type { SyntaxLine } from "./contracts";
import { syntaxTokenClass } from "./render";

export function SyntaxTokens(props: {
  readonly content: string;
  readonly tokens: SyntaxLine | null;
}) {
  return (
    <Show when={props.tokens} fallback={props.content}>
      {(tokens) => (
        <For each={tokens()}>
          {(token) =>
            token.kind === "text" ? (
              token.text
            ) : (
              <span class={`syntax-token ${syntaxTokenClass(token.kind)}`}>{token.text}</span>
            )
          }
        </For>
      )}
    </Show>
  );
}
