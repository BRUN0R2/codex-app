import { createSignal, For, Show } from "solid-js";
import { useI18n } from "../i18n/context";
import { formatMessage } from "../i18n/messages";
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
  const i18n = useI18n();
  const [interactionIndex, setInteractionIndex] = createSignal<number | null>(null);

  return (
    <Show when={props.messages.length > 1}>
      <nav
        aria-label={i18n.messages().userMessages.label}
        class="user-message-navigator"
        onPointerLeave={() => setInteractionIndex(null)}
      >
        <For each={props.messages}>
          {(message, index) => (
            <button
              aria-current={index() === props.activeIndex ? "true" : undefined}
              aria-label={formatMessage(i18n.messages().userMessages.goTo, {
                number: index() + 1,
              })}
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
