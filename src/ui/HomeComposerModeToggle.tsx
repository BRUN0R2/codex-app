import type { ChatGptMode } from "../contracts/types";

export function HomeComposerModeToggle(props: {
  readonly mode: ChatGptMode;
  readonly onChange: (mode: ChatGptMode) => void;
}) {
  return (
    <fieldset class="home-composer-mode-toggle">
      <legend class="visually-hidden">Modo do compositor</legend>
      <ModeButton
        active={props.mode === "chat"}
        label="Chat"
        onSelect={() => props.onChange("chat")}
        title="Faça perguntas e explore ideias"
      />
      <ModeButton
        active={props.mode === "work"}
        label="Work"
        onSelect={() => props.onChange("work")}
        title="Realize tarefas com seus arquivos e aplicativos"
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
