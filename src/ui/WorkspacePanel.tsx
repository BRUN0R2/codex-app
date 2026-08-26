import { For, Show } from "solid-js";

import type { FileChange } from "../contracts/types";
import type { BrowserController } from "../state/browserController";
import { BrowserPanel } from "./BrowserPanel";
import type { DiffDisplayMode } from "./DiffView";
import { Icon } from "./Icon";
import { ReviewPanel } from "./ReviewPanel";
import {
  activeWorkspaceTab,
  type WorkspaceTab,
  type WorkspaceTabId,
  type WorkspaceTabsState,
} from "./workspaceTabs";

interface WorkspacePanelProps {
  readonly browserController: BrowserController;
  readonly changes: readonly FileChange[];
  readonly conversationId: string;
  readonly mode: DiffDisplayMode;
  readonly onActivate: (tab: WorkspaceTab) => void;
  readonly onClose: (tab: WorkspaceTab) => void;
  readonly onHide: () => void;
  readonly onNewBrowserTab: () => void;
  readonly state: WorkspaceTabsState;
}

export function WorkspacePanel(props: WorkspacePanelProps) {
  const active = () => activeWorkspaceTab(props.state);
  const panelId = (tabId: WorkspaceTabId): string => `workspace-surface-${tabId}`;

  return (
    <section aria-label="Área de trabalho" class="workspace-panel">
      <header class="workspace-tab-bar">
        <div aria-label="Abas da área de trabalho" class="workspace-tabs-scroll" role="tablist">
          <For each={props.state.tabs}>
            {(tab) => (
              <div
                class="workspace-tab"
                classList={{ active: props.state.activeTabId === tab.id }}
                data-kind={tab.kind}
                role="presentation"
              >
                <button
                  aria-controls={panelId(tab.id)}
                  aria-selected={props.state.activeTabId === tab.id}
                  class="workspace-tab-select"
                  id={`workspace-tab-${tab.id}`}
                  onClick={() => props.onActivate(tab)}
                  role="tab"
                  title={workspaceTabTitle(tab, props.browserController, props.conversationId)}
                  type="button"
                >
                  <Icon name={tab.kind === "browser" ? "globe" : "file"} size={13} />
                  <span>
                    {workspaceTabLabel(tab, props.browserController, props.conversationId)}
                  </span>
                </button>
                <button
                  aria-label={`Fechar ${workspaceTabLabel(
                    tab,
                    props.browserController,
                    props.conversationId,
                  )}`}
                  class="workspace-tab-close"
                  onClick={() => props.onClose(tab)}
                  tabindex={props.state.activeTabId === tab.id ? 0 : -1}
                  type="button"
                >
                  <Icon name="close" size={11} />
                </button>
              </div>
            )}
          </For>
        </div>
        <button
          aria-label="Nova aba do navegador"
          class="workspace-bar-button"
          onClick={props.onNewBrowserTab}
          title="Nova aba do navegador"
          type="button"
        >
          <Icon name="plus" size={15} />
        </button>
        <span aria-hidden="true" class="workspace-bar-spacer" />
        <button
          aria-label="Fechar área de trabalho"
          class="workspace-bar-button workspace-panel-close"
          onClick={props.onHide}
          title="Voltar ao chat"
          type="button"
        >
          <Icon name="panel" size={15} />
        </button>
      </header>

      <Show when={active()}>
        {(tab) => (
          <div
            aria-labelledby={`workspace-tab-${tab().id}`}
            class="workspace-active-surface"
            id={panelId(tab().id)}
            role="tabpanel"
          >
            <Show when={tab().kind === "browser"}>
              <BrowserPanel
                controller={props.browserController}
                conversationId={props.conversationId}
              />
            </Show>
            <Show when={tab().kind === "review"}>
              <ReviewPanel changes={props.changes} mode={props.mode} />
            </Show>
          </div>
        )}
      </Show>
    </section>
  );
}

function workspaceTabLabel(
  tab: WorkspaceTab,
  controller: BrowserController,
  conversationId: string,
): string {
  if (tab.kind === "review") {
    return "Revisão";
  }
  const snapshot = controller
    .tabs(conversationId)
    .find(({ browserTabId }) => browserTabId === tab.browserTabId);
  return browserTabLabel(snapshot?.title ?? null, snapshot?.url ?? "about:blank");
}

function workspaceTabTitle(
  tab: WorkspaceTab,
  controller: BrowserController,
  conversationId: string,
): string {
  if (tab.kind === "review") {
    return "Revisão dos arquivos alterados";
  }
  const snapshot = controller
    .tabs(conversationId)
    .find(({ browserTabId }) => browserTabId === tab.browserTabId);
  return snapshot?.title ?? snapshot?.url ?? "Nova aba";
}

function browserTabLabel(title: string | null, url: string): string {
  if (title !== null && title.trim().length > 0) {
    return title;
  }
  if (url === "about:blank") {
    return "Nova aba";
  }
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}
