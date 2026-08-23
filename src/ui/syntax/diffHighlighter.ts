import type { DiffDocument } from "../diffDocument";
import { DIFF_SYNTAX_LIMITS, type SyntaxBlock, type SyntaxLine } from "./contracts";
import { syntaxLanguageFromPath } from "./languages";
import { tokenizeSyntaxLines } from "./tokenizer";

const MAX_CACHE_ENTRIES = 64;
const MAX_CACHE_ESTIMATED_BYTES = 4 * 1_024 * 1_024;
const TOKEN_ESTIMATED_BYTES = 32;

interface CachedHunk {
  readonly estimatedBytes: number;
  readonly lines: SyntaxBlock | null;
}

export class DiffSyntaxHighlighter {
  readonly #entries = new Map<number, CachedHunk>();
  #document: DiffDocument | undefined;
  #estimatedBytes = 0;
  #path = "";

  render(document: DiffDocument, path: string, sourceIndex: number | null): SyntaxLine | null {
    if (sourceIndex === null) {
      return null;
    }
    this.#resetIfSourceChanged(document, path);
    const language = syntaxLanguageFromPath(path);
    if (language === "plainText") {
      return null;
    }
    const location = document.syntaxLocation(sourceIndex);
    if (location === null) {
      return null;
    }
    const cached = this.#entries.get(location.hunkIndex);
    if (cached !== undefined) {
      this.#entries.delete(location.hunkIndex);
      this.#entries.set(location.hunkIndex, cached);
      return cached.lines?.[location.lineIndex] ?? null;
    }

    const hunk = document.syntaxHunks[location.hunkIndex];
    if (hunk === undefined) {
      throw new Error(`Diff syntax hunk ${location.hunkIndex} does not exist.`);
    }
    if (hunk.lines === null) {
      this.#store(location.hunkIndex, { estimatedBytes: 1, lines: null });
      return null;
    }
    const tokenization = tokenizeSyntaxLines(hunk.lines, language, DIFF_SYNTAX_LIMITS);
    const lines = tokenization.kind === "highlighted" ? tokenization.lines : null;
    this.#store(location.hunkIndex, {
      estimatedBytes:
        lines === null ? 1 : hunk.characterLength + countTokens(lines) * TOKEN_ESTIMATED_BYTES,
      lines,
    });
    return lines?.[location.lineIndex] ?? null;
  }

  clear(): void {
    this.#document = undefined;
    this.#entries.clear();
    this.#estimatedBytes = 0;
    this.#path = "";
  }

  #resetIfSourceChanged(document: DiffDocument, path: string): void {
    if (this.#document === document && this.#path === path) {
      return;
    }
    this.clear();
    this.#document = document;
    this.#path = path;
  }

  #store(hunkIndex: number, entry: CachedHunk): void {
    while (
      this.#entries.size >= MAX_CACHE_ENTRIES ||
      (this.#entries.size > 0 &&
        this.#estimatedBytes + entry.estimatedBytes > MAX_CACHE_ESTIMATED_BYTES)
    ) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      const removed = this.#entries.get(oldest);
      this.#entries.delete(oldest);
      this.#estimatedBytes -= removed?.estimatedBytes ?? 0;
    }
    this.#entries.set(hunkIndex, entry);
    this.#estimatedBytes += entry.estimatedBytes;
  }
}

function countTokens(block: SyntaxBlock): number {
  let count = 0;
  for (const line of block) {
    count += line.length;
  }
  return count;
}
