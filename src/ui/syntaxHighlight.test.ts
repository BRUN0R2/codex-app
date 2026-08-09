import { describe, expect, it } from "vitest";
import { escapeHtml, highlightCode } from "./syntaxHighlight";

describe("syntaxHighlight", () => {
  it("escapes HTML entities safely", () => {
    expect(escapeHtml("<script>alert('xss') & \"test\"</script>")).toBe(
      "&lt;script&gt;alert(&#39;xss&#39;) &amp; &quot;test&quot;&lt;/script&gt;",
    );
  });

  it("tokenizes keywords, strings and numbers", () => {
    const code = 'const count = 42;\nlet msg = "hello";';
    const html = highlightCode(code, "typescript");

    expect(html).toContain('<span class="token-keyword">const</span>');
    expect(html).toContain('<span class="token-number">42</span>');
    expect(html).toContain('<span class="token-keyword">let</span>');
    expect(html).toContain('<span class="token-string">&quot;hello&quot;</span>');
  });

  it("tokenizes functions and comments", () => {
    const code = "function test() {\n  // this is a comment\n  return 1;\n}";
    const html = highlightCode(code, "javascript");

    expect(html).toContain('<span class="token-function">test</span>');
    expect(html).toContain('<span class="token-comment">// this is a comment</span>');
    expect(html).toContain('<span class="token-keyword">return</span>');
  });
});
