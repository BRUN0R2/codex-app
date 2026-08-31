import { createResource, Show } from "solid-js";
import { useI18n } from "../i18n/context";
import { formatMessage } from "../i18n/messages";
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
  const i18n = useI18n();
  const common = () => i18n.messages().common;
  const messages = () => i18n.messages().imagePreview;
  const viewer = useImageViewer();
  const [resolvedSource] = createResource(() => props.source, resolveImageSource);
  const label = () =>
    formatMessage(common().openNamed, { name: props.name ?? (props.alt || messages().image) });
  const failure = (): unknown => resolvedSource.error;
  const source = () => (resolvedSource.state === "ready" ? resolvedSource() : undefined);
  const title = () => {
    const reason = failure();
    return reason === undefined
      ? label()
      : formatMessage(messages().unavailable, {
          name: props.name ?? (props.alt || messages().imageTitle),
          reason: describeError(reason),
        });
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
