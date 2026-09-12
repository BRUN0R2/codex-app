const FORBIDDEN_BOUNDARIES = ["infrastructure/", "@tauri-apps/"] as const;

const IMPORT_PATTERNS = [
  /(?:from\s+|import\s*\()\s*["']([^"']+)["']/gu,
  /^\s*import\s*(?:type\s*)?["']([^"']+)["']/gmu,
] as const;

export function hasForbiddenPresentationImport(source: string): boolean {
  return IMPORT_PATTERNS.some((pattern) => {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (
        specifier !== undefined &&
        FORBIDDEN_BOUNDARIES.some((boundary) => specifier.includes(boundary))
      ) {
        return true;
      }
    }
    return false;
  });
}
