import { For, Show } from "solid-js";

import type { FileChange } from "../contracts/types";
import { useI18n } from "../i18n/context";
import { formatMessage } from "../i18n/messages";
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
  const i18n = useI18n();
  const active = () => activeWorkspaceTab(props.state);
  const panelId = (tabId: WorkspaceTabId): string => `workspace-surface-${tabId}`;

  return (
    <section aria-label={i18n.messages().workspace.label} class="workspace-panel">
      <header class="workspace-tab-bar">
        <div
          aria-label={i18n.messages().workspace.tabs}
          class="workspace-tabs-scroll"
          role="tablist"
        >
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
                  title={workspaceTabTitle(
                    tab,
                    props.browserController,
                    props.conversationId,
                    i18n.messages().workspace.reviewTitle,
                    i18n.messages().workspace.newTab,
                  )}
                  type="button"
                >
                  <Icon name={tab.kind === "browser" ? "globe" : "file"} size={13} />
                  <span>
                    {workspaceTabLabel(
                      tab,
                      props.browserController,
                      props.conversationId,
                      i18n.messages().workspace.review,
                      i18n.messages().workspace.newTab,
                    )}
                  </span>
                </button>
                <button
                  aria-label={formatMessage(i18n.messages().common.closeNamed, {
                    name: workspaceTabLabel(
                      tab,
                      props.browserController,
                      props.conversationId,
                      i18n.messages().workspace.review,
                      i18n.messages().workspace.newTab,
                    ),
                  })}
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
          aria-label={i18n.messages().workspace.newTab}
          class="workspace-bar-button"
          onClick={props.onNewBrowserTab}
          title={i18n.messages().workspace.newTab}
          type="button"
        >
          <Icon name="plus" size={15} />
        </button>
        <span aria-hidden="true" class="workspace-bar-spacer" />
        <button
          aria-label={i18n.messages().workspace.closeWorkspace}
          class="workspace-bar-button workspace-panel-close"
          onClick={props.onHide}
          title={i18n.messages().workspace.backToChat}
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
  reviewLabel: string,
  newTabLabel: string,
): string {
  if (tab.kind === "review") {
    return reviewLabel;
  }
  const snapshot = controller
    .tabs(conversationId)
    .find(({ browserTabId }) => browserTabId === tab.browserTabId);
  return browserTabLabel(snapshot?.title ?? null, snapshot?.url ?? "about:blank", newTabLabel);
}

function workspaceTabTitle(
  tab: WorkspaceTab,
  controller: BrowserController,
  conversationId: string,
  reviewTitle: string,
  newTabLabel: string,
): string {
  if (tab.kind === "review") {
    return reviewTitle;
  }
  const snapshot = controller
    .tabs(conversationId)
    .find(({ browserTabId }) => browserTabId === tab.browserTabId);
  return snapshot?.title ?? snapshot?.url ?? newTabLabel;
}

function browserTabLabel(title: string | null, url: string, newTabLabel: string): string {
  if (title !== null && title.trim().length > 0) {
    return title;
  }
  if (url === "about:blank") {
    return newTabLabel;
  }
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}
