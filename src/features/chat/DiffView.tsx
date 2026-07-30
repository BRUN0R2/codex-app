import { For, Show, createMemo, createSignal } from "solid-js";

import { countUnifiedDiffLines, parseUnifiedDiff } from "./diffParser";

interface DiffViewProps {
  diff: string;
}

export function DiffView(props: DiffViewProps) {
  const [showAll, setShowAll] = createSignal(false);
  const lineCount = createMemo(() => countUnifiedDiffLines(props.diff));
  const lines = createMemo(() =>
    parseUnifiedDiff(
      props.diff,
      showAll() ? Number.POSITIVE_INFINITY : MAX_INITIAL_DIFF_LINES,
    ),
  );

  return (
    <div class="diff-view">
      <Show
        when={lines().length > 0}
        fallback={<div class="diff-empty">Diff não disponível.</div>}
      >
        <table>
          <tbody>
            <For each={lines()}>
              {(line) => (
                <tr class={`diff-line diff-${line.kind}`}>
                  <td class="diff-line-number">{line.oldLine ?? ""}</td>
                  <td class="diff-line-number">{line.newLine ?? ""}</td>
                  <td class="diff-line-marker">
                    {line.kind === "addition"
                      ? "+"
                      : line.kind === "deletion"
                        ? "−"
                        : ""}
                  </td>
                  <td class="diff-line-content">{line.text || " "}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
        <Show when={!showAll() && lineCount() > MAX_INITIAL_DIFF_LINES}>
          <button
            class="diff-show-all"
            onClick={() => setShowAll(true)}
            type="button"
          >
            Mostrar mais {lineCount() - MAX_INITIAL_DIFF_LINES} linhas
          </button>
        </Show>
      </Show>
    </div>
  );
}

const MAX_INITIAL_DIFF_LINES = 400;
