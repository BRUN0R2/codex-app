import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import type { FileChange } from "../contracts/types";
import { useI18n } from "../i18n/context";

import { type DiffDisplayMode, DiffView } from "./DiffView";
import {
  ReviewDocumentStore,
  type ReviewFileDocument,
  summarizeReviewDocuments,
} from "./reviewChanges";

const FILE_BADGE_EXTENSION_LIMIT: number = 3;

interface ReviewPanelProps {
  readonly changes: readonly FileChange[];
  readonly mode: DiffDisplayMode;
}

export function ReviewPanel(props: ReviewPanelProps) {
  const i18n = useI18n();
  const documentStore = new ReviewDocumentStore();
  const documents = createMemo(() => documentStore.project(props.changes));
  const stats = createMemo(() => summarizeReviewDocuments(documents()));
  const [selectedPath, setSelectedPath] = createSignal<string | null>(null);
  const selected = createMemo<ReviewFileDocument | null>(
    () =>
      documents().find((entry) => entry.change.path === selectedPath()) ?? documents()[0] ?? null,
  );

  createEffect(() => {
    const current = selected();
    setSelectedPath((path) =>
      current === null || path === current.change.path ? path : current.change.path,
    );
  });

  return (
    <section aria-label={i18n.messages().review.label} class="review-panel" id="turn-review-panel">
      <div class="review-panel-toolbar">
        <div class="review-panel-summary">
          <strong>{i18n.messages().review.lastTurn}</strong>
          <span>
            {stats().fileCount}{" "}
            {stats().fileCount === 1
              ? i18n.messages().common.changedFile
              : i18n.messages().common.changedFiles}
          </span>
          <Show when={stats().additions > 0}>
            <span class="review-stat additions">+{stats().additions}</span>
          </Show>
          <Show when={stats().deletions > 0}>
            <span class="review-stat deletions">−{stats().deletions}</span>
          </Show>
        </div>
      </div>

      <div class="review-panel-content">
        <nav aria-label={i18n.messages().review.changedFiles} class="review-file-list">
          <For each={documents()}>
            {(entry) => (
              <button
                aria-current={selected()?.change.path === entry.change.path ? "true" : undefined}
                class="review-file-option"
                classList={{ selected: selected()?.change.path === entry.change.path }}
                onClick={() => setSelectedPath(entry.change.path)}
                title={entry.change.path}
                type="button"
              >
                <span class="review-file-type">{fileType(entry.change.path, i18n.locale())}</span>
                <code>{entry.change.path}</code>
                <Show when={entry.change.kind.type !== "update"}>
                  <span class={`change-kind kind-${entry.change.kind.type}`}>
                    {entry.change.kind.type === "add"
                      ? i18n.messages().common.new
                      : i18n.messages().common.deleted}
                  </span>
                </Show>
                <Show when={entry.stats.additions > 0}>
                  <span class="review-stat additions">+{entry.stats.additions}</span>
                </Show>
                <Show when={entry.stats.deletions > 0}>
                  <span class="review-stat deletions">−{entry.stats.deletions}</span>
                </Show>
              </button>
            )}
          </For>
        </nav>

        <section class="review-file-stage">
          <Show
            when={selected()}
            fallback={<div class="diff-empty-state">{i18n.messages().review.noFiles}</div>}
          >
            {(entry) => (
              <>
                <header class="review-file-header">
                  <code title={entry().change.path}>{entry().change.path}</code>
                  <Show when={entry().stats.additions > 0}>
                    <span class="review-stat additions">+{entry().stats.additions}</span>
                  </Show>
                  <Show when={entry().stats.deletions > 0}>
                    <span class="review-stat deletions">−{entry().stats.deletions}</span>
                  </Show>
                </header>
                <Show
                  when={entry().document.unifiedRows.length > 0}
                  fallback={<div class="diff-empty-state">{i18n.messages().review.noTextDiff}</div>}
                >
                  <DiffView
                    document={entry().document}
                    mode={props.mode}
                    path={entry().change.path}
                    viewportSizing="container"
                  />
                </Show>
              </>
            )}
          </Show>
        </section>
      </div>
    </section>
  );
}

function fileType(path: string, locale: string): string {
  const file = path.split(/[\\/]/u).at(-1) ?? path;
  const extension = file.includes(".") ? file.split(".").at(-1) : null;
  return extension?.slice(0, FILE_BADGE_EXTENSION_LIMIT).toLocaleUpperCase(locale) ?? "FILE";
}
