import { Show, createSignal, onCleanup, onMount } from "solid-js";

import {
  describeCommandError,
  readAttachmentImage,
} from "../../shared/codex/client";
import { ImageIcon } from "../../shared/components/Icons";

interface ImagePreviewProps {
  mediaType?: string | null;
  name: string;
  path: string;
}

type PreviewState = "failed" | "idle" | "loading" | "ready";

export function ImagePreview(props: ImagePreviewProps) {
  const [error, setError] = createSignal<string | null>(null);
  const [source, setSource] = createSignal<string | null>(null);
  const [state, setState] = createSignal<PreviewState>("idle");
  let container: HTMLDivElement | undefined;
  let disposed = false;
  let observer: IntersectionObserver | null = null;
  let objectUrl: string | null = null;

  onMount(() => {
    if (container === undefined || typeof IntersectionObserver === "undefined") {
      void load();
      return;
    }
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some(({ isIntersecting }) => isIntersecting)) {
          observer?.disconnect();
          observer = null;
          void load();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(container);
  });

  onCleanup(() => {
    disposed = true;
    observer?.disconnect();
    if (objectUrl !== null) {
      URL.revokeObjectURL(objectUrl);
    }
  });

  async function load() {
    if (state() !== "idle") {
      return;
    }
    if (props.path.length === 0) {
      setError("A imagem não possui um caminho local válido.");
      setState("failed");
      return;
    }
    setState("loading");
    try {
      const bytes = await readAttachmentImage(props.path);
      if (disposed) {
        return;
      }
      objectUrl = URL.createObjectURL(
        new Blob([bytes], { type: props.mediaType ?? "application/octet-stream" }),
      );
      setSource(objectUrl);
      setState("ready");
    } catch (reason) {
      if (!disposed) {
        fail(describeCommandError(reason));
      }
    }
  }

  function fail(message: string) {
    if (objectUrl !== null) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
    setSource(null);
    setError(message);
    setState("failed");
  }

  return (
    <div
      aria-label={props.name}
      class={`image-preview state-${state()}`}
      ref={container}
      title={error() ?? props.path}
    >
      <Show
        when={source()}
        fallback={
          <span class="image-preview-placeholder">
            <ImageIcon size={18} />
          </span>
        }
      >
        {(url) => (
          <img
            alt={props.name}
            decoding="async"
            loading="lazy"
            onError={() => fail("Não foi possível decodificar a miniatura da imagem.")}
            src={url()}
          />
        )}
      </Show>
    </div>
  );
}
