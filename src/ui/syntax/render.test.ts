import { describe, expect, it } from "vitest";

import { escapeHtml, highlightCodeToHtml } from "./render";

describe("syntax HTML renderer", () => {
  it("escapes HTML entities safely", () => {
    expect(escapeHtml("<script>alert('xss') & \"test\"</script>")).toBe(
      "&lt;script&gt;alert(&#39;xss&#39;) &amp; &quot;test&quot;&lt;/script&gt;",
    );
  });

  it("serializes typed tokens with semantic classes", () => {
    const html = highlightCodeToHtml(
      "#[test]\nfn benchmark() {\n    const COUNT: usize = 42;\n}",
      "rust",
    );

    expect(html).toContain('<span class="syntax-token token-attribute">#[test]</span>');
    expect(html).toContain('<span class="syntax-token token-keyword">fn</span>');
    expect(html).toContain('<span class="syntax-token token-function">benchmark</span>');
    expect(html).toContain('<span class="syntax-token token-constant">COUNT</span>');
    expect(html).toContain('<span class="syntax-token token-type">usize</span>');
    expect(html).toContain('<span class="syntax-token token-number">42</span>');
  });

  it("renders unknown languages as escaped plain text", () => {
    expect(highlightCodeToHtml("<script>alert(1)</script>", "future-language")).toBe(
      "&lt;script&gt;alert(1)&lt;/script&gt;",
    );
  });
});
