import { For, Show } from "solid-js";

import { useI18n } from "../i18n/context";
import type { AppController } from "../state/appController";

export function AgentTabs(props: { readonly controller: AppController }) {
  const i18n = useI18n();
  const messages = () => i18n.messages().shell;
  const rootThread = () => {
    const rootThreadId = props.controller.activeTaskRootId();
    return props.controller.threads().find((thread) => thread.id === rootThreadId) ?? null;
  };

  return (
    <Show when={props.controller.agentThreads().length > 0}>
      <nav aria-label={messages().agentTabs} class="agent-tabs">
        <button
          aria-current={props.controller.currentThread()?.agent === null ? "page" : undefined}
          class="agent-tab"
          classList={{ active: props.controller.currentThread()?.agent === null }}
          onClick={() => {
            const rootThreadId = props.controller.activeTaskRootId();
            if (rootThreadId !== null) void props.controller.openThread(rootThreadId);
          }}
          type="button"
        >
          <span class="agent-tab-status" data-status={rootThread()?.status.type ?? "idle"} />
          <span>{messages().mainTask}</span>
        </button>
        <For each={props.controller.agentThreads()}>
          {(thread) => (
            <button
              aria-current={props.controller.currentThread()?.id === thread.id ? "page" : undefined}
              class="agent-tab"
              classList={{ active: props.controller.currentThread()?.id === thread.id }}
              onClick={() => void props.controller.openThread(thread.id)}
              title={`${thread.agent?.path ?? thread.id} · ${thread.agent?.model ?? ""}`}
              type="button"
            >
              <span class="agent-tab-status" data-status={thread.status.type} />
              <span>{thread.agent?.taskName ?? thread.name ?? thread.preview}</span>
            </button>
          )}
        </For>
      </nav>
    </Show>
  );
}
