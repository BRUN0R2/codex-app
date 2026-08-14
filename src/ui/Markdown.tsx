import { openUrl } from "@tauri-apps/plugin-opener";
import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { presentAssistantText } from "./contentReferenceMarkers";
import { useImageViewer } from "./ImageViewer";
import { resolveImageSource } from "./imageSource";
import { renderMarkdown } from "./markdownRenderer";
import { createMarkdownStreamRenderer, type MarkdownRenderUpdate } from "./markdownStreamRenderer";
import { renderMarkdownOffThread, shouldRenderMarkdownOffThread } from "./markdownWorkerClient";
import {
  createBrowserRenderThrottleScheduler,
  createLatestValueThrottle,
  markdownStreamRenderInterval,
} from "./renderThrottle";

export interface MarkdownProps {
  readonly class?: string;
  readonly streaming?: boolean;
  readonly text: string;
}

export function Markdown(props: MarkdownProps) {
  let element: HTMLDivElement | undefined;
  let tailStart: Comment | undefined;
  let tailEnd: Comment | undefined;
  let pendingMarkdownRender: AbortController | undefined;
  const [presentedText, setPresentedText] = createSignal(presentAssistantText(props.text));
  const renderThrottle = createLatestValueThrottle({
    emit: setPresentedText,
    scheduler: createBrowserRenderThrottleScheduler(),
  });
  const markdownRenderer = createMarkdownStreamRenderer(renderMarkdown);
  const viewer = useImageViewer();

  function renderPresentedText(source: string, streaming: boolean): void {
    if (element === undefined) {
      return;
    }
    pendingMarkdownRender?.abort();
    pendingMarkdownRender = undefined;
    if (!streaming && shouldRenderMarkdownOffThread(source)) {
      const render = new AbortController();
      pendingMarkdownRender = render;
      void renderMarkdownOffThread(source, render.signal)
        .then((html) => {
          if (render.signal.aborted) {
            return;
          }
          pendingMarkdownRender = undefined;
          applyRenderUpdate(markdownRenderer.finalize(source, html));
        })
        .catch((reason: unknown) => {
          if (render.signal.aborted) {
            return;
          }
          pendingMarkdownRender = undefined;
          console.error("Failed to render Markdown off the UI thread", reason);
          applyRenderUpdate(markdownRenderer.render(source, false));
        });
      return;
    }
    applyRenderUpdate(markdownRenderer.render(source, streaming));
  }

  function applyRenderUpdate(update: MarkdownRenderUpdate): void {
    if (element === undefined) {
      return;
    }
    if (update.reset || tailStart === undefined || tailEnd === undefined) {
      element.replaceChildren();
      tailStart = document.createComment("markdown-tail-start");
      tailEnd = document.createComment("markdown-tail-end");
      element.append(tailStart, tailEnd);
    }
    clearTail();
    insertHtml(update.appendHtml, tailStart);
    insertHtml(update.tailHtml, tailEnd);
    queueMicrotask(hydrateImages);
  }

  function clearTail(): void {
    if (tailStart === undefined || tailEnd === undefined) {
      return;
    }
    let node = tailStart.nextSibling;
    while (node !== null && node !== tailEnd) {
      const next = node.nextSibling;
      node.remove();
      node = next;
    }
  }

  function insertHtml(html: string, before: Node | undefined): void {
    if (element === undefined || before === undefined || html.length === 0) {
      return;
    }
    const template = document.createElement("template");
    template.innerHTML = html;
    element.insertBefore(template.content, before);
  }

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
    const source = presentAssistantText(props.text);
    renderThrottle.push(
      source,
      markdownStreamRenderInterval(source.length),
      props.streaming !== true,
    );
  });

  createEffect(() => {
    renderPresentedText(presentedText(), props.streaming === true);
  });

  onMount(() => {
    element?.addEventListener("click", handleClick);
    element?.addEventListener("keydown", handleKeyDown);
  });
  onCleanup(() => {
    pendingMarkdownRender?.abort();
    renderThrottle.dispose();
    element?.removeEventListener("click", handleClick);
    element?.removeEventListener("keydown", handleKeyDown);
  });

  return <div class={`markdown ${props.class ?? ""}`} ref={element} />;
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
