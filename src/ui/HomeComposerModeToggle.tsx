import type { ChatGptMode } from "../contracts/types";
import { useI18n } from "../i18n/context";

export function HomeComposerModeToggle(props: {
  readonly mode: ChatGptMode;
  readonly onChange: (mode: ChatGptMode) => void;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().homeMode;
  return (
    <fieldset class="home-composer-mode-toggle">
      <legend class="visually-hidden">{messages().legend}</legend>
      <ModeButton
        active={props.mode === "chat"}
        label={messages().chat}
        onSelect={() => props.onChange("chat")}
        title={messages().chatTitle}
      />
      <ModeButton
        active={props.mode === "work"}
        label={messages().work}
        onSelect={() => props.onChange("work")}
        title={messages().workTitle}
      />
    </fieldset>
  );
}

function ModeButton(props: {
  readonly active: boolean;
  readonly label: string;
  readonly onSelect: () => void;
  readonly title: string;
}) {
  return (
    <button
      aria-pressed={props.active}
      classList={{ selected: props.active }}
      onClick={() => {
        if (!props.active) {
          props.onSelect();
        }
      }}
      title={props.title}
      type="button"
    >
      {props.label}
    </button>
  );
}
