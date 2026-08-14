import DOMPurify from "dompurify";

import { renderMarkdownSource } from "./markdownParser";

export function renderMarkdown(source: string): string {
  return sanitizeMarkdownHtml(renderMarkdownSource(source));
}

export function sanitizeMarkdownHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["target", "class", "data-image-source", "loading", "role", "tabindex", "title"],
    ADD_TAGS: ["span"],
    FORBID_ATTR: ["style"],
    FORBID_TAGS: ["button", "form", "input", "select", "textarea"],
    RETURN_TRUSTED_TYPE: false,
    USE_PROFILES: { html: true },
  });
}
