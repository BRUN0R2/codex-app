import { For, Show } from "solid-js";

import { highlightCode } from "./syntaxHighlight";

export type UnifiedDiffLineType = "addition" | "context" | "deletion" | "hunk" | "meta";

export interface UnifiedDiffLine {
  readonly content: string;
  readonly newNumber: number | null;
  readonly oldNumber: number | null;
  readonly type: UnifiedDiffLineType;
}

export interface DiffStats {
  readonly additions: number;
  readonly deletions: number;
}

export interface SplitDiffRow {
  readonly leftNumber: number | null;
  readonly leftContent: string;
  readonly leftType: "removed" | "empty" | "normal" | "header";
  readonly rightNumber: number | null;
  readonly rightContent: string;
  readonly rightType: "added" | "empty" | "normal" | "header";
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u;

export function parseUnifiedDiff(diff: string): readonly UnifiedDiffLine[] {
  const lines = diff.replace(/\r\n?/gu, "\n").split("\n");
  const parsed: UnifiedDiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  let sawHunk = false;

  for (const [index, line] of lines.entries()) {
    if (index === lines.length - 1 && line.length === 0) {
      continue;
    }

    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      sawHunk = true;
      parsed.push({ content: line, newNumber: null, oldNumber: null, type: "hunk" });
      continue;
    }

    if (!sawHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      continue;
    }

    if (isDiffMetadata(line)) {
      parsed.push({ content: line, newNumber: null, oldNumber: null, type: "meta" });
      continue;
    }

    if (line.startsWith("+")) {
      parsed.push({
        content: line.slice(1),
        newNumber: newLine++,
        oldNumber: null,
        type: "addition",
      });
      continue;
    }

    if (line.startsWith("-")) {
      parsed.push({
        content: line.slice(1),
        newNumber: null,
        oldNumber: oldLine++,
        type: "deletion",
      });
      continue;
    }

    parsed.push({
      content: line.startsWith(" ") ? line.slice(1) : line,
      newNumber: newLine++,
      oldNumber: oldLine++,
      type: "context",
    });
  }

  return parsed;
}

export function summarizeDiff(diff: string): DiffStats {
  return parseUnifiedDiff(diff).reduce<DiffStats>(
    (stats, line) => ({
      additions: stats.additions + Number(line.type === "addition"),
      deletions: stats.deletions + Number(line.type === "deletion"),
    }),
    { additions: 0, deletions: 0 },
  );
}

export function parseSplitDiff(diff: string): readonly SplitDiffRow[] {
  const lines = parseUnifiedDiff(diff);
  const rows: SplitDiffRow[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }

    if (line.type === "hunk" || line.type === "meta") {
      rows.push({
        leftNumber: null,
        leftContent: line.content,
        leftType: "header",
        rightNumber: null,
        rightContent: line.content,
        rightType: "header",
      });
      index += 1;
      continue;
    }

    if (line.type === "deletion") {
      const removed: UnifiedDiffLine[] = [];
      const added: UnifiedDiffLine[] = [];
      while (lines[index]?.type === "deletion") {
        const current = lines[index];
        if (current !== undefined) removed.push(current);
        index += 1;
      }
      while (lines[index]?.type === "addition") {
        const current = lines[index];
        if (current !== undefined) added.push(current);
        index += 1;
      }
      const rowCount = Math.max(removed.length, added.length);
      for (let pairIndex = 0; pairIndex < rowCount; pairIndex += 1) {
        const left = removed[pairIndex];
        const right = added[pairIndex];
        rows.push({
          leftNumber: left?.oldNumber ?? null,
          leftContent: left?.content ?? "",
          leftType: left === undefined ? "empty" : "removed",
          rightNumber: right?.newNumber ?? null,
          rightContent: right?.content ?? "",
          rightType: right === undefined ? "empty" : "added",
        });
      }
      continue;
    }

    if (line.type === "addition") {
      rows.push({
        leftNumber: null,
        leftContent: "",
        leftType: "empty",
        rightNumber: line.newNumber,
        rightContent: line.content,
        rightType: "added",
      });
      index += 1;
      continue;
    }

    rows.push({
      leftNumber: line.oldNumber,
      leftContent: line.content,
      leftType: "normal",
      rightNumber: line.newNumber,
      rightContent: line.content,
      rightType: "normal",
    });
    index += 1;
  }

  return rows;
}

export function UnifiedDiffView(props: { readonly diff: string; readonly path: string }) {
  const rows = () => parseUnifiedDiff(props.diff);

  return (
    <div class="unified-diff-container">
      <table aria-label={`Diferenças em ${props.path}`} class="unified-diff-table">
        <tbody>
          <For each={rows()}>
            {(row) => (
              <tr class={`unified-diff-row is-${row.type}`}>
                <Show
                  when={row.type === "hunk" || row.type === "meta"}
                  fallback={
                    <>
                      <td class="diff-line-number old">{row.oldNumber ?? ""}</td>
                      <td class="diff-line-number new">{row.newNumber ?? ""}</td>
                      <td aria-hidden="true" class="diff-line-prefix">
                        {row.type === "addition" ? "+" : row.type === "deletion" ? "−" : ""}
                      </td>
                      <td class="unified-diff-code">
                        <HighlightedCode content={row.content} path={props.path} />
                      </td>
                    </>
                  }
                >
                  <td class="unified-diff-hunk" colSpan={4}>
                    {row.content}
                  </td>
                </Show>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

export function SplitDiffView(props: { readonly diff: string; readonly path?: string }) {
  const rows = () => parseSplitDiff(props.diff);
  const path = () => props.path ?? "arquivo";

  return (
    <div class="split-diff-container">
      <table aria-label={`Diferenças lado a lado em ${path()}`} class="split-diff-table">
        <tbody>
          <For each={rows()}>
            {(row) => (
              <tr class={`split-diff-row ${row.leftType === "header" ? "is-header" : ""}`}>
                <Show
                  when={row.leftType === "header"}
                  fallback={
                    <>
                      <td class="diff-line-number left">{row.leftNumber ?? ""}</td>
                      <td class={`split-diff-cell left ${row.leftType}`}>
                        <HighlightedCode content={row.leftContent} path={path()} />
                      </td>
                      <td class="diff-line-number right">{row.rightNumber ?? ""}</td>
                      <td class={`split-diff-cell right ${row.rightType}`}>
                        <HighlightedCode content={row.rightContent} path={path()} />
                      </td>
                    </>
                  }
                >
                  <td class="split-diff-hunk" colSpan={4}>
                    {row.leftContent}
                  </td>
                </Show>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

function HighlightedCode(props: { readonly content: string; readonly path: string }) {
  return <code innerHTML={highlightCode(props.content, fileExtension(props.path))} />;
}

function fileExtension(path: string): string | undefined {
  const file = path.split(/[\\/]/u).at(-1) ?? path;
  const extension = file.includes(".") ? file.split(".").at(-1) : undefined;
  return extension?.toLowerCase();
}

function isDiffMetadata(line: string): boolean {
  return (
    line.startsWith("diff --git ") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ") ||
    line === "\\ No newline at end of file"
  );
}
