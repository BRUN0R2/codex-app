import type { DiffDocument } from "../diffDocument";
import { DIFF_SYNTAX_LIMITS, type SyntaxLine } from "./contracts";
import { syntaxLanguageFromPath } from "./languages";
import { prepareSyntaxLineTokenization, type SyntaxLineTokenizer } from "./tokenizer";

const MAX_CACHE_ENTRIES = 64;
const MAX_CACHE_ESTIMATED_BYTES = 4 * 1_024 * 1_024;
const MAX_PATHS_PER_DOCUMENT = 4;
const TOKEN_ESTIMATED_BYTES = 32;

interface CachedHunk {
  estimatedBytes: number;
  readonly lines: SyntaxLine[] | null;
  readonly sourceLines: readonly string[] | null;
  readonly tokenizer: SyntaxLineTokenizer | null;
}

interface CachedDocumentPath {
  readonly entries: Map<number, CachedHunk>;
  estimatedBytes: number;
}

const sharedDocuments = new WeakMap<DiffDocument, Map<string, CachedDocumentPath>>();

export class DiffSyntaxHighlighter {
  render(document: DiffDocument, path: string, sourceIndex: number | null): SyntaxLine | null {
    if (sourceIndex === null) {
      return null;
    }
    const language = syntaxLanguageFromPath(path);
    if (language === "plainText") {
      return null;
    }
    const location = document.syntaxLocation(sourceIndex);
    if (location === null) {
      return null;
    }
    const cache = readDocumentPathCache(document, path);
    const cached = cache.entries.get(location.hunkIndex);
    if (cached !== undefined) {
      cache.entries.delete(location.hunkIndex);
      cache.entries.set(location.hunkIndex, cached);
      return readCachedLine(cache, location.hunkIndex, cached, location.lineIndex);
    }
    const hunk = document.syntaxHunks[location.hunkIndex];
    if (hunk === undefined) {
      throw new Error(`Diff syntax hunk ${location.hunkIndex} does not exist.`);
    }
    if (hunk.lines === null) {
      storeHunk(cache, location.hunkIndex, {
        estimatedBytes: 1,
        lines: null,
        sourceLines: null,
        tokenizer: null,
      });
      return null;
    }
    const plan = prepareSyntaxLineTokenization(hunk.lines, language, DIFF_SYNTAX_LIMITS);
    const entry: CachedHunk =
      plan.kind === "plain"
        ? { estimatedBytes: 1, lines: null, sourceLines: null, tokenizer: null }
        : {
            estimatedBytes: 1,
            lines: [],
            sourceLines: hunk.lines,
            tokenizer: plan.tokenizer,
          };
    storeHunk(cache, location.hunkIndex, entry);
    return readCachedLine(cache, location.hunkIndex, entry, location.lineIndex);
  }
}

function readDocumentPathCache(document: DiffDocument, path: string): CachedDocumentPath {
  let paths = sharedDocuments.get(document);
  if (paths === undefined) {
    paths = new Map();
    sharedDocuments.set(document, paths);
  }
  let cache = paths.get(path);
  if (cache === undefined) {
    cache = { entries: new Map(), estimatedBytes: 0 };
    paths.set(path, cache);
    while (paths.size > MAX_PATHS_PER_DOCUMENT) {
      const oldestPath = paths.keys().next().value;
      if (oldestPath === undefined) {
        throw new Error("A cache sintática perdeu o caminho candidato à expulsão.");
      }
      paths.delete(oldestPath);
    }
    return cache;
  }
  paths.delete(path);
  paths.set(path, cache);
  return cache;
}

function storeHunk(cache: CachedDocumentPath, hunkIndex: number, entry: CachedHunk): void {
  while (
    cache.entries.size >= MAX_CACHE_ENTRIES ||
    (cache.entries.size > 0 &&
      cache.estimatedBytes + entry.estimatedBytes > MAX_CACHE_ESTIMATED_BYTES)
  ) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined) {
      throw new Error("A cache sintática perdeu o hunk candidato à expulsão.");
    }
    const removed = cache.entries.get(oldest);
    cache.entries.delete(oldest);
    cache.estimatedBytes -= removed?.estimatedBytes ?? 0;
  }
  cache.entries.set(hunkIndex, entry);
  cache.estimatedBytes += entry.estimatedBytes;
}

function readCachedLine(
  cache: CachedDocumentPath,
  hunkIndex: number,
  entry: CachedHunk,
  lineIndex: number,
): SyntaxLine | null {
  if (entry.lines === null || entry.sourceLines === null || entry.tokenizer === null) {
    return null;
  }
  while (entry.lines.length <= lineIndex) {
    const sourceLine = entry.sourceLines[entry.lines.length];
    if (sourceLine === undefined) {
      throw new Error(`Diff syntax line ${entry.lines.length} does not exist.`);
    }
    const line = entry.tokenizer.tokenize(sourceLine);
    entry.lines.push(line);
    const addedBytes = sourceLine.length + line.length * TOKEN_ESTIMATED_BYTES;
    entry.estimatedBytes += addedBytes;
    cache.estimatedBytes += addedBytes;
    trimCache(cache, hunkIndex);
  }
  return entry.lines[lineIndex] ?? null;
}

function trimCache(cache: CachedDocumentPath, protectedHunkIndex: number): void {
  while (cache.entries.size > 1 && cache.estimatedBytes > MAX_CACHE_ESTIMATED_BYTES) {
    const oldest = cache.entries.keys().next().value;
    if (oldest === undefined || oldest === protectedHunkIndex) {
      throw new Error("A cache sintática perdeu a ordem de recência dos hunks.");
    }
    const removed = cache.entries.get(oldest);
    cache.entries.delete(oldest);
    cache.estimatedBytes -= removed?.estimatedBytes ?? 0;
  }
}
