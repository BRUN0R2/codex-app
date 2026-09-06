import { render } from "solid-js/web";

import { createI18nController, I18nProvider } from "../i18n/context";
import { DiffView } from "../ui/DiffView";
import { createDiffDocument } from "../ui/diffDocument";

export async function auditDiffIntrinsicSizing() {
  const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;top:40px;left:40px;width:360px;z-index:9999";
  document.body.append(host);
  const samples = [];
  try {
    for (const zoom of [1, 1.125]) {
      host.style.zoom = String(zoom);
      for (const mode of ["unified", "split"] as const) {
        for (const rowCount of [1, 2, 6, 1000]) {
          for (const longLines of [false, true]) {
            const diff = createDiffDocument(
              [
                `@@ -0,0 +1,${rowCount} @@`,
                ...Array.from(
                  { length: rowCount },
                  (_, index) => `+const value${index} = "${"x".repeat(longLines ? 180 : 1)}";`,
                ),
              ].join("\n"),
            );
            const dispose = render(
              () => (
                <I18nProvider controller={createI18nController({ storage: null })}>
                  <DiffView
                    document={diff}
                    mode={mode}
                    path="sizing.ts"
                    viewportSizing="intrinsic"
                  />
                </I18nProvider>
              ),
              host,
            );
            try {
              await frame();
              await frame();
              const viewport = host.querySelector<HTMLElement>(".diff-viewport");
              if (viewport === null) throw new Error("The intrinsic diff viewport is missing.");
              const rows = [...viewport.querySelectorAll<HTMLElement>(".diff-virtual-row")];
              const bounds = viewport.getBoundingClientRect();
              const contentTop = bounds.top + viewport.clientTop * zoom;
              const contentBottom = contentTop + viewport.clientHeight * zoom;
              samples.push({
                zoom,
                mode,
                rowCount,
                longLines,
                clientHeight: viewport.clientHeight,
                outerHeight: bounds.height / zoom,
                verticalOverflow: viewport.scrollHeight - viewport.clientHeight,
                horizontalOverflow: viewport.scrollWidth - viewport.clientWidth,
                mountedRows: rows.length,
                clippedRows: rows.filter((row) => {
                  const rect = row.getBoundingClientRect();
                  return rect.top < contentTop - 1 || rect.bottom > contentBottom + 1;
                }).length,
              });
            } finally {
              dispose();
            }
          }
        }
      }
    }
    return samples;
  } finally {
    host.remove();
  }
}
