import {
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from "solid-js";

import {
  accessModeLabel,
  configuredPermissionPreset,
  type PermissionPreset,
} from "../../shared/codex/models";
import type {
  ConfigEditRequest,
  ConfigReadResponse,
} from "../../shared/codex/types";
import {
  CheckIcon,
  SettingsIcon,
  ShieldAlertIcon,
  ShieldIcon,
} from "../../shared/components/Icons";

interface PermissionPickerProps {
  config: ConfigReadResponse | null;
  disabled?: boolean;
  onOpenSettings: () => void;
  writeSettings: (edits: ConfigEditRequest[]) => Promise<void>;
}

export function PermissionPicker(props: PermissionPickerProps) {
  const [open, setOpen] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const selected = createMemo(() => configuredPermissionPreset(props.config));
  let root: HTMLDivElement | undefined;

  onMount(() => {
    const closeOutside = (event: PointerEvent) => {
      if (open() && event.target instanceof Node && !root?.contains(event.target)) {
        close();
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    onCleanup(() => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    });
  });

  function close() {
    setOpen(false);
    setError(null);
  }

  function openSettings() {
    close();
    props.onOpenSettings();
  }

  async function selectPreset(preset: Exclude<PermissionPreset, "custom">) {
    setSaving(true);
    setError(null);
    const values =
      preset === "full-access"
        ? { approvalPolicy: "never", sandboxMode: "danger-full-access" }
        : { approvalPolicy: "on-request", sandboxMode: "workspace-write" };
    try {
      await props.writeSettings([
        {
          keyPath: "sandbox_mode",
          value: values.sandboxMode,
          mergeStrategy: "replace",
        },
        {
          keyPath: "approval_policy",
          value: values.approvalPolicy,
          mergeStrategy: "replace",
        },
      ]);
      close();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="permission-picker" ref={root}>
      <button
        aria-expanded={open()}
        aria-haspopup="menu"
        class="permission-button"
        disabled={props.disabled === true || saving()}
        onClick={() => {
          setError(null);
          setOpen((current) => !current);
        }}
        title="Escolher permissões"
        type="button"
      >
        <ShieldAlertIcon size={15} />
        {accessModeLabel(props.config)}
      </button>

      <Show when={open()}>
        <div aria-label="Permissões" class="permission-popover" role="menu">
          <div class="permission-popover-header">
            <span>Como as ações do ChatGPT devem ser aprovadas?</span>
            <button onClick={openSettings} type="button">
              Saiba mais
            </button>
          </div>

          <PermissionOption
            description="Requer permissões padrão de sandbox neste espaço de trabalho"
            disabled={saving()}
            icon={<ShieldIcon size={16} />}
            label="Aprovar por mim"
            onClick={() => void selectPreset("approve-for-me")}
            selected={selected() === "approve-for-me"}
          />
          <PermissionOption
            accent
            description="Acesso irrestrito à internet e a qualquer arquivo no seu computador"
            disabled={saving()}
            icon={<ShieldAlertIcon size={16} />}
            label="Acesso completo"
            onClick={() => void selectPreset("full-access")}
            selected={selected() === "full-access"}
          />
          <PermissionOption
            description="Usa as permissões definidas em config.toml"
            disabled={saving()}
            icon={<SettingsIcon size={16} />}
            label="Personalizado (config.toml)"
            onClick={openSettings}
            selected={selected() === "custom"}
          />

          <Show when={saving()}>
            <p class="permission-picker-status">Aplicando permissões…</p>
          </Show>
          <Show when={error()}>
            {(message) => <p class="permission-picker-error">{message()}</p>}
          </Show>
        </div>
      </Show>
    </div>
  );
}

function PermissionOption(props: {
  accent?: boolean;
  description: string;
  disabled: boolean;
  icon: JSX.Element;
  label: string;
  onClick: () => void;
  selected: boolean;
}) {
  return (
    <button
      aria-checked={props.selected}
      class="permission-option"
      classList={{ accent: props.accent === true, selected: props.selected }}
      disabled={props.disabled}
      onClick={props.onClick}
      role="menuitemradio"
      type="button"
    >
      <span class="permission-option-icon">{props.icon}</span>
      <span class="permission-option-copy">
        <strong>{props.label}</strong>
        <small>{props.description}</small>
      </span>
      <span class="permission-option-check">
        <Show when={props.selected}>
          <CheckIcon size={16} />
        </Show>
      </span>
    </button>
  );
}

function describeError(reason: unknown): string {
  if (reason instanceof Error) {
    return reason.message;
  }
  if (reason !== null && typeof reason === "object" && "message" in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return "Não foi possível alterar as permissões.";
}
