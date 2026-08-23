import { performance } from "node:perf_hooks";

import type { SyntaxLanguage } from "../src/ui/syntax/contracts.ts";
import { createDiffDocument } from "../src/ui/diffDocument.ts";
import { calculateDiffVirtualRange, DIFF_ROW_HEIGHT_PX } from "../src/ui/diffViewport.ts";
import { DiffSyntaxHighlighter } from "../src/ui/syntax/diffHighlighter.ts";
import { highlightCodeToHtml } from "../src/ui/syntax/render.ts";
import { MARKDOWN_SYNTAX_LIMITS, tokenizeSyntaxBlock } from "../src/ui/syntax/tokenizer.ts";

const SAMPLE_COUNT = 7;
const CORPUS_ITERATIONS = 500;
const REPRESENTATIVE_CASES: readonly {
  readonly code: string;
  readonly language: SyntaxLanguage;
}[] = [
  { language: "bash", code: 'for file in *.rs; do printf "%s\\n" "$file"; done' },
  { language: "c", code: "#include <stdint.h>\nconst uint32_t answer = 42;" },
  { language: "cpp", code: "std::vector<int> values{1, 2, 3};" },
  { language: "csharp", code: "[Test]\npublic async Task ExecuteAsync() => await RunAsync();" },
  { language: "css", code: ".button { color: rgb(255 180 120); }" },
  { language: "go", code: 'func main() { fmt.Println("ready") }' },
  { language: "html", code: '<button aria-label="Save">Ready</button>' },
  { language: "java", code: '@Override public String value() { return "ready"; }' },
  { language: "javascript", code: "export async function run() { return await ready(); }" },
  { language: "json", code: '{"enabled": true, "limit": 42}' },
  { language: "markdown", code: "## Heading\n\n- `inline code`\n- [link](https://example.com)" },
  { language: "powershell", code: '$result = Get-Item $Path\nWrite-Output "$result"' },
  { language: "python", code: 'def run() -> str:\n    return """ready"""' },
  {
    language: "rust",
    code: '#[test]\nfn run() {\n    const LIMIT: usize = 1_024;\n    println!(r#"ready"#);\n}',
  },
  { language: "sql", code: "SELECT value FROM records WHERE id = 42;" },
  { language: "toml", code: '[package]\nname = "codex-app"\nprivate = true' },
  {
    language: "typescript",
    code: "export interface Result<T> { readonly value: T }\nconst answer: Result<number> = { value: 42 };",
  },
  { language: "yaml", code: "service:\n  enabled: true\n  image: codex:latest" },
];

const corpusMeasurement = measure(() => {
  let checksum = 0;
  for (let iteration = 0; iteration < CORPUS_ITERATIONS; iteration += 1) {
    for (const sample of REPRESENTATIVE_CASES) {
      const result = tokenizeSyntaxBlock(sample.code, sample.language, MARKDOWN_SYNTAX_LIMITS);
      if (result.kind !== "highlighted") {
        throw new Error(`Representative ${sample.language} source unexpectedly fell back.`);
      }
      checksum += result.lines.reduce((total, line) => total + line.length, 0);
    }
  }
  return checksum;
});

const longRustSource = Array.from({ length: 4_000 }, (_, index) =>
  index % 400 === 0
    ? `/* section ${index}\n   continues */`
    : `const VALUE_${index}: usize = ${index} * 1_024;`,
).join("\n");
const longRustMeasurement = measure(() => {
  const result = tokenizeSyntaxBlock(longRustSource, "rust", MARKDOWN_SYNTAX_LIMITS);
  if (result.kind !== "highlighted") {
    throw new Error(`Long Rust source unexpectedly fell back: ${result.reason}.`);
  }
  return result.lines.reduce((total, line) => total + line.length, 0);
});

const htmlMeasurement = measure(() => {
  let checksum = 0;
  for (let iteration = 0; iteration < 1_000; iteration += 1) {
    checksum += highlightCodeToHtml(REPRESENTATIVE_CASES[13]?.code ?? "", "rust").length;
  }
  return checksum;
});

const diff = createDiffDocument(createSyntheticDiff(80));
const range = calculateDiffVirtualRange({
  rowCount: diff.unifiedRows.length,
  scrollTop: (diff.unifiedRows.length * DIFF_ROW_HEIGHT_PX) / 2,
  viewportHeight: 900,
});
const coldDiffMeasurement = measure(() => {
  const highlighter = new DiffSyntaxHighlighter();
  let checksum = 0;
  for (let sourceIndex = range.start; sourceIndex < range.end; sourceIndex += 1) {
    checksum += highlighter.render(diff, "benchmark.ts", sourceIndex)?.length ?? 0;
  }
  return checksum;
});
const warmHighlighter = new DiffSyntaxHighlighter();
for (let sourceIndex = range.start; sourceIndex < range.end; sourceIndex += 1) {
  warmHighlighter.render(diff, "benchmark.ts", sourceIndex);
}
const warmDiffMeasurement = measure(() => {
  let checksum = 0;
  for (let sourceIndex = range.start; sourceIndex < range.end; sourceIndex += 1) {
    checksum += warmHighlighter.render(diff, "benchmark.ts", sourceIndex)?.length ?? 0;
  }
  return checksum;
});

const oversizedDiff = createDiffDocument(
  `@@ -1,4097 +1,4097 @@\n${Array.from(
    { length: 4_097 },
    (_, index) => ` const value_${index} = ${index};`,
  ).join("\n")}`,
);
const fallbackMeasurement = measure(() => {
  const highlighter = new DiffSyntaxHighlighter();
  return highlighter.render(oversizedDiff, "oversized.ts", 1) === null ? 1 : 0;
});
const createdFileDiff = createDiffDocument(
  `@@ -0,0 +1,338 @@\n${Array.from(
    { length: 338 },
    (_, index) => `+const VALUE_${index}: usize = ${index} * 1_024;`,
  ).join("\n")}`,
);
const createdFileMeasurement = measure(() => {
  const highlighter = new DiffSyntaxHighlighter();
  let checksum = 0;
  for (let sourceIndex = 1; sourceIndex <= 338; sourceIndex += 1) {
    checksum += highlighter.render(createdFileDiff, "semantic.rs", sourceIndex)?.length ?? 0;
  }
  return checksum;
});

const malicious = highlightCodeToHtml("<script>alert('xss')</script>", "future-language");
if (
  corpusMeasurement.value <= 0 ||
  longRustMeasurement.value <= 0 ||
  htmlMeasurement.value <= 0 ||
  coldDiffMeasurement.value <= 0 ||
  warmDiffMeasurement.value <= 0 ||
  createdFileMeasurement.value <= 0 ||
  fallbackMeasurement.value !== 1 ||
  malicious.includes("<script>")
) {
  throw new Error("Syntax benchmark violated a correctness or security invariant.");
}
if (
  corpusMeasurement.medianMilliseconds > 250 ||
  longRustMeasurement.medianMilliseconds > 100 ||
  htmlMeasurement.medianMilliseconds > 250 ||
  coldDiffMeasurement.medianMilliseconds > 5 ||
  warmDiffMeasurement.medianMilliseconds > 1 ||
  createdFileMeasurement.medianMilliseconds > 15 ||
  fallbackMeasurement.medianMilliseconds > 1
) {
  throw new Error("Syntax benchmark exceeded a latency gate.");
}

process.stdout.write(
  `${JSON.stringify(
    {
      samples: SAMPLE_COUNT,
      languages: REPRESENTATIVE_CASES.length,
      corpusIterations: CORPUS_ITERATIONS,
      corpusMedianMs: corpusMeasurement.medianMilliseconds,
      longRustLines: 4_000,
      longRustMedianMs: longRustMeasurement.medianMilliseconds,
      htmlRenders: 1_000,
      htmlMedianMs: htmlMeasurement.medianMilliseconds,
      visibleRows: range.end - range.start,
      coldDiffMedianMs: coldDiffMeasurement.medianMilliseconds,
      warmDiffMedianMs: warmDiffMeasurement.medianMilliseconds,
      createdFileLines: 338,
      createdFileMedianMs: createdFileMeasurement.medianMilliseconds,
      oversizedHunkFallbackMedianMs: fallbackMeasurement.medianMilliseconds,
    },
    null,
    2,
  )}\n`,
);

function createSyntheticDiff(modifications: number): string {
  const lines = [`@@ -1,${modifications * 2} +1,${modifications * 2} @@`];
  for (let index = 0; index < modifications; index += 1) {
    lines.push(`-const before${index}: number = ${index};`);
    lines.push(`+const after${index}: number = ${index + 1};`);
    lines.push(` contextCall(${index});`);
  }
  return lines.join("\n");
}

function measure<T>(operation: () => T): {
  readonly medianMilliseconds: number;
  readonly value: T;
} {
  const durations: number[] = [];
  let value = operation();
  for (let sample = 0; sample < SAMPLE_COUNT + 2; sample += 1) {
    const startedAt = performance.now();
    value = operation();
    const elapsed = performance.now() - startedAt;
    if (sample >= 2) {
      durations.push(elapsed);
    }
  }
  const sorted = durations.toSorted((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median === undefined) {
    throw new Error("Syntax benchmark produced no samples.");
  }
  return { medianMilliseconds: roundMilliseconds(median), value };
}

function roundMilliseconds(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
