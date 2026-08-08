import { createMemo, For, Show } from "solid-js";

import type { FileChange } from "../contracts/types";

import { Icon } from "./Icon";
import { summarizeReviewChanges } from "./reviewChanges";
import { summarizeDiff, UnifiedDiffView } from "./SplitDiffView";

interface ReviewPanelProps {
  readonly changes: readonly FileChange[];
  readonly onClose: () => void;
}

export function ReviewPanel(props: ReviewPanelProps) {
  const stats = createMemo(() => summarizeReviewChanges(props.changes));

  return (
    <aside aria-label="Revisão dos arquivos alterados" class="review-panel" id="turn-review-panel">
      <header class="review-panel-titlebar">
        <div>
          <Icon name="file" size={14} />
          <strong>Revisão</strong>
        </div>
        <button aria-label="Fechar revisão" onClick={props.onClose} title="Fechar" type="button">
          <Icon name="close" size={14} />
        </button>
      </header>

      <div class="review-panel-toolbar">
        <div class="review-panel-summary">
          <strong>Último turno</strong>
          <span>
            {stats().fileCount}{" "}
            {stats().fileCount === 1 ? "arquivo alterado" : "arquivos alterados"}
          </span>
          <span class="review-stat additions">+{stats().additions}</span>
          <span class="review-stat deletions">−{stats().deletions}</span>
        </div>
      </div>

      <div class="review-panel-files">
        <For each={props.changes}>
          {(change) => <ReviewFile change={change} defaultOpen={props.changes.length <= 25} />}
        </For>
      </div>
    </aside>
  );
}

function ReviewFile(props: { readonly change: FileChange; readonly defaultOpen: boolean }) {
  const stats = createMemo(() => summarizeDiff(props.change.diff));
  return (
    <details
      class="review-file"
      data-kind={props.change.kind.type}
      open={props.defaultOpen && props.change.kind.type !== "delete"}
    >
      <summary>
        <span class="review-file-type">{fileType(props.change.path)}</span>
        <code title={props.change.path}>{props.change.path}</code>
        <Show when={props.change.kind.type !== "update"}>
          <span class={`change-kind kind-${props.change.kind.type}`}>
            {props.change.kind.type === "add" ? "NOVO" : "EXCLUÍDO"}
          </span>
        </Show>
        <span class="review-stat additions">+{stats().additions}</span>
        <span class="review-stat deletions">−{stats().deletions}</span>
        <span aria-hidden="true" class="review-file-chevron">
          <Icon name="chevronDown" size={12} />
        </span>
      </summary>
      <Show
        when={props.change.diff.length > 0}
        fallback={<div class="diff-empty-state">O engine não forneceu um diff textual.</div>}
      >
        <UnifiedDiffView diff={props.change.diff} path={props.change.path} />
      </Show>
    </details>
  );
}

function fileType(path: string): string {
  const file = path.split(/[\\/]/u).at(-1) ?? path;
  const extension = file.includes(".") ? file.split(".").at(-1) : null;
  return extension?.slice(0, 3).toLocaleUpperCase("pt-BR") ?? "FILE";
}
