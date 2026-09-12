import { createMemo, createSignal, For, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";

import type { ProjectRecord } from "../contracts/types";
import { useI18n } from "../i18n/context";
import {
  hexToHsv,
  hsvToHex,
  hueFromHorizontalPosition,
  normalizeProjectColor,
} from "../state/projectColor";
import { Icon, type IconName } from "./Icon";
import { DEFAULT_PROJECT_COLOR } from "./sidebarShared";

export function ProjectEditModal(props: {
  readonly onClose: () => void;
  readonly onSave: (name: string, icon?: IconName, color?: string) => void;
  readonly project: ProjectRecord;
}) {
  const i18n = useI18n();
  const messages = () => i18n.messages().sidebar;
  const [name, setName] = createSignal(props.project.name);
  const [icon, setIcon] = createSignal<IconName | undefined>(
    (props.project.icon as IconName | undefined) ?? "folder",
  );
  const [color, setColor] = createSignal<string>(props.project.color ?? DEFAULT_PROJECT_COLOR);

  const selectedIcon = () => icon() ?? "folder";

  function closeOnEscape(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      props.onClose();
    }
  }

  onMount(() => {
    document.addEventListener("keydown", closeOnEscape);
  });
  onCleanup(() => {
    document.removeEventListener("keydown", closeOnEscape);
  });

  return (
    <Portal>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: backdrop */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop */}
      <div class="modal-backdrop" onClick={props.onClose}>
        <div
          class="project-edit-container"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          role="dialog"
        >
          <div class="project-edit-modal">
            <header class="project-edit-header">
              <h3>{messages().editProject}</h3>
              <button
                class="icon-button"
                onClick={props.onClose}
                title={messages().close}
                type="button"
              >
                <Icon name="close" size={14} />
              </button>
            </header>

            <div class="project-edit-body">
              <div class="project-edit-input-row">
                <div class="project-icon-preview" style={{ color: color() }}>
                  <Icon name={selectedIcon()} size={20} />
                </div>
                <input
                  class="project-name-input"
                  onInput={(event) => setName(event.currentTarget.value)}
                  placeholder={messages().projectName}
                  type="text"
                  value={name()}
                />
              </div>

              <div class="icon-picker-section">
                <span class="picker-label">{messages().icon}</span>
                <div class="icons-grid">
                  <For each={SELECTABLE_ICONS_LIST}>
                    {(item) => (
                      <button
                        class="icon-grid-button"
                        classList={{ active: selectedIcon() === item }}
                        onClick={() => setIcon(item)}
                        style={selectedIcon() === item ? { color: color() } : undefined}
                        title={item}
                        type="button"
                      >
                        <Icon name={item} size={24} strokeWidth={1.5} />
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </div>

            <footer class="project-edit-footer">
              <button class="project-edit-cancel" onClick={props.onClose} type="button">
                {messages().cancel}
              </button>
              <button
                class="project-edit-save"
                onClick={() => {
                  props.onSave(name().trim() || props.project.name, icon(), color());
                  props.onClose();
                }}
                type="button"
              >
                {messages().save}
              </button>
            </footer>
          </div>

          <div class="project-color-side-panel">
            <header class="side-panel-header">
              <span class="picker-label">{messages().projectColor}</span>
              <div class="color-hex-badge" style={{ background: color() }}>
                <span>{color().toUpperCase()}</span>
              </div>
            </header>

            <InlineColorPicker color={color()} onChange={setColor} />
          </div>
        </div>
      </div>
    </Portal>
  );
}

export const COLOR_PICKER_CURSOR_RADIUS_PX: number = 7;
export const COLOR_PICKER_CURSOR_DIAMETER_PX: number = 14;
export const PROJECT_HUE_SCALE_MAXIMUM: number = 359;

export function InlineColorPicker(props: {
  readonly color: string;
  readonly onChange: (color: string) => void;
}) {
  let boxRef: HTMLDivElement | undefined;
  let hueRef: HTMLDivElement | undefined;

  const hsv = createMemo(() => hexToHsv(props.color));
  const hue = () => hsv().h;
  const sat = () => hsv().s;
  const val = () => hsv().v;

  const cursorX = () =>
    `calc(${COLOR_PICKER_CURSOR_RADIUS_PX}px + (${sat()} / 100) * (100% - ${COLOR_PICKER_CURSOR_DIAMETER_PX}px))`;
  const cursorY = () =>
    `calc(${COLOR_PICKER_CURSOR_RADIUS_PX}px + (${100 - val()} / 100) * (100% - ${COLOR_PICKER_CURSOR_DIAMETER_PX}px))`;
  const hueX = () =>
    `calc(${COLOR_PICKER_CURSOR_RADIUS_PX}px + (${hue()} / ${PROJECT_HUE_SCALE_MAXIMUM}) * (100% - ${COLOR_PICKER_CURSOR_DIAMETER_PX}px))`;

  function updateFromBox(event: PointerEvent) {
    if (boxRef === undefined) {
      return;
    }
    const rect = boxRef.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    const newSat = Math.round((x / rect.width) * 100);
    const newVal = Math.round((1 - y / rect.height) * 100);
    props.onChange(hsvToHex(hue(), newSat, newVal));
  }

  function handleBoxPointerDown(event: PointerEvent) {
    event.preventDefault();
    boxRef?.setPointerCapture(event.pointerId);
    updateFromBox(event);
  }

  function handleBoxPointerMove(event: PointerEvent) {
    if (boxRef?.hasPointerCapture(event.pointerId) === true) {
      updateFromBox(event);
    }
  }

  function updateFromHue(event: PointerEvent) {
    if (hueRef === undefined) {
      return;
    }
    const rect = hueRef.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const newHue = hueFromHorizontalPosition(x, rect.width);
    props.onChange(hsvToHex(newHue, sat(), val()));
  }

  function handleHuePointerDown(event: PointerEvent) {
    event.preventDefault();
    hueRef?.setPointerCapture(event.pointerId);
    updateFromHue(event);
  }

  function handleHuePointerMove(event: PointerEvent) {
    if (hueRef?.hasPointerCapture(event.pointerId) === true) {
      updateFromHue(event);
    }
  }

  return (
    <div class="inline-color-picker">
      <div
        class="hsv-box"
        onPointerDown={handleBoxPointerDown}
        onPointerMove={handleBoxPointerMove}
        ref={boxRef}
        style={{ "background-color": `hsl(${hue()}, 100%, 50%)` }}
      >
        <div class="hsv-sat-overlay" />
        <div class="hsv-val-overlay" />
        <div
          class="hsv-cursor"
          style={{
            left: cursorX(),
            top: cursorY(),
          }}
        />
      </div>

      <div
        class="hue-bar"
        onPointerDown={handleHuePointerDown}
        onPointerMove={handleHuePointerMove}
        ref={hueRef}
      >
        <div class="hue-cursor" style={{ left: hueX() }} />
      </div>

      <div class="hex-input-wrapper">
        <span class="hex-hash">#</span>
        <input
          class="hex-text-input"
          maxLength={6}
          onInput={(event) => {
            const raw = event.currentTarget.value.trim().replace(/^#/, "");
            if (/^[0-9A-Fa-f]{6}$/.test(raw)) {
              props.onChange(normalizeProjectColor(`#${raw}`));
            }
          }}
          type="text"
          value={props.color.replace(/^#/, "").toUpperCase()}
        />
      </div>
    </div>
  );
}

export const SELECTABLE_ICONS_LIST: readonly IconName[] = [
  // Linha 1
  "folder",
  "dollar",
  "book",
  "graduationCap",
  "edit",
  "fountainPen",

  // Linha 2
  "codeBraces",
  "terminal",
  "music",
  "cupcake",
  "wand",
  "palette",

  // Linha 3
  "stethoscope",
  "flower",
  "lotus",
  "briefcase",
  "barChart",
  "kettlebell",

  // Linha 4
  "dumbbell",
  "notebook",
  "scale",
  "globeStand",
  "plane",
  "globe",

  // Linha 5
  "wrench",
  "paw",
  "flask",
  "brain",
  "heart",
  "plant",
];
