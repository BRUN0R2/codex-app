import type { Accessor } from "solid-js";
import { createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { AppProduct } from "../contracts/types";
import { useI18n } from "../i18n/context";
import { CodexGlyph } from "./CodexGlyph";
import { Icon } from "./Icon";

export interface ProductBrandProps {
  readonly product: Accessor<AppProduct>;
  readonly selectProduct: (product: AppProduct) => Promise<boolean>;
  readonly onProductSelected?: () => void;
}

export function ProductBrand(props: ProductBrandProps): JSX.Element {
  const messages = useI18n().messages;
  const [open, setOpen] = createSignal(false);

  function dismissFromPointer(event: PointerEvent): void {
    if (!(event.target instanceof Element)) {
      setOpen(false);
      return;
    }
    if (event.target.closest(".sidebar-brand, .brand-menu") === null) {
      setOpen(false);
    }
  }

  function dismissFromKeyboard(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      setOpen(false);
    }
  }

  onMount(() => {
    window.addEventListener("pointerdown", dismissFromPointer, true);
    window.addEventListener("keydown", dismissFromKeyboard, true);
  });

  onCleanup(() => {
    window.removeEventListener("pointerdown", dismissFromPointer, true);
    window.removeEventListener("keydown", dismissFromKeyboard, true);
  });

  function choose(product: AppProduct): void {
    setOpen(false);
    props.onProductSelected?.();
    void props.selectProduct(product);
  }

  return (
    <div class="brand-menu-anchor window-chrome-brand">
      <button
        aria-expanded={open()}
        aria-haspopup="menu"
        class="sidebar-brand"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Show when={props.product() === "codex"}>
          <CodexGlyph size={20} />
        </Show>
        <strong>{props.product() === "codex" ? "Codex" : "ChatGPT"}</strong>
        <Icon name="chevronDown" size={14} />
      </button>
      <Show when={open()}>
        <div aria-label={messages().sidebar.switchProduct} class="brand-menu" role="menu">
          <button
            aria-checked={props.product() === "chatgpt"}
            class="brand-menu-item"
            classList={{ selected: props.product() === "chatgpt" }}
            onClick={() => choose("chatgpt")}
            role="menuitemradio"
            type="button"
          >
            <div class="brand-menu-item-text">
              <strong>ChatGPT</strong>
              <small>{messages().sidebar.chatGptDescription}</small>
            </div>
            <Show when={props.product() === "chatgpt"}>
              <Icon name="check" size={14} />
            </Show>
          </button>
          <button
            aria-checked={props.product() === "codex"}
            class="brand-menu-item"
            classList={{ selected: props.product() === "codex" }}
            onClick={() => choose("codex")}
            role="menuitemradio"
            type="button"
          >
            <div class="brand-menu-item-text">
              <strong>Codex</strong>
              <small>{messages().sidebar.codexDescription}</small>
            </div>
            <Show when={props.product() === "codex"}>
              <Icon name="check" size={14} />
            </Show>
          </button>
        </div>
      </Show>
    </div>
  );
}
