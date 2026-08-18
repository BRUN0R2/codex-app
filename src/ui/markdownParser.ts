import { Marked } from "marked";

import { normalizeMarkdownSource } from "./markdownSource";
import { highlightCode } from "./syntaxHighlight";

const markdownParser = new Marked({
  async: false,
  breaks: false,
  gfm: true,
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const highlighted = highlightCode(text, lang);
      const langClass = lang ? ` class="language-${escapeAttribute(lang)}"` : "";
      return `<pre><code${langClass}>${highlighted}</code></pre>`;
    },
    image({ href, text, title }: { href: string; text: string; title: string | null }) {
      const titleAttribute = title === null ? "" : ` title="${escapeAttribute(title)}"`;
      return `<img alt="${escapeAttribute(text)}" data-image-source="${escapeAttribute(href)}" loading="lazy" role="button" tabindex="0"${titleAttribute}>`;
    },
  },
});

export function renderMarkdownSource(source: string): string {
  return markdownParser.parse(normalizeMarkdownSource(source)) as string;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
