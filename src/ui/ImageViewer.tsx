import {
  createContext,
  createSignal,
  onCleanup,
  onMount,
  type ParentProps,
  Show,
  useContext,
} from "solid-js";
import { Portal } from "solid-js/web";

import { Icon } from "./Icon";

export interface ImageViewerEntry {
  readonly alt: string;
  readonly name: string | undefined;
  readonly src: string;
}

interface ImageViewerContextValue {
  readonly open: (entry: ImageViewerEntry) => void;
}

const ImageViewerContext = createContext<ImageViewerContextValue>();

export function ImageViewerProvider(props: ParentProps) {
  const [entry, setEntry] = createSignal<ImageViewerEntry | null>(null);
  let closeButton: HTMLButtonElement | undefined;
  let previousFocus: HTMLElement | null = null;

  function open(nextEntry: ImageViewerEntry): void {
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEntry(nextEntry);
    queueMicrotask(() => closeButton?.focus());
  }

  function close(): void {
    if (entry() === null) {
      return;
    }
    setEntry(null);
    queueMicrotask(() => previousFocus?.focus());
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (entry() === null) {
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      closeButton?.focus();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    }
  }

  onMount(() => document.addEventListener("keydown", handleKeyDown, true));
  onCleanup(() => document.removeEventListener("keydown", handleKeyDown, true));

  return (
    <ImageViewerContext.Provider value={{ open }}>
      {props.children}
      <Show when={entry()}>
        {(visibleEntry) => (
          <Portal>
            <div
              aria-label={visibleEntry().name ?? visibleEntry().alt}
              aria-modal="true"
              class="image-viewer-backdrop"
              onClick={(event) => {
                if (event.target === event.currentTarget) {
                  close();
                }
              }}
              onKeyDown={(event) => {
                if (
                  event.target === event.currentTarget &&
                  (event.key === "Enter" || event.key === " ")
                ) {
                  close();
                }
              }}
              role="dialog"
            >
              <section class="image-viewer-dialog">
                <header class="image-viewer-header">
                  <span>{visibleEntry().name ?? visibleEntry().alt}</span>
                  <button
                    aria-label="Fechar visualização da imagem"
                    class="image-viewer-close"
                    onClick={close}
                    ref={closeButton}
                    title="Fechar"
                    type="button"
                  >
                    <Icon name="close" size={19} />
                  </button>
                </header>
                <div class="image-viewer-canvas">
                  <img alt={visibleEntry().alt} src={visibleEntry().src} />
                </div>
              </section>
            </div>
          </Portal>
        )}
      </Show>
    </ImageViewerContext.Provider>
  );
}

export function useImageViewer(): ImageViewerContextValue {
  const context = useContext(ImageViewerContext);
  if (context === undefined) {
    throw new Error("O visualizador de imagens não foi inicializado.");
  }
  return context;
}
