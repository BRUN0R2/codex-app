import {
  For,
  Match,
  Show,
  Switch,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import {
  compactModelName,
  configuredModel,
  configuredReasoningEffort,
  configuredServiceTier,
  reasoningEfforts,
  reasoningLabel,
  serviceTierLabel,
} from "../../shared/codex/models";
import type {
  CodexModel,
  ConfigEditRequest,
  ConfigReadResponse,
  JsonValue,
} from "../../shared/codex/types";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  RefreshIcon,
} from "../../shared/components/Icons";

interface ModelPickerProps {
  config: ConfigReadResponse | null;
  loadContext: () => Promise<void>;
  models: CodexModel[];
  writeSetting: (
    keyPath: string,
    value: JsonValue,
    mergeStrategy: "replace" | "upsert",
  ) => Promise<void>;
  writeSettings: (edits: ConfigEditRequest[]) => Promise<void>;
}

type PickerPage = "effort" | "model" | "speed" | null;

export function ModelPicker(props: ModelPickerProps) {
  const [open, setOpen] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [page, setPage] = createSignal<PickerPage>(null);
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const visibleModels = createMemo(() =>
    props.models.filter((candidate) => !candidate.hidden),
  );
  const model = createMemo(() => configuredModel(props.config, props.models));
  const effort = createMemo(() => configuredReasoningEffort(props.config, model()));
  const efforts = createMemo(() => reasoningEfforts(model()));
  const serviceTier = createMemo(() => configuredServiceTier(props.config, model()));
  const serviceTiers = createMemo(() =>
    (model()?.serviceTiers ?? []).filter((tier) => tier.id !== "default"),
  );
  let root: HTMLDivElement | undefined;

  onMount(() => {
    const closeOutside = (event: PointerEvent) => {
      if (open() && event.target instanceof Node && !root?.contains(event.target)) {
        close();
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (page() === null) {
          close();
        } else {
          setPage(null);
        }
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
    setPage(null);
    setError(null);
  }

  async function toggle() {
    if (open()) {
      close();
      return;
    }

    setPage(null);
    setError(null);
    setOpen(true);
    setLoading(true);
    try {
      await props.loadContext();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setLoading(false);
    }
  }

  async function save(key: string, value: JsonValue) {
    setSaving(true);
    setError(null);
    try {
      await props.writeSetting(key, value, "replace");
      close();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    setSaving(true);
    setError(null);
    try {
      await props.writeSettings(
        ["model", "model_reasoning_effort", "service_tier"].map((keyPath) => ({
          keyPath,
          value: null,
          mergeStrategy: "replace" as const,
        })),
      );
      close();
    } catch (reason) {
      setError(describeError(reason));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="model-picker" ref={root}>
      <button
        aria-expanded={open()}
        aria-haspopup="menu"
        class="model-picker-trigger"
        disabled={saving()}
        onClick={() => void toggle()}
        type="button"
      >
        <span>{compactModelName(model()?.displayName ?? "Modelo padrão")}</span>
        <span class="model-effort">{reasoningLabel(effort())}</span>
        <ChevronDownIcon size={14} />
      </button>

      <Show when={open()}>
        <div aria-label="Modelo e raciocínio" class="model-popover" role="menu">
          <Show when={loading()}>
            <p class="model-picker-status">Carregando modelos…</p>
          </Show>
          <MenuRow
            active={page() === "model"}
            disabled={loading()}
            label="Modelo"
            onOpen={() => setPage("model")}
            value={compactModelName(model()?.displayName ?? "Padrão")}
          />
          <MenuRow
            active={page() === "effort"}
            disabled={loading()}
            label="Esforço"
            onOpen={() => setPage("effort")}
            value={reasoningLabel(effort())}
          />
          <MenuRow
            active={page() === "speed"}
            disabled={loading()}
            label="Velocidade"
            onOpen={() => setPage("speed")}
            value={serviceTierLabel(serviceTier(), model())}
          />
          <div class="model-menu-divider" />
          <button
            class="model-reset-row"
            disabled={saving() || loading()}
            onClick={() => void reset()}
            onPointerEnter={() => setPage(null)}
            role="menuitem"
            type="button"
          >
            <span>Redefinir para o padrão</span>
            <RefreshIcon size={15} />
          </button>

          <Switch>
            <Match when={page() === "model"}>
              <div class="model-submenu model-submenu-model">
                <For each={visibleModels()}>
                  {(candidate) => (
                    <OptionRow
                      checked={candidate.id === model()?.id}
                      disabled={saving()}
                      label={compactModelName(candidate.displayName)}
                      onClick={() => void save("model", candidate.model)}
                    />
                  )}
                </For>
              </div>
            </Match>

            <Match when={page() === "effort"}>
              <div class="model-submenu">
                <span class="model-submenu-label">Esforço</span>
                <For each={efforts()}>
                  {(option) => (
                    <OptionRow
                      checked={option.reasoningEffort === effort()}
                      description={
                        option.reasoningEffort === "ultra"
                          ? "Consome a cota de uso mais rápido"
                          : undefined
                      }
                      disabled={saving()}
                      label={reasoningLabel(option.reasoningEffort)}
                      onClick={() =>
                        void save("model_reasoning_effort", option.reasoningEffort)
                      }
                    />
                  )}
                </For>
              </div>
            </Match>

            <Match when={page() === "speed"}>
              <div class="model-submenu">
                <span class="model-submenu-label">Velocidade</span>
                <OptionRow
                  checked={serviceTier() === null}
                  description="Velocidade padrão"
                  disabled={saving()}
                  label="Padrão"
                  onClick={() => void save("service_tier", null)}
                />
                <For each={serviceTiers()}>
                  {(tier) => (
                    <OptionRow
                      checked={tier.id === serviceTier()}
                      description={speedDescription(tier.id, tier.description)}
                      disabled={saving()}
                      label={speedTierName(tier.id, tier.name)}
                      onClick={() => void save("service_tier", tier.id)}
                    />
                  )}
                </For>
              </div>
            </Match>
          </Switch>

          <Show when={saving()}>
            <p class="model-picker-status">Salvando…</p>
          </Show>
          <Show when={error()}>
            {(message) => <p class="model-picker-error">{message()}</p>}
          </Show>
        </div>
      </Show>
    </div>
  );
}

function MenuRow(props: {
  active: boolean;
  disabled: boolean;
  label: string;
  onOpen: () => void;
  value: string;
}) {
  return (
    <button
      class="model-menu-row"
      classList={{ active: props.active }}
      disabled={props.disabled}
      onClick={props.onOpen}
      onPointerEnter={props.onOpen}
      role="menuitem"
      type="button"
    >
      <span>{props.label}</span>
      <span class="model-menu-value">{props.value}</span>
      <ChevronRightIcon size={14} />
    </button>
  );
}

function OptionRow(props: {
  checked: boolean;
  description?: string | undefined;
  disabled: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      class="model-option-row"
      disabled={props.disabled}
      onClick={props.onClick}
      role="menuitemradio"
      type="button"
    >
      <span class="model-option-copy">
        <strong>{props.label}</strong>
        <Show when={(props.description?.length ?? 0) > 0}>
          <small>{props.description}</small>
        </Show>
      </span>
      <span class="model-option-check">
        <Show when={props.checked}>
          <CheckIcon size={16} />
        </Show>
      </span>
    </button>
  );
}

function speedDescription(id: string, description: string): string {
  if (id === "fast" || id === "priority" || description.includes("1.5x")) {
    return "Velocidade 1,5x, mais uso";
  }
  return description;
}

function speedTierName(id: string, name: string): string {
  if (id === "fast" || id === "priority" || name.toLowerCase() === "fast") {
    return "Rápido";
  }
  return name;
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
  return "Não foi possível alterar o modelo.";
}
