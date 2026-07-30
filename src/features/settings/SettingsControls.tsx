import { For, Show, type JSX } from "solid-js";

import type { SelectOption } from "./settingsTypes";

export function SettingsPageHeading(props: {
  children?: JSX.Element;
  description?: string;
  title: string;
}) {
  return (
    <div class="settings-page-heading section-title-row">
      <div>
        <h3>{props.title}</h3>
        <Show when={props.description}>
          {(description) => <p>{description()}</p>}
        </Show>
      </div>
      {props.children}
    </div>
  );
}

export function SettingsSection(props: {
  children: JSX.Element;
  title?: string;
}) {
  return (
    <section class="settings-section">
      <Show when={props.title}>
        {(title) => <h4 class="settings-section-heading">{title()}</h4>}
      </Show>
      <div class="settings-group">{props.children}</div>
    </section>
  );
}

export function SettingsSelect(props: {
  description: string;
  disabled?: boolean;
  label: string;
  managed?: boolean;
  options: SelectOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label class="settings-row">
      <SettingsRowCopy
        description={props.description}
        label={props.label}
        managed={props.managed}
      />
      <select
        disabled={props.disabled || props.options.length === 0}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        value={props.value}
      >
        <For each={props.options}>
          {(option) => <option value={option.value}>{option.label}</option>}
        </For>
      </select>
    </label>
  );
}

export function SettingsToggle(props: {
  checked: boolean;
  description: string;
  disabled?: boolean;
  label: string;
  managed?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div class="settings-row">
      <SettingsRowCopy
        description={props.description}
        label={props.label}
        managed={props.managed}
      />
      <button
        aria-checked={props.checked}
        aria-label={props.label}
        class="settings-switch"
        classList={{ checked: props.checked }}
        disabled={props.disabled}
        onClick={() => props.onChange(!props.checked)}
        role="switch"
        type="button"
      >
        <span />
      </button>
    </div>
  );
}

export function SettingsStatus(props: {
  description: string;
  label: string;
  tone?: "default" | "success" | "warning";
  value: string;
}) {
  return (
    <div class="settings-row">
      <SettingsRowCopy description={props.description} label={props.label} />
      <span
        class={`settings-status settings-status-${props.tone ?? "default"}`}
      >
        {props.value}
      </span>
    </div>
  );
}

function SettingsRowCopy(props: {
  description: string;
  label: string;
  managed?: boolean | undefined;
}) {
  return (
    <span class="settings-row-copy">
      <span class="settings-row-title">
        <strong>{props.label}</strong>
        <Show when={props.managed}>
          <small class="managed-badge">Gerenciado</small>
        </Show>
      </span>
      <small>{props.description}</small>
    </span>
  );
}
