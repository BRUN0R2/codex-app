import { For, Show } from "solid-js";

import {
  ChevronDownIcon,
  ChevronRightIcon,
  EditIcon,
} from "../../shared/components/Icons";
import { diffStats } from "./diffParser";
import { DiffView } from "./DiffView";
import { fileAction, fileName } from "./timelinePresentation";
import type { FileChangeEntry } from "./timelineTypes";

interface FileChangeActivityProps {
  entry: FileChangeEntry;
  expandedDetail: string | null;
  onToggleDetail: (id: string) => void;
}

export function FileChangeActivity(props: FileChangeActivityProps) {
  return (
    <div class="file-change-list">
      <For each={props.entry.changes}>
        {(change, index) => {
          const detailId = () => `${props.entry.id}:${index()}`;
          const expanded = () => props.expandedDetail === detailId();
          const stats = () => diffStats(change.diff);
          return (
            <div class="activity-detail-row">
              <button
                aria-expanded={expanded()}
                class="activity-item-button file-change-button"
                onClick={() => props.onToggleDetail(detailId())}
                type="button"
              >
                <EditIcon size={13} />
                <span class="activity-item-label">
                  {fileAction(change)} <u>{fileName(change.path)}</u>
                </span>
                <span class="diff-count diff-additions">+{stats().additions}</span>
                <span class="diff-count diff-deletions">−{stats().deletions}</span>
                <span class={`change-kind-dot change-${change.kind}`} />
                <span class="activity-row-chevron">
                  {expanded() ? (
                    <ChevronDownIcon size={12} />
                  ) : (
                    <ChevronRightIcon size={12} />
                  )}
                </span>
              </button>
              <Show when={expanded()}>
                <div class="file-diff-card">
                  <div class="detail-card-title">Arquivo editado</div>
                  <div class="file-diff-title">
                    <span>{fileName(change.path)}</span>
                    <span class="diff-additions">+{stats().additions}</span>
                    <span class="diff-deletions">−{stats().deletions}</span>
                  </div>
                  <DiffView diff={change.diff} />
                </div>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}
