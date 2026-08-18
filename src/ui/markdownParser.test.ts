import { describe, expect, it } from "vitest";

import { renderMarkdownSource } from "./markdownParser";

describe("Markdown parser", () => {
  it("renders highlighted code with a normalized language class", () => {
    const html = renderMarkdownSource("```typescript\nconst answer = 42;\n```");

    expect(html).toContain('<code class="language-typescript">');
    expect(html).toContain('<span class="token-keyword">const</span>');
    expect(html).toContain('<span class="token-number">42</span>');
  });

  it("escapes image metadata before producing the hydration contract", () => {
    const html = renderMarkdownSource('![A "safe" image](https://example.com/a.png "Title")');

    expect(html).toContain('alt="A &quot;safe&quot; image"');
    expect(html).toContain('data-image-source="https://example.com/a.png"');
    expect(html).toContain('loading="lazy"');
    expect(html).toContain('role="button"');
  });

  it("normalizes only a leading invisible marker and remains deterministic across calls", () => {
    const source = "\uFEFF# Heading";
    const first = renderMarkdownSource(source);

    expect(first).toBe("<h1>Heading</h1>\n");
    expect(renderMarkdownSource(source)).toBe(first);
  });
});
