import { createSignal, For, Show } from "solid-js";

import { userMessageMarkerWidth } from "./timelinePresentation";

export interface UserMessageEntry {
  readonly id: string;
  readonly label: string;
  readonly title: string;
  readonly detail: string | null;
}

export function UserMessageNavigator(props: {
  readonly activeIndex: number;
  readonly messages: readonly UserMessageEntry[];
  readonly onSelect: (message: UserMessageEntry) => void;
}) {
  const [interactionIndex, setInteractionIndex] = createSignal<number | null>(null);

  return (
    <Show when={props.messages.length > 1}>
      <nav
        aria-label="Mensagens do usuário"
        class="user-message-navigator"
        onPointerLeave={() => setInteractionIndex(null)}
      >
        <For each={props.messages}>
          {(message, index) => (
            <button
              aria-current={index() === props.activeIndex ? "true" : undefined}
              aria-label={`Ir para a mensagem do usuário ${index() + 1}`}
              classList={{ active: index() === props.activeIndex }}
              onBlur={() => setInteractionIndex(null)}
              onClick={() => props.onSelect(message)}
              onFocus={() => setInteractionIndex(index())}
              onPointerEnter={() => setInteractionIndex(index())}
              style={{
                "--navigator-marker-width": `${userMessageMarkerWidth(
                  index(),
                  interactionIndex(),
                )}px`,
              }}
              type="button"
            >
              <span class="user-message-navigator-marker" />
              <span class="user-message-navigator-preview">
                <strong>{message.title}</strong>
                <Show when={message.detail}>{(detail) => <span>{detail()}</span>}</Show>
              </span>
            </button>
          )}
        </For>
      </nav>
    </Show>
  );
}
