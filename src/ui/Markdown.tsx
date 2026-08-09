import { openUrl } from "@tauri-apps/plugin-opener";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { createEffect, createMemo, onCleanup, onMount } from "solid-js";
import { useImageViewer } from "./ImageViewer";
import { resolveImageSource } from "./imageSource";
import { highlightCode } from "./syntaxHighlight";

export interface MarkdownProps {
  readonly class?: string;
  readonly text: string;
}

export function Markdown(props: MarkdownProps) {
  let element: HTMLDivElement | undefined;
  const html = createMemo(() => renderMarkdown(props.text));
  const viewer = useImageViewer();

  function handleClick(event: MouseEvent): void {
    const target = event.target;
    const image =
      target instanceof Element ? target.closest<HTMLImageElement>("img[data-image-source]") : null;
    if (image !== null) {
      event.preventDefault();
      openMarkdownImage(image);
      return;
    }
    const anchor = target instanceof Element ? target.closest("a") : null;
    const href = anchor?.getAttribute("href");
    if (href === null || href === undefined) {
      return;
    }

    event.preventDefault();
    const url = safeExternalUrl(href);
    if (url !== null) {
      void openUrl(url).catch((error: unknown) => {
        console.error("Failed to open external Markdown link", error);
      });
    }
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    const target = event.target;
    const image =
      target instanceof Element ? target.closest<HTMLImageElement>("img[data-image-source]") : null;
    if (image === null) {
      return;
    }
    event.preventDefault();
    openMarkdownImage(image);
  }

  function openMarkdownImage(image: HTMLImageElement): void {
    const source = image.currentSrc || image.src;
    if (source.length === 0 || image.getAttribute("data-image-ready") !== "true") {
      return;
    }
    viewer.open({
      alt: image.alt || "Imagem enviada pelo Codex",
      name: image.title || image.alt || undefined,
      src: source,
    });
  }

  function hydrateImages(): void {
    const images = element?.querySelectorAll<HTMLImageElement>("img[data-image-source]") ?? [];
    for (const image of images) {
      const source = image.getAttribute("data-image-source");
      if (
        source === null ||
        source.length === 0 ||
        image.getAttribute("data-image-loading") === "true"
      ) {
        continue;
      }
      image.setAttribute("data-image-loading", "true");
      void resolveImageSource(source)
        .then((resolved) => {
          if (image.isConnected && image.getAttribute("data-image-source") === source) {
            image.src = resolved;
            image.setAttribute("data-image-ready", "true");
            image.classList.remove("image-load-failed");
          }
        })
        .catch(() => {
          if (image.isConnected && image.getAttribute("data-image-source") === source) {
            image.classList.add("image-load-failed");
          }
        })
        .finally(() => {
          image.removeAttribute("data-image-loading");
        });
    }
  }

  createEffect(() => {
    html();
    queueMicrotask(hydrateImages);
  });

  onMount(() => {
    element?.addEventListener("click", handleClick);
    element?.addEventListener("keydown", handleKeyDown);
  });
  onCleanup(() => {
    element?.removeEventListener("click", handleClick);
    element?.removeEventListener("keydown", handleKeyDown);
  });

  return <div class={`markdown ${props.class ?? ""}`} innerHTML={html()} ref={element} />;
}

function renderMarkdown(source: string): string {
  const renderer = new marked.Renderer();
  renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
    const highlighted = highlightCode(text, lang);
    const langClass = lang ? ` class="language-${lang}"` : "";
    return `<pre><code${langClass}>${highlighted}</code></pre>`;
  };
  renderer.image = ({
    href,
    text,
    title,
  }: {
    href: string;
    text: string;
    title: string | null;
  }) => {
    const titleAttribute = title === null ? "" : ` title="${escapeAttribute(title)}"`;
    return `<img alt="${escapeAttribute(text)}" data-image-source="${escapeAttribute(href)}" loading="lazy" role="button" tabindex="0"${titleAttribute}>`;
  };

  const parsed = marked.parse(source.replace(/^[\u200B-\u200F\uFEFF]/u, ""), {
    async: false,
    breaks: false,
    gfm: true,
    renderer,
  }) as string;

  return DOMPurify.sanitize(parsed, {
    ADD_ATTR: ["target", "class", "data-image-source", "loading", "role", "tabindex", "title"],
    ADD_TAGS: ["span"],
    FORBID_ATTR: ["style"],
    FORBID_TAGS: ["button", "form", "input", "select", "textarea"],
    RETURN_TRUSTED_TYPE: false,
    USE_PROFILES: { html: true },
  });
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function safeExternalUrl(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:"
      ? url.href
      : null;
  } catch {
    return null;
  }
}
