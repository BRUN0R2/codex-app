import { type JSX, Show } from "solid-js";

import { Icon } from "./Icon";

export function SettingsHeading(props: { readonly title: string; readonly description: string }) {
  return (
    <header class="settings-heading">
      <h2>{props.title}</h2>
      <p>{props.description}</p>
    </header>
  );
}

export function SettingsSection(props: {
  readonly allowOverflow?: boolean;
  readonly busy?: boolean;
  readonly children: JSX.Element;
  readonly description?: string;
  readonly title: string;
}) {
  return (
    <section class="settings-section">
      <h3>{props.title}</h3>
      <Show when={props.description}>
        <p class="settings-section-description">{props.description}</p>
      </Show>
      <div
        aria-busy={props.busy || undefined}
        class="settings-card"
        classList={{ "allow-overflow": props.allowOverflow }}
      >
        {props.children}
      </div>
    </section>
  );
}

export function PreferenceCheckbox(props: {
  readonly checked: boolean;
  readonly description: string;
  readonly disabled: boolean;
  readonly label: string;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <label class="application-preference" classList={{ disabled: props.disabled }}>
      <span class="settings-checkbox-control">
        <input
          aria-label={props.label}
          checked={props.checked}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.currentTarget.checked)}
          type="checkbox"
        />
        <span aria-hidden="true" class="settings-checkbox-box">
          <Icon name="check" size={14} />
        </span>
      </span>
      <span class="application-preference-copy">
        <strong>{props.label}</strong>
        <small>{props.description}</small>
      </span>
    </label>
  );
}

export function SettingsRow(props: {
  readonly children: JSX.Element;
  readonly description: string;
  readonly label: string;
}) {
  return (
    <div class="settings-row">
      <span>
        <strong>{props.label}</strong>
        <small>{props.description}</small>
      </span>
      <div>{props.children}</div>
    </div>
  );
}
