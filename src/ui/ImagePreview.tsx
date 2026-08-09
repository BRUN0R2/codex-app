import { createResource, Show } from "solid-js";

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

  return (
    <button
      aria-label={label()}
      class={`image-preview ${props.class ?? ""}`}
      classList={{ failed: resolvedSource.error !== undefined }}
      disabled={resolvedSource() === undefined}
      onClick={() => {
        const src = resolvedSource();
        if (src !== undefined) {
          viewer.open({ alt: props.alt, name: props.name, src });
        }
      }}
      title={label()}
      type="button"
    >
      <Show
        when={resolvedSource()}
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
