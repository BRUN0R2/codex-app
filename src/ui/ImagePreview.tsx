import { createResource, Show } from "solid-js";

import { describeError } from "../infrastructure/errorDescription";

import { Icon } from "./Icon";
import { useImageViewer } from "./ImageViewer";
import { resolveImageSource } from "./imageSource";

export interface ImagePreviewProps {
  readonly alt: string;
  readonly class?: string;
  readonly name?: string;
  readonly source: string;
}

export function ImagePreview(props: ImagePreviewProps) {
  const viewer = useImageViewer();
  const [resolvedSource] = createResource(() => props.source, resolveImageSource);
  const label = () => `Abrir ${props.name ?? (props.alt || "imagem")}`;
  const failure = (): unknown => resolvedSource.error;
  const source = () => (resolvedSource.state === "ready" ? resolvedSource() : undefined);
  const title = () => {
    const reason = failure();
    return reason === undefined
      ? label()
      : `${props.name ?? (props.alt || "Imagem")} indisponível: ${describeError(reason)}`;
  };

  return (
    <button
      aria-label={title()}
      class={`image-preview ${props.class ?? ""}`}
      classList={{ failed: failure() !== undefined }}
      disabled={source() === undefined}
      onClick={() => {
        const src = source();
        if (src !== undefined) {
          viewer.open({ alt: props.alt, name: props.name, src });
        }
      }}
      title={title()}
      type="button"
    >
      <Show
        when={source()}
        fallback={
          <span class="image-preview-placeholder">
            <Icon name="image" size={18} />
          </span>
        }
      >
        {(src) => <img alt={props.alt} draggable={false} loading="lazy" src={src()} />}
      </Show>
    </button>
  );
}
