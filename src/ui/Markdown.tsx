import { openUrl } from "@tauri-apps/plugin-opener";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { createMemo, onCleanup, onMount } from "solid-js";

export interface MarkdownProps {
  readonly class?: string;
  readonly text: string;
}

export function Markdown(props: MarkdownProps) {
  let element: HTMLDivElement | undefined;
  const html = createMemo(() => renderMarkdown(props.text));

  function handleClick(event: MouseEvent): void {
    const target = event.target;
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

  onMount(() => element?.addEventListener("click", handleClick));
  onCleanup(() => element?.removeEventListener("click", handleClick));

  return <div class={`markdown ${props.class ?? ""}`} innerHTML={html()} ref={element} />;
}

function renderMarkdown(source: string): string {
  const parsed = marked.parse(source.replace(/^[\u200B-\u200F\uFEFF]/u, ""), {
    async: false,
    breaks: false,
    gfm: true,
  });
  return DOMPurify.sanitize(parsed, {
    ADD_ATTR: ["target"],
    FORBID_ATTR: ["style"],
    FORBID_TAGS: ["button", "form", "input", "select", "textarea"],
    RETURN_TRUSTED_TYPE: false,
    USE_PROFILES: { html: true },
  });
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
