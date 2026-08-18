export function normalizeMarkdownSource(source: string): string {
  const firstCodeUnit = source.charCodeAt(0);
  return (firstCodeUnit >= 0x200b && firstCodeUnit <= 0x200f) || firstCodeUnit === 0xfeff
    ? source.slice(1)
    : source;
}
