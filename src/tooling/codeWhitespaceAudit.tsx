import { render } from "solid-js/web";

import { createI18nController, I18nProvider } from "../i18n/context";
import { DiffView } from "../ui/DiffView";
import { createDiffDocument } from "../ui/diffDocument";
import { monospaceColumnCount } from "../ui/monospace";
import { ToolOutputContent } from "../ui/ToolOutputContent";
import { utf8ByteLength } from "../utf8";

export async function auditCodeWhitespace() {
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;top:40px;left:40px;width:360px;z-index:9999";
  document.body.append(host);
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("The whitespace audit requires text measurement.");
  const samples = [];
  try {
    for (const zoom of [1, 1.125]) {
      host.style.zoom = String(zoom);
      for (const kind of ["unified", "split", "source", "search"] as const) {
        for (const prefix of ["", "  ", "\t\t", " \t"]) {
          const content = `${prefix}const value = "${"x".repeat(180)}";`;
          const path = "sizing.ts";
          const text = kind === "search" ? `${path}:1:${content}` : `1: ${content}`;
          const output = {
            id: `${kind}-${prefix}-${zoom}`,
            preview: text,
            byteLength: utf8ByteLength(text),
            nextCursor: null,
          };
          const dispose = render(
            () => (
              <I18nProvider controller={createI18nController({ storage: null })}>
                {kind === "unified" || kind === "split" ? (
                  <DiffView
                    document={createDiffDocument(`@@ -0,0 +1 @@\n+${content}`)}
                    mode={kind}
                    path={path}
                    viewportSizing="intrinsic"
                  />
                ) : (
                  <ToolOutputContent
                    output={output}
                    text={text}
                    presentation={
                      kind === "source" ? { type: "sourceFile", path } : { type: "searchResults" }
                    }
                  />
                )}
              </I18nProvider>
            ),
            host,
          );
          try {
            await frame();
            await frame();
            const code = host.querySelector<HTMLElement>(
              ".unified-diff-code code, .split-diff-cell.added code, .tool-source-code-cell code, .tool-search-result-line > td > code",
            );
            if (code === null) throw new Error("The whitespace audit code is missing.");
            const firstText = document.createTreeWalker(code, NodeFilter.SHOW_TEXT).nextNode();
            if (firstText === null || (firstText.textContent?.length ?? 0) < prefix.length) {
              throw new Error("The whitespace prefix was not preserved in the first text node.");
            }
            const range = document.createRange();
            range.setStart(firstText, 0);
            range.setEnd(firstText, prefix.length);
            const style = getComputedStyle(code);
            context.font = `${style.fontSize} ${style.fontFamily}`;
            const expectedPrefixWidth =
              monospaceColumnCount(prefix) * context.measureText("0").width;
            const actualPrefixWidth = range.getBoundingClientRect().width / zoom;
            const viewport = code.closest<HTMLElement>(".diff-viewport, .tool-source-viewport");
            samples.push({
              kind,
              zoom,
              prefix,
              textMatches: code.textContent === content,
              tabSize: style.tabSize,
              expectedPrefixWidth,
              actualPrefixWidth,
              verticalOverflow:
                viewport === null ? 0 : viewport.scrollHeight - viewport.clientHeight,
            });
          } finally {
            dispose();
          }
        }
      }
    }
    return samples;
  } finally {
    host.remove();
  }
}
