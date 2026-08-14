import { marked } from "marked";

import { highlightCode } from "./syntaxHighlight";

export function renderMarkdownSource(source: string): string {
  const renderer = new marked.Renderer();
  renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
    const highlighted = highlightCode(text, lang);
    const langClass = lang ? ` class="language-${escapeAttribute(lang)}"` : "";
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

  return marked.parse(normalizeMarkdown(source), {
    async: false,
    breaks: false,
    gfm: true,
    renderer,
  }) as string;
}

function normalizeMarkdown(source: string): string {
  return source.replace(/^[\u200B-\u200F\uFEFF]/u, "");
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
